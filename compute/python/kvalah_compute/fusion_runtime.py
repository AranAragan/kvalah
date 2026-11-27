"""Production sidecar expert operations with strict checkpoint and supervision boundaries."""

import json
import math
import os
import re
import time
from pathlib import Path

import numpy as np
from safetensors.numpy import save_file

from .canonical import sha256_file
from .errors import SidecarError
from .sft import check_row


_resident=None
_key=re.compile(r"^[a-z][a-z0-9_]{0,47}$")


def release():
    global _resident
    if _resident is not None:
        backend=_resident[1]
        _resident=None
        backend.release()


def checked_path(path):
    if not isinstance(path,str) or not os.path.isabs(path):
        raise SidecarError("INVALID_SCHEMA","Fusion paths must be absolute")
    return Path(path)


def schema_for(spec,width,layers):
    if not _key.fullmatch(spec.get("key","")) or spec.get("kind") not in ("lora","ffa-lora","ffn"):
        raise SidecarError("INVALID_SCHEMA","invalid Fusion expert identity")
    placed=spec.get("layers",[])
    if not placed or len(set(placed))!=len(placed) or any(type(i)!=int or i<0 or i>=layers for i in placed):
        raise SidecarError("INVALID_SCHEMA","invalid Fusion layer placement")
    schema={}
    if spec["kind"]=="ffn":
        inner=spec.get("intermediate")
        if type(inner)!=int or not 1<=inner<=32768 or spec.get("training_mode","full") not in ("full","down"):
            raise SidecarError("INVALID_SCHEMA","invalid FFN configuration")
        for i in placed:
            stem=f"layers.{i}.fusion."
            schema[stem+"gate.weight"]=((inner,width),spec.get("training_mode","full")=="full")
            schema[stem+"up.weight"]=((inner,width),spec.get("training_mode","full")=="full")
            schema[stem+"down.weight"]=((width,inner),True)
    else:
        rank,alpha=spec.get("rank"),spec.get("alpha")
        if type(rank)!=int or not 1<=rank<=min(width,512) or not isinstance(alpha,(int,float)) or not math.isfinite(alpha) or not 0<alpha<=1024:
            raise SidecarError("INVALID_SCHEMA","invalid adapter dimensions")
        for i in placed:
            stem=f"layers.{i}.fusion."
            schema[stem+"A"]=((rank,width),spec["kind"]=="lora")
            schema[stem+"B"]=((width,rank),True)
    return schema


def inspect_checkpoint(file,expected_hash,schema):
    from safetensors import safe_open
    if not isinstance(expected_hash,str) or not re.fullmatch(r"[a-f0-9]{64}",expected_hash) or file.is_symlink():
        raise SidecarError("INVALID_SCHEMA","invalid Fusion checkpoint reference")
    raw_bytes=sum(math.prod(shape)*4 for shape,_ in schema.values())
    if file.stat().st_size>raw_bytes+(1<<20) or sha256_file(file)!=expected_hash:
        raise SidecarError("HASH_MISMATCH","Fusion checkpoint differs from its verified digest")
    with safe_open(file,framework="numpy") as archive:
        if set(archive.keys())!=set(schema):
            raise SidecarError("INVALID_TENSOR","Fusion tensor keys do not match the expert schema")
        for key,(shape,_) in schema.items():
            actual=archive.get_slice(key)
            if tuple(actual.get_shape())!=shape or actual.get_dtype()!="F32":
                raise SidecarError("INVALID_TENSOR","incompatible Fusion tensor shape or dtype")


def read_rows(file,digest,max_length,vocab,split):
    if file.is_symlink() or file.stat().st_size>16*1024**2 or sha256_file(file)!=digest:
        raise SidecarError("HASH_MISMATCH","Fusion data shard differs from its digest")
    with file.open(encoding="utf-8") as stream:
        data=json.load(stream)
    if data.get("split")!=split or not isinstance(data.get("rows"),list) or not data["rows"]:
        raise SidecarError("DATASET_INVALID","incorrect Fusion dataset split")
    for row in data["rows"]:
        check_row(row,max_length)
        if any(type(v)!=int or v<0 or v>=vocab for v in row["input_ids"]) or any(type(m) not in (int,bool) or m not in (0,1) for m in row["target_mask"]):
            raise SidecarError("DATASET_INVALID","invalid token or target mask")
    return data["rows"]


def _training(spec):
    steps=spec.get("local_steps")
    accum=spec.get("grad_accum")
    lr=spec.get("lr")
    clip=spec.get("clip")
    if type(steps)!=int or not 1<=steps<=10000 or type(accum)!=int or not 1<=accum<=128 or not isinstance(lr,(int,float)) or not 0<lr<=1 or not isinstance(clip,(int,float)) or not 0<clip<=100 or spec.get("optimizer") not in ("sgd","adamw"):
        raise SidecarError("INVALID_SCHEMA","invalid Fusion optimizer or step budget")
    return steps,accum


class TorchFusion:
    def __init__(self,model_dir,digest,device):
        from .fusion_ministral import attach_to_mistral, load_verified_model
        self.device=device
        if device=="cuda":
            self.model,self.layers=load_verified_model(model_dir,digest)
        else:
            from transformers import AutoModelForCausalLM
            self.model=AutoModelForCausalLM.from_pretrained(model_dir,local_files_only=True,use_safetensors=True,trust_remote_code=False)
            self.layers=attach_to_mistral(self.model)
        cfg=getattr(self.model.config,"text_config",self.model.config)
        self.width,self.vocab=cfg.hidden_size,cfg.vocab_size

    def empty_expert(self):
        for slot in self.layers.values():
            slot.experts.clear()
            slot.router.rows.clear()

    def install(self,spec,file,schema,*,append=False):
        import torch
        from safetensors import safe_open
        from .fusion_ministral import insert_expert
        if not append:self.empty_expert()
        modules=insert_expert(self.layers,name=spec["key"],kind=spec["kind"],layers=spec["layers"],rank=spec.get("rank"),
                              alpha=spec.get("alpha"),intermediate=spec.get("intermediate"))
        self.parts={f"layers.{i}.fusion.{key}":p for i,m in modules.items() for key,p in m.named_parameters()}
        if set(self.parts)!=set(schema):
            raise SidecarError("ARCHITECTURE","Fusion layers do not match the planned tensor layout")
        self.model.requires_grad_(False)
        with safe_open(file,framework="numpy") as archive, torch.no_grad():
            for key,p in self.parts.items():
                data=archive.get_tensor(key)
                if not np.isfinite(data).all():
                    raise SidecarError("NONFINITE","non-finite checkpoint tensor")
                p.copy_(torch.from_numpy(data.copy()))
                p.requires_grad_(schema[key][1])
        self.trainable=[p for p in self.parts.values() if p.requires_grad]
        self.schema=schema

    def optimizer(self,cfg):
        import torch
        self.model.train()
        self.opt={"adamw":torch.optim.AdamW,"sgd":torch.optim.SGD}[cfg["optimizer"]](self.trainable,lr=cfg["lr"])
        self.clip=cfg["clip"]

    def objective(self,row):
        import torch
        dev=next(self.model.parameters()).device
        x=torch.tensor([row["input_ids"]],device=dev)
        mask=torch.tensor(row["target_mask"][1:],dtype=torch.bool,device=dev)
        out=self.model(input_ids=x,use_cache=False).logits[0,:-1][mask].float()
        target=x[0,1:][mask]
        return torch.nn.functional.cross_entropy(out,target,reduction="sum"),out,target

    def step(self,rows):
        import torch
        total=sum(check_row(row,len(row["input_ids"])) for row in rows)
        self.opt.zero_grad(set_to_none=True)
        nll=0.0
        for row in rows:
            loss,_,_=self.objective(row)
            if not torch.isfinite(loss):
                raise SidecarError("NONFINITE","invalid Fusion loss")
            (loss/total).backward()
            nll+=float(loss.detach())
        torch.nn.utils.clip_grad_norm_(self.trainable,self.clip,error_if_nonfinite=True)
        self.opt.step()
        if not all(torch.isfinite(p).all() for p in self.trainable):
            raise SidecarError("NONFINITE","invalid Fusion optimizer result")
        if self.device=="cuda":torch.cuda.synchronize()
        return nll,total

    def evaluate(self,rows):
        import torch
        self.model.eval()
        nll,count,correct=0.0,0,0
        with torch.no_grad():
            for row in rows:
                loss,pred,target=self.objective(row)
                nll+=float(loss);count+=target.numel();correct+=int((pred.argmax(-1)==target).sum())
        return {"nll_sum":nll,"tokens":count,"correct":correct}

    def arrays(self):
        return {k:p.detach().cpu().numpy().astype(np.float32,copy=False) for k,p in self.parts.items()}

    def clear(self):
        self.opt=None
        self.parts={}
        self.trainable=[]
        self.empty_expert()

    def metrics(self):
        if self.device!="cuda":return {}
        import torch
        return {"peak_reserved_bytes":torch.cuda.max_memory_reserved(),"peak_allocated_bytes":torch.cuda.max_memory_allocated()}

    def release(self):
        self.clear()
        self.layers={}
        self.model=None
        if self.device=="cuda":
            import gc,torch
            gc.collect();torch.cuda.empty_cache()


def acquire(msg,permit,emit):
    global _resident
    from .sidecar import verify_model
    cid=msg["id"]
    paths=msg["paths"]
    mode=msg.get("backend")
    if mode not in ("cuda","mlx") and not (mode=="torch-cpu-test" and os.getenv("KVALAH_COMPUTE_TEST")=="1"):
        raise SidecarError("INVALID_SCHEMA","unsupported Fusion backend")
    model=checked_path(paths["model_dir"])
    signature=(mode,str(model.resolve()),msg["model_files_digest"])
    permit(cid,0)
    warm=_resident is not None and _resident[0]==signature
    t0=time.perf_counter()
    if not warm:
        release()
        manifest=verify_model({"model_dir":str(model)})
        if manifest["files_digest"]!=msg["model_files_digest"]:
            raise SidecarError("MODEL_UNVERIFIED","Fusion model digest mismatch")
        if mode=="mlx":
            from .fusion_mlx import MLXFusion
            backend=MLXFusion(model)
        else:
            backend=TorchFusion(model,msg["model_files_digest"],"cuda" if mode=="cuda" else "cpu")
        _resident=(signature,backend)
    backend=_resident[1]
    emit({"type":"loaded","id":cid,"cache_hit":warm,"model_load_s":(time.perf_counter()-t0)})
    return backend,warm


def run(msg,*,permit,emit,evaluation=False):
    cid=msg["id"]
    paths=msg["paths"]
    backend,warm=acquire(msg,permit,emit)
    spec=msg["expert"]
    schema=schema_for(spec,backend.width,len(backend.layers))
    src=checked_path(paths["checkpoint"])
    inspect_checkpoint(src,msg["checkpoint_sha256"],schema)
    split="validation" if evaluation else "train"
    rows=read_rows(checked_path(paths["rows"]),msg["rows_sha256"],msg["max_length"],backend.vocab,split)
    backend.install(spec,src,schema)
    try:
        if evaluation:
            baseline={"nll_sum":0.0,"tokens":0,"correct":0}
            candidate=baseline.copy()
            for i,row in enumerate(rows,1):
                permit(cid,i)
                result=backend.evaluate([row])
                for key,value in result.items():candidate[key]+=value
            backend.clear()
            for i,row in enumerate(rows,len(rows)+1):
                permit(cid,i)
                result=backend.evaluate([row])
                for key,value in result.items():baseline[key]+=value
            return {"control":baseline,"candidate":candidate,"model_cache_hit":warm}
        steps,accum=_training(msg["training"])
        if len(rows)!=steps*accum:
            raise SidecarError("TOKEN_MISMATCH","Fusion job Train rows do not match the training schedule")
        tokens=sum(check_row(row,msg["max_length"]) for row in rows)
        if tokens!=msg["expected_supervised_tokens"]:
            raise SidecarError("TOKEN_MISMATCH","Fusion job token count does not match the assignment")
        backend.optimizer(msg["training"])
        seen=0
        for step in range(steps):
            permit(cid,step+1)
            start=time.perf_counter()
            nll,n=backend.step(rows[step*accum:(step+1)*accum]);seen+=n
            emit({"type":"step","id":cid,"step":step+1,"loss":nll/n,"supervised_tokens":n,"supervised_tokens_total":seen,
                  "compute_ms":(time.perf_counter()-start)*1000,**backend.metrics()})
        arrays=backend.arrays()
        from safetensors import safe_open
        with safe_open(src,framework="numpy") as parent:
            if any(not np.array_equal(arrays[k],parent.get_tensor(k)) for k,(_,trainable) in schema.items() if not trainable):
                raise SidecarError("FROZEN_A_CHANGED","a frozen Fusion tensor was modified")
        out=checked_path(paths["result"])
        tmp=out.with_suffix(".partial")
        save_file({k:np.ascontiguousarray(arrays[k]) for k,(_,active) in schema.items() if active},tmp)
        with tmp.open("rb+") as stream:os.fsync(stream.fileno())
        os.replace(tmp,out)
        return {"supervised_tokens":seen,"steps":steps,"update_path":str(out),"sha256":sha256_file(out),"frozen_unchanged":True,
                "model_cache_hit":warm,**backend.metrics()}
    finally:
        backend.clear()
        if not msg.get("retain_model",False):release()
