"""Generate the reference experiment figure and tabular measurements."""

import argparse
import csv
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reference",type=Path)
    parser.add_argument("scale",type=Path)
    parser.add_argument("output",type=Path)
    args=parser.parse_args()
    model=json.loads(args.reference.read_text(encoding="utf-8"))
    scale=[json.loads(line) for line in args.scale.read_text(encoding="utf-8").splitlines()]
    args.output.mkdir(parents=True,exist_ok=True)
    labels=["Frozen base","Routed experts","Experts + Loop"]
    states=[model[k] for k in ("baseline","routed","integrated")]
    with (args.output/"validation.csv").open("w",encoding="utf-8",newline="") as stream:
        writer=csv.DictWriter(stream,fieldnames=["configuration","nll","perplexity","accuracy","tokens","examples","seconds"],extrasaction="ignore",lineterminator="\n")
        writer.writeheader()
        writer.writerows({"configuration":label,**state} for label,state in zip(labels,states,strict=True))
    with (args.output/"scalability.csv").open("w",encoding="utf-8",newline="") as stream:
        keys=["virtual_devices","assigned","ineligible","scheduler_and_simulation_wall_ms","node_rss_bytes","p50_job_s","p95_job_s"]
        writer=csv.DictWriter(stream,fieldnames=keys,extrasaction="ignore",lineterminator="\n")
        writer.writeheader()
        writer.writerows({**row,**row["measurement"],**row["modeled"]} for row in scale)
    fig,(quality,scheduler)=plt.subplots(1,2,figsize=(10.4,4),layout="constrained")
    bars=quality.bar(labels,[row["nll"] for row in states],color=["#63748b","#277d88","#24795f"])
    quality.bar_label(bars,fmt="%.3f",padding=3)
    quality.set(title="96 supervised tokens on CPU",ylabel="Validation NLL",ylim=(0,4))
    quality.grid(axis="y",alpha=0.2)
    xs=[row["virtual_devices"] for row in scale]
    scheduler.plot(xs,[row["measurement"]["scheduler_and_simulation_wall_ms"] for row in scale],marker="o",color="#277d88")
    scheduler.set(xlabel="Virtual devices",ylabel="Local wall time (ms)",title="Scheduling and simulation",xscale="log",yscale="log")
    scheduler.set_xticks(xs,labels=[f"{n:,}" for n in xs])
    scheduler.grid(alpha=0.2)
    fig.suptitle("Expert Fusion reference measurements",fontsize=14)
    fig.savefig(args.output/"reference-overview.png",dpi=160,bbox_inches="tight")


if __name__=="__main__":
    main()
