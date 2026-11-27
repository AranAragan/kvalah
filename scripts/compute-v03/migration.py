"""Verify the production SQLite migration on a copy of a v2 coordinator."""
import argparse
import hashlib
import json
import sqlite3
import subprocess
from pathlib import Path


def open_read(path):
    db = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    db.execute("pragma query_only=on")
    return db


def inspect(db):
    def read(table, order):
        out = db.execute(f"select * from {table} order by {order}").fetchall()
        raw = json.dumps(out, separators=(",", ":")).encode()
        return {"n": len(out), "digest": hashlib.sha256(raw).hexdigest()}
    return {
        "schema": db.execute("select value from meta where key=?", ("schema_version",)).fetchone()[0],
        "integrity": db.execute("pragma integrity_check").fetchone()[0],
        "experiments": read("experiments", "id"),
        "checkpoints": read("checkpoints", "experiment_id,round_idx"),
        "datasets": read("datasets", "id"),
        "variants": read("model_variants", "profile_id,variant_id"),
    }


def run(args):
    if args.copy.exists() or args.report.exists() or args.source.resolve() == args.copy.resolve():
        raise ValueError("Choose a new copy and report path")
    with open_read(args.source) as source, sqlite3.connect(args.copy) as copy:
        source.backup(copy)
        before = inspect(copy)
    source.close()
    copy.close()
    if before["schema"] != "2":
        raise ValueError("This check requires a v2 source")
    subprocess.run(["node", "--input-type=module", "-e", "import {openDB} from './compute/coordinator/db.mjs';openDB(process.argv[1]).close();",
                    str(args.copy.resolve())], cwd=Path(__file__).resolve().parents[2], check=True)
    with open_read(args.copy) as result:
        after = inspect(result)
    result.close()
    if after["schema"] != "3" or before["integrity"] != "ok" or after["integrity"] != "ok" or any(
            before[k] != after[k] for k in ("experiments", "checkpoints", "datasets", "variants")):
        raise ValueError("Migration changed historical rows or failed integrity check")
    with args.report.open("x", encoding="utf8") as handle:
        json.dump({"classification":"MEASURED","before":before,"after":after}, handle, indent=2)
    print("Migration 2 to 3: integrity OK, experiment, checkpoint, dataset and model rows unchanged")


if __name__ == "__main__":
    p=argparse.ArgumentParser(description=__doc__)
    for k in ("source","copy","report"):
        p.add_argument(k,type=Path)
    run(p.parse_args())
