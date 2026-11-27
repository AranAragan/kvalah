"""Reference pipeline over bounded subprocess pipes with an atomic global step boundary."""

import json
import os
import subprocess
import sys
import tempfile
from contextlib import ExitStack,suppress
from pathlib import Path
from threading import Timer

import torch
from safetensors.torch import load, save
from torch import nn
from torch.utils.checkpoint import checkpoint

from .fusion import FFN


MAX_FRAME = 8 * 1024 * 1024
MAX_INFLIGHT = 4


def send(stream, meta, tensors=None):
    metadata = json.dumps(meta, separators=(",", ":"), allow_nan=False).encode()
    payload = save({k:v.detach().cpu().contiguous() for k,v in tensors.items()}) if tensors else b""
    if len(metadata) > 4096 or len(payload) > MAX_FRAME:
        raise ValueError("pipeline frame exceeds limit")
    stream.write(len(metadata).to_bytes(4,"little"))
    stream.write(len(payload).to_bytes(4,"little"))
    stream.write(metadata)
    stream.write(payload)
    stream.flush()


def receive(stream):
    sizes = stream.read(8)
    if len(sizes)!=8:
        raise EOFError("stage closed its stream")
    meta_size = int.from_bytes(sizes[:4],"little")
    data_size = int.from_bytes(sizes[4:],"little")
    if not 0<meta_size<=4096 or not 0<=data_size<=MAX_FRAME:
        raise ValueError("invalid pipeline frame lengths")
    meta, data = stream.read(meta_size), stream.read(data_size)
    if len(meta)!=meta_size or len(data)!=data_size:
        raise EOFError("short stage frame")
    tensors=load(data) if data else {}
    if any(v.dtype!=torch.float32 or not torch.isfinite(v).all() for v in tensors.values()):
        raise ValueError("invalid pipeline tensor input")
    return json.loads(meta), tensors


class Stage(nn.Module):
    def __init__(self, width, blocks):
        super().__init__()
        if not 1<=width<=256 or not 1<=len(blocks)<=26:
            raise ValueError("invalid reference stage dimension")
        self.blocks=nn.ModuleList()
        for size, frozen in blocks:
            if not 1<=size<=1024 or not isinstance(frozen,bool):
                raise ValueError("invalid FFN pipeline block")
            self.blocks.append(FFN(width,size).requires_grad_(not frozen))

    def forward(self,state):
        for block in self.blocks:
            state=state+block(state)
        return state


def serve_stage(instream, outstream):
    torch.set_num_threads(1)
    meta, tensors = receive(instream)
    if meta["op"] != "init" or meta["device"] not in ("cpu","cuda"):
        raise ValueError("stage initialization required")
    epoch = meta["epoch"]
    model = Stage(meta["width"],meta["blocks"]).to(meta["device"])
    model.load_state_dict(tensors)
    device = next(model.parameters()).device
    graphs={}
    send(outstream,{"ready":True,"epoch":epoch})
    while True:
        meta,tensors=receive(instream)
        if meta["epoch"]!=epoch:
            raise ValueError("pipeline version mismatch")
        op=meta["op"]
        if op=="close":
            return
        if op=="heartbeat":
            send(outstream,{"epoch":epoch,"inflight":len(graphs)})
            continue
        if op=="forward":
            key=meta["id"]
            if len(graphs)>=MAX_INFLIGHT or key in graphs:
                raise ValueError("pipeline in-flight limit or duplicate ID")
            source=tensors["activation"].to(device).requires_grad_(True)
            result=checkpoint(model,source,use_reentrant=False)
            graphs[key]=(source,result)
            send(outstream,{"epoch":epoch},{"activation":result})
        elif op=="backward":
            source,result=graphs.pop(meta["id"])
            result.backward(tensors["gradient"].to(device))
            send(outstream,{"epoch":epoch},{"gradient":source.grad})
        elif op=="gradients" and not graphs:
            parameters={k:p.grad for k,p in model.named_parameters() if p.requires_grad}
            if any(value is None for value in parameters.values()):
                raise ValueError("stage did not produce all parameter gradients")
            send(outstream,{"epoch":epoch},parameters)
        else:
            raise ValueError("invalid pipeline command or unfinished microbatches")


class StageProcess:
    def __init__(self, width, blocks, tensors, epoch, device):
        self.epoch=epoch
        self.process=subprocess.Popen([sys.executable,"-m","kvalah_compute.fusion_pipeline","--stage"],stdin=subprocess.PIPE,
                                      stdout=subprocess.PIPE,creationflags=getattr(subprocess,"CREATE_NO_WINDOW",0))
        try:
            if not self.rpc("init",tensors,width=width,blocks=blocks,device=device)[0]["ready"]:
                raise RuntimeError("stage did not become ready")
        except BaseException:
            self.close()
            raise

    def rpc(self, name, tensors=None, **fields):
        watchdog=Timer(30,self.process.kill)
        watchdog.daemon=True
        watchdog.start()
        try:
            send(self.process.stdin,{"op":name,"epoch":self.epoch,**fields},tensors)
            header, result = receive(self.process.stdout)
        finally:
            watchdog.cancel()
        if header["epoch"]!=self.epoch:
            raise ValueError("unexpected pipeline stage version")
        return header,result

    def close(self):
        try:
            if self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=5)
        finally:
            with suppress(OSError):
                self.process.stdin.close()
            with suppress(OSError):
                self.process.stdout.close()


def commit_snapshot(file, tensors):
    file=Path(file)
    file.parent.mkdir(parents=True,exist_ok=True)
    fd,temp=tempfile.mkstemp(dir=file.parent,prefix=".pipeline-")
    try:
        with os.fdopen(fd,"wb") as stream:
            stream.write(save(tensors))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp,file)
    finally:
        Path(temp).unlink(missing_ok=True)


def pipeline_step(width, stages, incoming, expected, checkpoints, *, epoch, lr, destination, devices=None, failure_hook=None):
    """Execute one SGD step. Repeat from the old checkpoint if a subprocess fails."""
    if not 1<=len(incoming)<=MAX_INFLIGHT or len(incoming)!=len(expected) or not 1<=len(stages)<=8 or len(stages)!=len(checkpoints) or not 0<lr<=1:
        raise ValueError("invalid microbatch count or stage topology")
    devices=devices or ["cpu"]*len(stages)
    total=sum(t.numel() for t in expected)
    if not total or len(devices)!=len(stages):
        raise ValueError("invalid pipeline target or device list")
    losses=[]
    with ExitStack() as cleanup:
        processes=[]
        for blocks, weights, device in zip(stages,checkpoints,devices,strict=True):
            stage=StageProcess(width,blocks,weights,epoch,device)
            cleanup.callback(stage.close)
            processes.append(stage)
        outputs=[]
        for number,activation in enumerate(incoming):
            for stage in processes:
                _,packet=stage.rpc("forward",{"activation":activation},id=number)
                activation=packet["activation"]
            outputs.append(activation)
        if failure_hook is not None:
            failure_hook(processes)
        for number,(activation,target) in enumerate(zip(outputs,expected,strict=True)):
            if activation.shape!=target.shape:
                raise ValueError("pipeline loss shape mismatch")
            residual=activation-target
            losses.append(float(residual.square().sum()/total))
            gradient=2*residual/total
            for stage in reversed(processes):
                _,packet=stage.rpc("backward",{"gradient":gradient},id=number)
                gradient=packet["gradient"]
        gradients=[stage.rpc("gradients")[1] for stage in processes]
    result={}
    for i,(weights,gradient,blocks) in enumerate(zip(checkpoints,gradients,stages,strict=True)):
        allowed={k for k,p in Stage(width,blocks).named_parameters() if p.requires_grad}
        if set(gradient)!=allowed:
            raise ValueError("stage gradient schema mismatch")
        for k,value in weights.items():
            delta=gradient.get(k)
            if delta is not None and (delta.shape!=value.shape or delta.dtype!=value.dtype):
                raise ValueError("stage returned an incompatible gradient")
            result[f"{i}.{k}"]=value.detach().clone() if delta is None else value-lr*delta
    if not all(torch.isfinite(v).all() for v in result.values()):
        raise ValueError("invalid pipeline optimizer step")
    commit_snapshot(destination,result)
    return {"loss":sum(losses),"gradients":gradients,"weights":result}


if __name__=="__main__" and sys.argv[1:]==["--stage"]:
    serve_stage(sys.stdin.buffer,sys.stdout.buffer)
