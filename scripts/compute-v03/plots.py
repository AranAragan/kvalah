"""Plot measured compression and isolated coordinator throughput."""
import argparse
import csv
from pathlib import Path
from statistics import median

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt


def csv_rows(path):
    with path.open(encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


if __name__ == "__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("compression",type=Path)
    parser.add_argument("heartbeats",type=Path)
    parser.add_argument("out",type=Path)
    args=parser.parse_args()
    codecs=csv_rows(args.compression)
    heartbeats=csv_rows(args.heartbeats)
    fig,(left,right)=plt.subplots(1,2,figsize=(10.5,4.3),layout="constrained")
    methods=["none","lz4","zstd-3"]
    pct=[100*median(float(r["compressed_bytes"])/float(r["source_bytes"]) for r in codecs if r["codec"]==method) for method in methods]
    bars=left.bar(methods,pct,color=["#596c81","#3b8195","#23846d"])
    left.bar_label(bars,labels=[f"{x:.2f}%" for x in pct],padding=3)
    left.set(ylim=(0,112),ylabel="Source bytes retained (%)",title="30 historical R60 payloads")
    left.grid(axis="y",alpha=.2)
    sizes=[int(r["devices"]) for r in heartbeats]
    right.plot(sizes,[float(r["heartbeats_s"]) for r in heartbeats],marker="o",color="#3b8195")
    right.set(xscale="log",ylabel="Heartbeat calls per second",xlabel="Synthetic identities",title="In-process coordinator and SQLite")
    right.set_xticks(sizes,labels=[f"{n:,}" for n in sizes])
    right.grid(alpha=.2)
    fig.suptitle("Compute v0.3 • Measured software experiments")
    fig.savefig(args.out,dpi=160,bbox_inches="tight")
