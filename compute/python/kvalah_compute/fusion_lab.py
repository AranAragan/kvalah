"""Run isolated Expert Fusion studies on deterministic, small tokenized language models."""

import argparse
import hashlib
import json
import math
import time
from pathlib import Path

import torch
from safetensors.torch import load_file, save_file

from .fusion import FFN, FusionModel, LoRA, Loop, supervised_loss


def digest(file):
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def save_weights(file, tensors):
    if file.exists():
        raise FileExistsError(file)
    save_file({k: v.detach().cpu().contiguous() for k, v in tensors.items()}, file)
    return digest(file)


def read_weights(file, expected, schema):
    if digest(file) != expected:
        raise ValueError(f"invalid weight digest: {file.name}")
    weights = load_file(file, device="cpu")
    if set(weights) != set(schema):
        raise ValueError("checkpoint tensors do not match model")
    if any(weights[k].shape != v.shape or weights[k].dtype != v.dtype or not torch.isfinite(weights[k]).all()
           for k, v in schema.items()):
        raise ValueError("checkpoint shape, dtype or finite-value check failed")
    return weights


def model_from_manifest(file, *, device="cpu"):
    manifest = json.loads(file.read_text(encoding="utf-8"))
    if manifest.get("format") != "kvalah-fusion-reference/v1":
        raise ValueError("unsupported model format")
    model = make_model(manifest["model"], device=device)
    for expert in manifest["experts"]:
        install(model, expert)
    for layer in model.blocks:
        layer.ffn.disabled.update(manifest.get("disabled", []))
    weight_path = file.with_name("model.safetensors")
    model.load_state_dict(read_weights(weight_path, manifest["weights_sha256"], model.state_dict()))
    return model.eval()


def make_model(config, *, device):
    cfg = dict(config)
    loop = Loop(**cfg.pop("loop", {}))
    if not 1 <= cfg["layers"] <= 26 or not 4 <= cfg["width"] <= 512 or not 1 <= cfg["intermediate"] <= 2048:
        raise ValueError("reference profile exceeds allowed dimensions")
    if not 8 <= cfg["vocab"] <= 4096 or not 2 <= cfg["context"] <= 4096:
        raise ValueError("reference profile exceeds allowed vocabulary or context")
    return FusionModel(**cfg, loop=loop).to(device)


def install(model, spec):
    for i in spec["layers"]:
        mlp = model.blocks[i].ffn
        width = model.config["width"]
        if spec["kind"] in ("lora", "ffa-lora"):
            expert = LoRA(width, width, spec["rank"], spec["alpha"], frozen_a=spec["kind"] == "ffa-lora")
        elif spec["kind"] == "ffn":
            expert = FFN(width, spec["intermediate"], residual=spec.get("residual", True))
            if spec.get("copy_base", False):
                expert.from_base([mlp.base.gate.weight, mlp.base.up.weight, mlp.base.down.weight])
            expert.train_parts(spec.get("training", "full"))
        else:
            raise ValueError("unknown expert kind")
        mlp.add(spec["key"], expert)
        mlp.replacement = spec.get("replacement", False)


def parameters_for(model, kind, key=None):
    if kind == "expert":
        return {n: p for n, p in model.named_parameters() if f".experts.{key}." in n}
    if kind == "router":
        return {n: p for n, p in model.named_parameters() if ".router.rows." in n}
    if kind == "loop":
        return {"loop_gates": model.loop_gates}
    raise ValueError("unknown trainable subset")


def train(model, batches, *, subset, steps, lr, optim="adamw", clip=1.0, grad_accum=1, proximal_mu=0):
    if not subset or not batches or not 1 <= steps <= 10000 or not 1 <= grad_accum <= 1024 or not 0 < lr <= 1:
        raise ValueError("invalid training run")
    allowed = {n for n, p in subset.items() if p.requires_grad}
    if not allowed:
        raise ValueError("no eligible parameters")
    params = dict(model.named_parameters())
    state = {k: p.requires_grad for k, p in params.items()}
    seed_weights = {k: params[k].detach().clone() for k in allowed} if proximal_mu else {}
    start = time.perf_counter()
    seen = 0
    last_loss = None
    try:
        for k, p in params.items():
            p.requires_grad_(k in allowed)
        constructors = {"adamw": torch.optim.AdamW, "sgd": torch.optim.SGD}
        opt = constructors[optim]([params[k] for k in sorted(allowed)], lr=lr)
        model.train()
        for step in range(steps):
            opt.zero_grad(set_to_none=True)
            local_batches = [batches[(step * grad_accum + i) % len(batches)] for i in range(grad_accum)]
            tokens_total = sum(int(mask[:, 1:].sum()) for _, mask, _ in local_batches)
            for ids, mask, labels in local_batches:
                logits, _, routes = model(ids, domains=labels)
                loss, tokens = supervised_loss(logits, ids, mask)
                auxiliary = []
                for route in routes:
                    auxiliary.append(0.01 * route["balance_loss"] + 0.001 * route["z_loss"])
                    if set(labels).issubset(route["keys"]) and any(".router.rows." in key for key in allowed):
                        targets = ids.new_tensor([route["keys"].index(k) for k in labels])
                        auxiliary.append(0.1 * torch.nn.functional.cross_entropy(route["logits"][:, 0, :], targets))
                obj = loss + sum(auxiliary) / max(1, len(routes))
                if proximal_mu:
                    obj = obj + proximal_mu/2 * sum((params[k] - seed_weights[k]).square().sum() for k in allowed)
                if not torch.isfinite(obj):
                    raise ValueError("non-finite training objective")
                (obj * (tokens / tokens_total)).backward()
                seen += tokens
                last_loss = float(loss.detach())
            torch.nn.utils.clip_grad_norm_([params[k] for k in allowed], clip, error_if_nonfinite=True)
            opt.step()
            if not all(torch.isfinite(params[k]).all() for k in allowed):
                raise ValueError("non-finite optimizer result")
    finally:
        for k, p in params.items():
            p.requires_grad_(state[k])
    if next(model.parameters()).is_cuda:
        torch.cuda.synchronize()
    return {"steps": steps, "tokens": seen, "last_nll": last_loss, "seconds": time.perf_counter() - start}


@torch.no_grad()
def evaluate(model, batches):
    model.eval()
    total, correct, count, nll = 0, 0, 0, 0.0
    routes, entropy, router_correct = {}, [], []
    start = time.perf_counter()
    for ids, mask, labels in batches:
        logits, _, stats = model(ids, domains=labels)
        loss, tokens = supervised_loss(logits, ids, mask)
        total += tokens
        nll += float(loss) * tokens
        correct += int((logits[:, :-1].argmax(-1)[mask[:, 1:]] == ids[:, 1:][mask[:, 1:]]).sum())
        count += ids.shape[0]
        for stat in stats:
            entropy.append(float(stat["entropy"]))
            for k, n in zip(stat["keys"], stat["counts"], strict=True):
                routes[k] = routes.get(k, 0) + int(n)
            router_correct.extend(stat["keys"][i] == d for i, d in zip(stat["logits"][:, 0].argmax(-1).tolist(), labels, strict=True))
    return {"nll":nll/total, "perplexity":math.exp(nll/total), "accuracy":correct/total, "tokens":total,
            "examples":count, "route_counts":routes, "route_entropy":sum(entropy)/len(entropy) if entropy else None,
            "router_accuracy":sum(router_correct)/len(router_correct) if router_correct else None,
            "seconds":time.perf_counter()-start}


def fixed_selection(model, key=None):
    for layer in model.blocks:
        experts = layer.ffn.experts
        layer.ffn.fixed = {key: 1.0} if key is not None and key in experts else {}


def rows(domain, variant, device):
    # Fixed synthetic token tasks for implementation acceptance. The four variants use disjoint
    # prompt groups. The relation between prompt and answer is shared across splits.
    cases = [(x, y) for x in range(4, 12) for y in range(4, 12) if (x + 2*y) % 4 == variant]
    if domain == "code":
        begin, fn = 1, lambda x, y: x
    elif domain == "math":
        begin, fn = 2, lambda x, y: (x + y) % 8 + 12
    else:
        begin, fn = 3, lambda x, y: y
    tokens = torch.tensor([[begin, x, y, fn(x,y), 20] for x,y in cases], device=device)
    mask = torch.tensor([False, False, False, True, True], device=device).expand_as(tokens)
    return tokens, mask, [domain] * len(tokens)


def run_reference(output, device="cpu", seed=934):
    torch.manual_seed(seed)
    torch.set_num_threads(1)
    output.mkdir(parents=True, exist_ok=False)
    config = dict(vocab=32, width=24, heads=4, layers=4, intermediate=48, context=32, router={"top_k":1})
    model = make_model(config, device=device)
    original = {k: v.detach().clone() for k, v in model.state_dict().items()}
    domains = ("code", "math", "language")
    expert_specs = [dict(key=k, kind="ffa-lora" if k!="math" else "lora", layers=[2,3], rank=6, alpha=12) for k in domains]
    validation = [rows(k, 1, device) for k in domains]
    baseline = evaluate(model, validation)
    metrics = []
    for spec, heldout in zip(expert_specs, validation, strict=True):
        install(model, spec)
        k = spec["key"]
        fixed_selection(model, k)
        subset = parameters_for(model, "expert", k)
        frozen = {n:p.detach().clone() for n,p in subset.items() if not p.requires_grad}
        control = evaluate(model, [heldout])
        trained = train(model, [rows(k, 0, device)], subset=subset, steps=32, lr=0.015)
        assert all(torch.equal(frozen[n], subset[n]) for n in frozen)
        h = save_weights(output/f"expert-{k}.safetensors", subset)
        metrics.append({"key":k, "control":control, "validation":evaluate(model, [heldout]), "train":trained, "sha256":h})
    previous = {name:p.detach().clone() for name,p in model.named_parameters() if ".experts." in name}
    new = dict(key="reasoning", kind="ffn", layers=[2], intermediate=32)
    fixed_selection(model)
    install(model, new)
    fixed_selection(model, new["key"])
    before = evaluate(model, validation)
    ffn_subset = parameters_for(model, "expert", new["key"])
    ffn_run = train(model, [rows(k, 0, device) for k in domains], subset=ffn_subset, steps=24, lr=0.008)
    ffn_validation = evaluate(model, validation)
    ffn_hash=save_weights(output/"expert-reasoning.safetensors",ffn_subset)
    for b in model.blocks:
        b.ffn.fixed=None
    router_run = train(model, [rows(k, 0, device) for k in domains], subset=parameters_for(model,"router"), steps=48, lr=0.025)
    routed = evaluate(model, validation)
    assert all(torch.equal(previous[n], p) for n,p in model.named_parameters() if n in previous)
    config["loop"] = dict(start=1, end=3, passes=2)
    expanded = make_model(config, device=device)
    for spec in expert_specs+[new]:
        install(expanded, spec)
    incompatible = expanded.load_state_dict({k:v for k,v in model.state_dict().items() if k!="loop_gates"}, strict=False)
    assert incompatible.missing_keys==["loop_gates"] and not incompatible.unexpected_keys
    loop_run = train(expanded, [rows(k,0,device) for k in domains], subset=parameters_for(expanded,"loop"), steps=8, lr=0.01)
    integrated = evaluate(expanded, validation)
    assert all(torch.equal(expanded.state_dict()[k], v) for k,v in original.items() if k!="loop_gates")
    weights = save_weights(output/"model.safetensors",expanded.state_dict())
    manifest = dict(format="kvalah-fusion-reference/v1",model=config,experts=expert_specs+[new],weights_sha256=weights)
    model_file=output/"manifest.json"
    model_file.write_text(json.dumps(manifest, indent=2)+"\n",encoding="utf-8")
    restored = model_from_manifest(model_file, device=device)
    with torch.no_grad():
        tokens,_,_=validation[0]
        logits,_,_=expanded(tokens)
        reload_logits,_,_=restored(tokens)
        cache=None
        partial=[]
        for token in tokens.split(1,dim=1):
            segment,cache,_=restored(token,use_cache=True,cache=cache)
            partial.append(segment)
        reload_error=float((logits-reload_logits).abs().max())
        cached_error=float((reload_logits-torch.cat(partial,dim=1)).abs().max())
    if reload_error!=0 or cached_error>1e-5:
        raise ValueError("export or incremental inference disagrees with original logits")
    results=dict(classification="MEASURED",fixture="synthetic tokens",device=device,seed=seed,baseline=baseline,experts=metrics,
                 ffn_initial=before,ffn_training=ffn_run,ffn_validation=ffn_validation,ffn_sha256=ffn_hash,router=router_run,
                 routed=routed,loop=loop_run,integrated=integrated,reload_max_error=reload_error,cached_max_error=cached_error,
                 frozen_backbone=True,old_experts_unchanged=True)
    (output/"results.json").write_text(json.dumps(results,indent=2)+"\n",encoding="utf-8")
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    parser.add_argument("--seed", type=int, default=934)
    args = parser.parse_args()
    print(json.dumps(run_reference(args.output,args.device,args.seed)))


if __name__ == "__main__":
    main()
