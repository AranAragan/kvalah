"""Measure client drift from immutable accepted updates; simulate single-round server scaling."""
import argparse
import csv
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "compute" / "python"))
from kvalah_compute.canonical import decode


def run(archive, out):
    rs = json.loads((archive / "research" / "rounds.json").read_bytes())
    def load(h):
        t = decode((archive / "cas" / h).read_bytes())
        return np.concatenate([t[k].ravel() for k in sorted(t) if k.endswith(".B")]).astype(np.float64)
    data = []
    for r in rs:
        if r["state"] != "COMMITTED":
            continue
        base = load(r["parent_hash"])
        updates = r["accepted"]
        n = np.array([u["weight"] for u in updates], np.float64)
        deltas = np.stack([load(u["payload_sha"]) - base for u in updates])
        norms = np.linalg.norm(deltas, axis=1)
        mix = np.average(deltas, axis=0, weights=n)
        norm = np.linalg.norm(mix)
        uniform = np.mean(deltas, axis=0)
        mean_norm = np.average(norms, weights=n)
        data.append({"classification":"MEASURED", "round":r["idx"]+1, "tokens":int(n.sum()),
                     "weighted_update_norm":float(norm), "weighted_mean_client_norm":float(mean_norm),
                     "alignment_ratio":float(norm/mean_norm) if mean_norm else None,
                     "difference_equal_weight":float(np.linalg.norm(uniform-mix)),
                     "weighted_rms_drift":float(np.sqrt(np.average(np.sum((deltas-mix)**2, axis=1), weights=n)))})
    with out.with_suffix(".jsonl").open("x", encoding="utf8") as handle:
        for row in data:
            handle.write(json.dumps(row)+"\n")
    with out.with_suffix(".csv").open("x", encoding="utf8", newline="") as handle:
        writer=csv.DictWriter(handle, data[0].keys())
        writer.writeheader()
        writer.writerows(data)
    ratios = [r["alignment_ratio"] for r in data if r["alignment_ratio"] is not None]
    print(json.dumps({"rounds":len(data), "alignment_median":float(np.median(ratios)),
                      "rms_drift_median":float(np.median([r["weighted_rms_drift"] for r in data])),
                      "equal_weight_delta_median":float(np.median([r["difference_equal_weight"] for r in data]))}))


if __name__ == "__main__":
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("archive",type=Path)
    p.add_argument("out",type=Path)
    args=p.parse_args()
    run(args.archive,args.out)
