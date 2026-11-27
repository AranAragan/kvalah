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
from safetensors.numpy import save_file

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"compute"/"python"))
from kvalah_compute import fusion_runtime,sidecar
from kvalah_compute.canonical import sha256_file


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


def main(args):
    digest,row=input_row(args.archive)
    os.environ.setdefault("KVALAH_SIDECAR_THREADS","1")
    guarded=guard(args.coordinator_db,cold=True)
    with TemporaryDirectory(prefix="kvalah-fusion-nf4-") as temp,args.out.open("x",encoding="utf-8") as output:
        folder=Path(temp)
        rows_file=folder/"train.json"
        rows_file.write_text(json.dumps({"split":"train","rows":[row]}),encoding="utf-8")
        rng=np.random.default_rng(934)
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
                output.write(json.dumps({"classification":"MEASURED","backend":"cuda-nf4","expert":kind,"model_files_digest":digest,
                    "initial_telemetry":guarded,"wall_s":time.perf_counter()-start,"events":events,**result})+"\n")
                output.flush()
                time.sleep(next(e["compute_ms"] for e in events if e["type"]=="step")*.009)
            finally:
                sidecar.emit=old
    fusion_runtime.release()


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    for opt in ("archive","model","coordinator-db","out"):
        parser.add_argument("--"+opt,type=Path,required=True)
    try:main(parser.parse_args())
    finally:fusion_runtime.release()
