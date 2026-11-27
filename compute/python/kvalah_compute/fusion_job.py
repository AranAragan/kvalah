"""Execute one bounded CPU reference assignment using verified local artifacts."""

import argparse
import json
from pathlib import Path

import torch
from safetensors.torch import load_file

from .fusion_lab import digest, fixed_selection, install, make_model, parameters_for, read_weights, save_weights, train


def load_training_rows(file, context, vocab, domain):
    data=json.loads(file.read_text(encoding="utf-8"))
    rows=data.get("rows")
    if data.get("format")!="kvalah-fusion-shard/v1" or data.get("split")!="train" or not isinstance(rows,list) or not 1<=len(rows)<=256:
        raise ValueError("invalid reference Train shard")
    batches=[]
    for row in rows:
        ids,mask=row["input_ids"],row["target_mask"]
        if not 2<=len(ids)<=context or any(type(i)!=int or not 0<=i<vocab for i in ids) or len(mask)!=len(ids) or mask[0] is not False:
            raise ValueError("invalid reference Train row")
        if not all(type(v)==bool for v in mask) or not any(mask[1:]):
            raise ValueError("invalid target mask")
        batches.append((torch.tensor([ids],dtype=torch.long),torch.tensor([mask],dtype=torch.bool),[domain]))
    return batches


def run_job(job_dir, candidate):
    torch.set_num_threads(1)
    request=json.loads((job_dir/"job.json").read_text(encoding="utf-8"))
    paths={}
    for role,h in request["artifacts"].items():
        if not isinstance(h,str) or len(h)!=64 or any(c not in "0123456789abcdef" for c in h):
            raise ValueError("invalid reference job digest")
        file=job_dir/h
        if file.is_symlink() or digest(file)!=h:
            raise ValueError("reference job failed integrity verification")
        paths[role]=file
    config=json.loads(paths["architecture"].read_text(encoding="utf-8"))
    if config.get("format")!="kvalah-fusion-cpu-job/v1":
        raise ValueError("only the CPU reference job format is supported")
    dims=config["model"]
    if not 1<=dims["layers"]<=4 or not 1<=dims["width"]<=64 or not 1<=dims["context"]<=256 or not 1<=dims["intermediate"]<=256 or not 1<=dims["vocab"]<=256:
        raise ValueError("reference assignment exceeds limits")
    model=make_model(dims,device="cpu")
    model.load_state_dict(read_weights(paths["backbone"],request["artifacts"]["backbone"],model.state_dict()))
    spec=json.loads(paths["expert-config"].read_text(encoding="utf-8"))
    if spec!=request["expert"] or spec["kind"] not in ("ffa-lora","lora") or not 1<=spec["rank"]<=32:
        raise ValueError("reference worker accepts only bounded LoRA assignments")
    install(model,spec)
    subset=parameters_for(model,"expert",spec["key"])
    original=load_file(paths["expert"],device="cpu")
    # A signed registry schema uses the portable block index and the runtime-specific expert key.
    if set(subset)!=set(original) or any(original[n].shape!=p.shape or original[n].dtype!=torch.float32 or
                                       not torch.isfinite(original[n]).all() for n,p in subset.items()):
        raise ValueError("reference expert checkpoint schema mismatch")
    with torch.no_grad():
        for name,p in subset.items():
            p.copy_(original[name])
    fixed_selection(model,spec["key"])
    training=request["training"]
    if not 1<=training["local_steps"]<=64 or not 1<=training["grad_accum"]<=8:
        raise ValueError("reference training exceeds step budget")
    batches=load_training_rows(paths["train"],dims["context"],dims["vocab"],spec["key"])
    stats=train(model,batches,subset=subset,steps=training["local_steps"],lr=training["lr"],optim=training["optimizer"],
                clip=training["clip"],grad_accum=training["grad_accum"])
    if any(not torch.equal(original[n],p) for n,p in subset.items() if not p.requires_grad):
        raise ValueError("reference worker changed frozen A")
    stats["sha256"]=save_weights(candidate,{n:p for n,p in subset.items() if p.requires_grad})
    return stats


if __name__=="__main__":
    cli=argparse.ArgumentParser(description=__doc__)
    cli.add_argument("job_dir",type=Path)
    cli.add_argument("candidate",type=Path)
    args=cli.parse_args()
    print(json.dumps(run_job(args.job_dir,args.candidate)))
