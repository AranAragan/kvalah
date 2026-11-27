"""Run fifty independent jobs through the same production sidecar runtime."""
import argparse
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "compute" / "python"))
from kvalah_compute import sidecar
from kvalah_compute.canonical import decode, encode, frozen_a_hash


def json_file(path):
    return json.loads(path.read_bytes())


def tiny():
    profile = {"profile": "tiny-test-ffa-r4", "layers": 2, "targets": {"q_proj": (64, 64), "v_proj": (64, 32)}, "rank": 4, "alpha": 8}
    rng = np.random.default_rng(7)
    adapter = {}
    for i in range(2):
        for target, (dim_in, dim_out) in profile["targets"].items():
            k = f"layers.{i}.self_attn.{target}"
            adapter[k + ".A"] = rng.uniform(-.05, .05, (4, dim_in)).astype(np.float32)
            adapter[k + ".B"] = np.zeros((dim_out, 4), dtype=np.float32)
    rows = [{"id": str(i), "input_ids": [2, 8 + i % 5, 16, 3], "target_mask": [0, 0, 1, 1]} for i in range(50)]
    return profile, encode(adapter), rows


def frozen_workload(args):
    home = args.archive / "research"
    exp = json_file(home / "snapshot.json")
    base = args.archive / "cas" / exp["initial_hash"]
    raw = base.read_bytes()
    if hashlib.sha256(raw).hexdigest() != exp["initial_hash"]:
        raise ValueError("R10 checkpoint hash mismatch")
    slices = json_file(home / "assignments.json")
    source = []
    for slot in slices:
        if slot["round_attempt"] != 1:
            continue
        h = slot["rows_sha"]
        blob = (args.archive / "cas" / h).read_bytes()
        if hashlib.sha256(blob).hexdigest() != h:
            raise ValueError("Assignment hash mismatch")
        source.extend(json.loads(blob)["rows"])
        if len(source) >= 50:
            break
    digest, = [v["files_digest"] for v in exp["model_snapshot"] if v["variant_id"] == "cuda-nf4"]
    return {"profile": "ministral3b-ffa-r8-v1", "layers": 26, "targets": {"q_proj": (3072, 4096),
            "v_proj": (3072, 1024)}, "rank": 8, "alpha": 16, "model_files_digest": digest}, raw, source


def check_cuda(db_file, starts):
    import psutil
    battery = psutil.sensors_battery()
    if battery is not None and battery.power_plugged is not True:
        raise RuntimeError("Local safety stop: mains power required")
    if psutil.virtual_memory().available < 2 * 2**30:
        raise RuntimeError("Local safety stop: less than 2 GiB system RAM free")
    with sqlite3.connect(db_file.resolve().as_uri() + "?mode=ro", uri=True) as db:
        db.execute("pragma query_only=on")
        if db.execute("select count(*) from experiments where state='RUNNING'").fetchone()[0]:
            raise RuntimeError("Local safety stop: active Compute experiment")
        if db.execute("select count(*) from tasks where state='leased' and lease_expires_at>?", (int(time.time()*1000),)).fetchone()[0]:
            raise RuntimeError("Local safety stop: active Compute lease")
    info = subprocess.check_output(["nvidia-smi", "--query-gpu=memory.free,temperature.gpu",
                                    "--format=csv,noheader,nounits"], text=True).splitlines()[0]
    free, temp = map(float, info.split(","))
    if temp >= 80 or free < (4096 if starts else 1536):
        raise RuntimeError("Local safety stop: temperature or VRAM")


def run(args):
    real = args.backend == "cuda"
    if real and not all((args.archive, args.model, args.coordinator_db)):
        raise ValueError("CUDA needs --archive, --model, and --coordinator-db")
    if not real:
        os.environ["KVALAH_COMPUTE_TEST"] = "1"
    profile, base, rows = frozen_workload(args) if real else tiny()
    a_hash = frozen_a_hash(decode(base))
    with TemporaryDirectory(prefix="kc-v03-runtime-") as tmp, args.out.open("x", encoding="utf-8") as out:
        current = {}
        def emit(msg):
            if msg.get("type") in ("loaded", "step"):
                current[msg["type"]] = msg
        sidecar.emit = emit
        sidecar.wait_permit = lambda *_: None
        try:
            reference = args.reference
            inputs = [rows[0], rows[0], *rows[:49]]
            if args.warm_only:
                inputs = inputs[1:]
            for i, row in enumerate(inputs):
                warm = args.warm_only or i > 0
                if real:
                    check_cuda(args.coordinator_db, starts=i < (1 if args.warm_only else 2))
                folder = Path(tmp) / f"task-{i:02d}"
                folder.mkdir()
                (folder / "base.safetensors").write_bytes(base)
                (folder / "rows.json").write_text(json.dumps({"rows": [row]}), encoding="utf-8")
                task = dict(profile, task_id=f"offline-{i}", local_steps=1, grad_accum=1, max_length=256,
                            optimizer={"name": "sgd", "lr": .001, "clip_norm": 1.}, frozen_A_hash=a_hash,
                            expected_supervised_tokens=sum(row["target_mask"][1:]))
                current.clear()
                start = time.perf_counter()
                result = sidecar.train({"id": str(i), "task": task, "backend": args.backend, "retain_model": warm,
                                        "paths": {"task_dir": str(folder), "model_dir": str(args.model) if args.model else ""}})
                elapsed = time.perf_counter() - start
                digest = hashlib.sha256(Path(result["update_path"]).read_bytes()).hexdigest()
                if i == 0 and reference is None:
                    reference = digest
                if i <= (1 if args.warm_only else 2) and digest != reference:
                    raise ValueError("Cold and warm outputs differ on the same input")
                if current["loaded"]["cache_hit"] != (i > (0 if args.warm_only else 1)) or not result["a_unchanged"]:
                    raise ValueError("Unexpected load or changed A")
                report = {"classification": "MEASURED", "backend": args.backend, "index": i, "warm": warm,
                          "digest": digest, "row_id": row["id"], "cache_hit": current["loaded"]["cache_hit"], "frozen_A_sha256": a_hash,
                          "timing": result["timing"], "wall_s": elapsed, "memory": result["memory"]}
                out.write(json.dumps(report) + "\n")
                out.flush()
                if real:
                    # Conservative cooperative pacing. Charge the whole command wall time, including cold startup.
                    time.sleep(elapsed * 9)
            assert sidecar.release_model() == {"resident": False}
        finally:
            sidecar.release_model()
    print(f"{args.backend}: 50 warm-mode tasks, one initial model load, unchanged A and exact cold/warm output for the repeated input")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend", choices=("mock", "cuda"), default="mock")
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--model", type=Path)
    parser.add_argument("--coordinator-db", type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--warm-only", action="store_true")
    parser.add_argument("--reference", help="SHA-256 of the first independently measured cold update")
    run(parser.parse_args())
