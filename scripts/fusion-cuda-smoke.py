"""Attended, read-only R60-input smoke using the Fusion CUDA NF4 sidecar operations."""

import argparse
import json
import os
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
import psutil
from safetensors.numpy import load_file,save_file

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"compute"/"python"))
from kvalah_compute import fusion_runtime,sidecar
from kvalah_compute import fusion_composed
from kvalah_compute.canonical import sha256_file
from kvalah_compute.fusion_ministral import loop_text_layers


def guard(coordinator_db,cold=False):
    battery=psutil.sensors_battery()
    if (battery and not battery.power_plugged) or psutil.virtual_memory().available<2*1024**3:
        raise RuntimeError("AC power and 2 GiB available system RAM are required")
    with sqlite3.connect(coordinator_db.resolve().as_uri()+"?mode=ro",uri=True) as db:
        if db.execute("SELECT count(*) FROM experiments WHERE state='RUNNING'").fetchone()[0] or db.execute(
                "SELECT count(*) FROM tasks WHERE state='leased' AND lease_expires_at>?",(int(time.time()*1000),)).fetchone()[0]:
            raise RuntimeError("The coordinator has active Compute work")
    for process in psutil.process_iter(["name"]):
        name=(process.info["name"] or "").lower().removesuffix(".exe")
        if name in ("llama-server","ollama","ollama_llama_server"):
            raise RuntimeError("An inference runtime is running")
        if name=="ggml-rpc-server" and any(c.status=="ESTABLISHED" for c in process.net_connections(kind="tcp")):
            raise RuntimeError("An inference worker has an active connection")
    capacity,temperature,util=map(int,subprocess.check_output(["nvidia-smi","--query-gpu=memory.free,temperature.gpu,utilization.gpu",
        "--format=csv,noheader,nounits"],text=True).splitlines()[0].split(","))
    if capacity<(4096 if cold else 1280) or temperature>=80 or cold and util>=15:
        raise RuntimeError(f"GPU admission denied ({capacity} MiB free, {temperature} C, {util}% utilization)")
    return {"free_mib":capacity,"temperature_c":temperature,"utilization_pct":util}


def input_row(archive):
    frozen=archive/"research"
    snapshot=json.loads((frozen/"snapshot.json").read_bytes())
    digest,=[v["files_digest"] for v in snapshot["model_snapshot"] if v["variant_id"]=="cuda-nf4"]
    assignments=json.loads((frozen/"assignments.json").read_bytes())
    picked=next(a for a in assignments if a["round_attempt"]==1)
    path=archive/"cas"/picked["rows_sha"]
    if sha256_file(path)!=picked["rows_sha"]:
        raise RuntimeError("archived Train shard digest mismatch")
    return digest,json.loads(path.read_bytes())["rows"][0]


def composition_trial(args):
    import torch

    digest,_=input_row(args.archive)
    assignments=json.loads((args.archive/"research"/"assignments.json").read_bytes())
    context=128
    held=[]
    seen=set()
    for assignment in assignments:
        path=args.archive/"cas"/assignment["rows_sha"]
        if sha256_file(path)!=assignment["rows_sha"]:
            raise RuntimeError("archived Train shard digest mismatch")
        for row in json.loads(path.read_bytes())["rows"]:
            key=tuple(row["input_ids"])
            if len(key)<=context and key not in seen:
                seen.add(key)
                held.append(row)
        if len(held)>=20:break
    if len(held)<20:raise RuntimeError("need twenty distinct archived Train rows")
    rng=np.random.default_rng(934)
    base={"backend":"cuda","model_files_digest":digest,"max_length":context,"paths":{"model_dir":str(args.model.resolve())}}
    emit=lambda _event:None

    def cold_guard():
        for attempt in range(12):
            try:return guard(args.coordinator_db,cold=True)
            except RuntimeError as error:
                if not str(error).startswith("GPU admission denied") or attempt==11:raise
                time.sleep(1)

    def permit(_id,step):
        if step==0:return cold_guard()
        if step and torch.cuda.is_initialized() and torch.cuda.mem_get_info()[0]<1280*1024**2:
            torch.cuda.empty_cache()
        guard(args.coordinator_db)

    guarded=cold_guard()
    with TemporaryDirectory(prefix="kvalah-fusion-compose-nf4-") as temp,args.out.open("x",encoding="utf-8") as output:
        folder=Path(temp)

        def record(stage,result,started):
            out={"classification":"MEASURED","backend":"cuda-nf4","model_files_digest":digest,"stage":stage,"max_length":context,
                 "initial_telemetry":guarded,"wall_s":time.perf_counter()-started,**result}
            output.write(json.dumps(out)+"\n")
            output.flush()

        experts=[]
        shared=folder/"integration-train.json"
        shared.write_text(json.dumps({"split":"train","rows":held[15:20]}),encoding="utf-8")
        for index,kind in enumerate(("ffa-lora","lora","ffn")):
            spec={"key":kind.replace("-","_"),"kind":kind,"layers":[0],"rank":8,"alpha":16,"intermediate":128}
            layout=fusion_runtime.schema_for(spec,3072,26)
            initial={key:(np.zeros(shape,dtype=np.float32) if key.endswith((".B",".down.weight")) else
                     rng.uniform(-.01,.01,shape).astype(np.float32)) for key,(shape,_) in layout.items()}
            batch=held[index*5:index*5+5]
            train,ck,updated,full=[folder/f"{kind}.{extension}" for extension in ("json","safetensors","update","full")]
            train.write_text(json.dumps({"split":"train","rows":batch}),encoding="utf-8")
            save_file(initial,ck)
            started=time.perf_counter()
            result=fusion_runtime.run({**base,"id":kind,"expert":spec,"checkpoint_sha256":sha256_file(ck),"rows_sha256":sha256_file(train),
                "expected_supervised_tokens":sum(sum(r["target_mask"][1:]) for r in batch),"retain_model":True,
                "training":{"optimizer":"sgd","lr":.01,"local_steps":5,"grad_accum":1,"clip":1},
                "paths":{**base["paths"],"checkpoint":str(ck),"rows":str(train),"result":str(updated)}},
                permit=lambda name,step:guard(args.coordinator_db) if step==0 and index else permit(name,step),emit=emit)
            result.pop("update_path")
            record(kind,result,started)
            save_file({**initial,**load_file(updated)},full)
            experts.append({"spec":spec,"checkpoint":str(full),"sha256":sha256_file(full),"train":str(shared),"train_sha256":sha256_file(shared)})
        fusion_runtime.release()
        shared_args={**base,"experts":experts,"steps":5,"lr":.005,"router":{"mode":"token","top_k":1},"loop":{"start":0,"end":2,"passes":2}}
        for stage in ("router","loop"):
            artifact=folder/f"{stage}.safetensors"
            started=time.perf_counter()
            result=fusion_composed.run({**shared_args,"id":stage,"stage":stage,"output":str(artifact)},fit=True,permit=permit,emit=emit)
            record(stage,result,started)
            shared_args[f"{stage}_weights"]={"file":str(artifact),"sha256":result["sha256"]}
            shared_args[stage]={**shared_args[stage],"sha256":result["sha256"]}
        started=time.perf_counter()
        prompt="Explain what a checksum is in one sentence."
        options={**shared_args,"id":"cached-reload","prompt":prompt,"max_new_tokens":8}
        cached=fusion_composed.run(options,infer=True,permit=permit,emit=emit)
        uncached=fusion_composed.run({**options,"id":"uncached-reload","use_cache":False},infer=True,permit=permit,emit=emit)
        if not cached["generated_tokens"] or any(cached[k]!=uncached[k] for k in ("generated_tokens","text")):
            raise RuntimeError("cached generation differs from uncached after reloading trained parameters")
        torch.cuda.synchronize()
        record("reload-cache-parity",{"cached":cached,"uncached":uncached,"router_sha256":shared_args["router"]["sha256"],
            "loop_sha256":shared_args["loop"]["sha256"]},started)


def main(args):
    if args.composition_trial:return composition_trial(args)
    digest,row=input_row(args.archive)
    os.environ.setdefault("KVALAH_SIDECAR_THREADS","1")
    guarded=guard(args.coordinator_db,cold=True)
    with TemporaryDirectory(prefix="kvalah-fusion-nf4-") as temp,args.out.open("x",encoding="utf-8") as output:
        folder=Path(temp)
        rows_file=folder/"train.json"
        rows_file.write_text(json.dumps({"split":"train","rows":[row]}),encoding="utf-8")
        rng=np.random.default_rng(934)
        fitted=[]
        for kind in ("ffa-lora","lora","ffn"):
            spec={"key":kind.replace("-","_"),"kind":kind,"layers":[0],"rank":8,"alpha":16,"intermediate":128}
            layout=fusion_runtime.schema_for(spec,3072,26)
            initial={key:(np.zeros(shape,dtype=np.float32) if key.endswith((".B",".down.weight")) else
                         rng.uniform(-.01,.01,shape).astype(np.float32)) for key,(shape,_) in layout.items()}
            ck=folder/f"{kind}.safetensors"
            save_file(initial,ck)
            events=[]
            def emit(message):
                if message.get("type") in ("loaded","step"):events.append(message)
            old=sidecar.emit
            sidecar.emit=emit
            try:
                start=time.perf_counter()
                result=fusion_runtime.run({"id":kind,"backend":"cuda","model_files_digest":digest,"expert":spec,"max_length":256,
                    "checkpoint_sha256":sha256_file(ck),"rows_sha256":sha256_file(rows_file),"retain_model":True,
                    "expected_supervised_tokens":sum(row["target_mask"][1:]),"training":{"optimizer":"sgd","lr":.001,"local_steps":1,"grad_accum":1,"clip":1},
                    "paths":{"model_dir":str(args.model.resolve()),"checkpoint":str(ck),"rows":str(rows_file),
                             "result":str(folder/f"{kind}.update.safetensors")}},permit=lambda _,step:guard(args.coordinator_db,cold=step==0 and kind=="ffa-lora"),emit=emit)
                result.pop("update_path")
                updated=load_file(folder/f"{kind}.update.safetensors")
                full=folder/f"{kind}.fitted.safetensors"
                save_file({**initial,**updated},full)
                fitted.append((spec,layout,full))
                output.write(json.dumps({"classification":"MEASURED","backend":"cuda-nf4","expert":kind,"model_files_digest":digest,
                    "initial_telemetry":guarded,"wall_s":time.perf_counter()-start,"events":events,**result})+"\n")
                output.flush()
                time.sleep(next(e["compute_ms"] for e in events if e["type"]=="step")*.009)
            finally:
                sidecar.emit=old
        if args.loop_probe:
            import torch
            backend=next_backend(args,digest)
            try:
                for spec,layout,checkpoint in fitted:
                    backend.install(spec,checkpoint,layout,append=True)
                backend.model.requires_grad_(False)
                rows=list(backend.layers[0].router.parameters())
                for p in rows:p.requires_grad_(True)
                router_before=[p.detach().clone() for p in rows]
                backend.model.train()
                guard(args.coordinator_db)
                with loop_text_layers(backend.model,start=0,end=2,passes=2) as gates:
                    gate_before=gates.detach().clone()
                    opt=torch.optim.SGD([*rows,gates],lr=.05)
                    start=time.perf_counter()
                    nll,_,targets=backend.objective(row)
                    loss=nll/targets.numel()
                    loss.backward()
                    router_norm=sum(float(p.grad.norm()) for p in rows if p.grad is not None)
                    loop_norm=float(gates.grad.norm())
                    if not np.isfinite(router_norm+loop_norm) or not router_norm or not loop_norm:
                        raise RuntimeError("non-finite or zero Router/Loop gradient")
                    opt.step()
                    torch.cuda.synchronize()
                    if torch.equal(gates,gate_before) or not any(not torch.equal(a,b) for a,b in zip(rows,router_before,strict=True)):
                        raise RuntimeError("Router/Loop optimizer did not change parameters")
                    duration=time.perf_counter()-start
                    output.write(json.dumps({"classification":"MEASURED","backend":"cuda-nf4","expert":"moe-loop-probe",
                        "model_files_digest":digest,"trainable_router_grad_norm":router_norm,"loop_gate_grad_norm":loop_norm,
                        "loop":{"start":0,"end":2,"passes":2},"nll":float(loss.detach()),"supervised_tokens":targets.numel(),
                        "step_wall_s":duration,"shared_backbone":True,**backend.metrics()})+"\n")
                    output.flush()
                time.sleep(duration*9)
            finally:
                backend.clear()
    fusion_runtime.release()


def next_backend(args,digest):
    backend,warm=fusion_runtime.acquire({"id":"moe-loop-probe","backend":"cuda","model_files_digest":digest,
        "paths":{"model_dir":str(args.model.resolve())}},lambda *_:guard(args.coordinator_db),lambda *_:None)
    if not warm:raise RuntimeError("expected a resident NF4 model")
    return backend


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    for opt in ("archive","model","coordinator-db","out"):
        parser.add_argument("--"+opt,type=Path,required=True)
    parser.add_argument("--loop-probe",action="store_true")
    parser.add_argument("--composition-trial",action="store_true")
    try:main(parser.parse_args())
    finally:fusion_runtime.release()
