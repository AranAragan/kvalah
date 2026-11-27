"""Trusted Torch composition optimization, evaluation and generation."""

import os
from contextlib import nullcontext

from .canonical import sha256_file
from .errors import SidecarError
from .fusion_ministral import LoopCache,loop_text_layers,request
from .fusion_runtime import TorchFusion,acquire,checked_path,inspect_checkpoint,read_rows,release,schema_for


def load_parameters(ref,parameters):
    import torch
    from safetensors import safe_open

    if not isinstance(ref,dict):raise SidecarError("INVALID_SCHEMA","missing composition parameter reference")
    file=checked_path(ref.get("file"))
    size=sum(p.numel()*4 for p in parameters.values())
    if file.is_symlink() or file.stat().st_size>size+1024**2 or sha256_file(file)!=ref.get("sha256"):
        raise SidecarError("HASH_MISMATCH","composition parameters differ from the signed checkpoint")
    with safe_open(file,framework="pt",device="cpu") as checkpoint, torch.no_grad():
        if set(checkpoint.keys())!=set(parameters):
            raise SidecarError("INVALID_TENSOR","composition parameter keys do not match the layout")
        for key,param in parameters.items():
            received=checkpoint.get_tensor(key)
            if received.shape!=param.shape or received.dtype!=torch.float32 or not torch.isfinite(received).all():
                raise SidecarError("INVALID_TENSOR","invalid composition parameter tensor")
            param.copy_(received)


def optimize(msg,backend,parameters,loop_context,emit,permit):
    import torch
    from safetensors.torch import save_file
    from .sft import check_row

    cid=msg["id"]
    steps=msg.get("steps")
    lr=msg.get("lr")
    if not parameters or type(steps)!=int or not 2<=steps<=128 or not isinstance(lr,(int,float)) or not 0<lr<=.1:
        raise SidecarError("INVALID_SCHEMA","invalid composition optimizer budget")
    unique={x["train_sha256"]:x["train"] for x in msg["experts"]}
    streams=[read_rows(checked_path(file),digest,msg["max_length"],backend.vocab,"train") for digest,file in unique.items()]
    rows=[stream[i] for i in range(max(map(len,streams))) for stream in streams if i<len(stream)]
    if len(rows)<steps:
        raise SidecarError("DATASET_REQUIRED","composition training budget exceeds available Train rows")
    active=list(parameters.values())
    for p in active:p.requires_grad_(True)
    initial=[p.detach().cpu().clone() for p in active]
    optimizer=torch.optim.AdamW(active,lr=lr,weight_decay=0)
    nll=0.
    seen=0
    max_grad=0.
    with loop_context:
        for i,row in enumerate(rows[:steps],1):
            permit(cid,len(streams)+i)
            optimizer.zero_grad(set_to_none=True)
            count=check_row(row,msg["max_length"])
            loss,_,_=backend.objective(row)
            if not torch.isfinite(loss):
                raise SidecarError("NONFINITE","invalid composition training loss")
            (loss/count).backward()
            grad=float(torch.nn.utils.clip_grad_norm_(active,1.,error_if_nonfinite=True))
            max_grad=max(max_grad,grad)
            optimizer.step()
            seen+=count
            nll+=float(loss.detach())
            emit({"type":"step","id":cid,"step":i,"loss":float(loss.detach())/count,"supervised_tokens":count,"supervised_tokens_total":seen})
    weights={name:p.detach().cpu().contiguous() for name,p in parameters.items()}
    if max_grad==0 or all(torch.equal(initial_value,p) for initial_value,p in zip(initial,weights.values())):
        raise SidecarError("NO_GRADIENT","the pinned composition stage did not change its parameters")
    if any(not torch.isfinite(p).all() for p in weights.values()):
        raise SidecarError("NONFINITE","invalid trained composition weights")
    out=checked_path(msg["output"])
    temp=out.with_suffix(".partial")
    save_file(weights,temp)
    with temp.open("rb+") as stream:os.fsync(stream.fileno())
    os.replace(temp,out)
    return {"sha256":sha256_file(out),"steps":steps,"supervised_tokens":seen,"train_nll":nll/seen,"max_gradient_norm":max_grad}


def run(msg,*,permit,emit,infer=False,fit=False):
    import torch
    cid=msg["id"]
    router=msg["router"]
    if msg.get("backend") not in ("cuda","torch-cpu-test") or router.get("mode") not in ("uniform","token") or router.get("top_k") not in (1,2,4):
        raise SidecarError("ARCHITECTURE","unsupported composed Torch routing configuration")
    stage=msg.get("stage") if fit else None
    if fit and stage not in ("router","loop"):
        raise SidecarError("INVALID_SCHEMA","invalid composition training stage")
    backend,warm=acquire(msg,permit,emit)
    assert isinstance(backend,TorchFusion)
    model=backend.model
    specs=msg["experts"]
    if not isinstance(specs,list) or len(specs)>16 or len({x["spec"]["key"] for x in specs})!=len(specs):
        raise SidecarError("INVALID_SCHEMA","invalid composition experts")
    schemas=[schema_for(item["spec"],backend.width,len(backend.layers)) for item in specs]
    if backend.device=="cuda":
        from math import prod
        context=msg["max_length"]
        config=getattr(model.config,"text_config",model.config)
        weights=sum(prod(shape)*4 for schema in schemas for shape,_ in schema.values())
        activations=4*context*(len(backend.layers)*(10*backend.width+6*config.intermediate_size)+3*backend.vocab) if fit else 4*context*backend.vocab
        repeats=(msg["loop"]["end"]-msg["loop"]["start"])*(msg["loop"]["passes"]-1)
        kv_bytes=4*context*(len(backend.layers)+repeats)*config.num_key_value_heads*config.head_dim if infer else 0
        if weights+activations+kv_bytes+384*1024**2>torch.cuda.mem_get_info()[0]:
            raise SidecarError("LOW_MEMORY","insufficient CUDA memory for the pinned composition")
    cache_mode={}
    try:
        backend.clear()
        for i,(item,layout) in enumerate(zip(specs,schemas),1):
            permit(cid,i)
            spec=item["spec"]
            file=checked_path(item["checkpoint"])
            inspect_checkpoint(file,item["sha256"],layout)
            backend.install(spec,file,layout,append=True)
        model.requires_grad_(False)
        model.eval()
        router_params={f"router.layers.{layer}.{key}":param for layer,slot in backend.layers.items() for key,param in slot.router.rows.items()}
        for layer,slot in backend.layers.items():
            cache_mode[layer]=(slot.router.mode,slot.router.top_k)
            slot.router.mode=router["mode"]
            slot.router.top_k=router["top_k"]
        if router["mode"]=="token":
            if stage=="router":
                if not any(len(slot.experts)>1 for slot in backend.layers.values()):
                    raise SidecarError("INVALID_SCHEMA","learned routing needs overlapping experts in one layer")
                generator=torch.Generator().manual_seed(934)
                with torch.no_grad():
                    for param in router_params.values():
                        param.copy_(torch.randn(param.shape,generator=generator)*param.numel()**-.5)
                for slot in backend.layers.values():slot.router.train()
            else:
                ref=msg.get("router_weights")
                if router.get("sha256") and (ref or {}).get("sha256")!=router["sha256"]:
                    raise SidecarError("HASH_MISMATCH","learned router does not match the composition digest")
                load_parameters(ref,router_params)
        loop=msg["loop"]
        gates=None
        if loop["passes"]>1:
            gates=torch.nn.Parameter(torch.full((loop["passes"]-1,),-2.,device=next(model.parameters()).device),requires_grad=False)
            ref=msg.get("loop_weights")
            if loop.get("sha256") and (ref or {}).get("sha256")!=loop["sha256"]:
                raise SidecarError("HASH_MISMATCH","trained Loop gates do not match the composition digest")
            if ref:load_parameters(ref,{"loop.gates":gates})
        if stage=="router":
            if router["mode"]!="token":raise SidecarError("INVALID_SCHEMA","router training requires token routing")
            return optimize(msg,backend,router_params,nullcontext(),emit,permit)
        if stage=="loop":
            if gates is None:raise SidecarError("INVALID_SCHEMA","Loop adaptation needs at least two passes")
            return optimize(msg,backend,{"loop.gates":gates},looped(model,loop,gates),emit,permit)
        with torch.no_grad():
            if infer:return generate(msg,model,loop,gates,permit,len(specs))
            assessments=[]
            sums={"control":[0.0,0],"candidate":[0.0,0]}
            for i,item in enumerate(specs,1):
                rows=read_rows(checked_path(item["validation"]),item["validation_sha256"],msg["max_length"],backend.vocab,"validation")
                key=item["spec"]["key"]
                expert={mode:[0.0,0] for mode in ("control","candidate")}
                for j,row in enumerate(rows):
                    permit(cid,len(specs)+i+j)
                    with request(weights={key:1}):
                        baseline=backend.evaluate([row])
                    with looped(model,loop,gates):
                        assessed=backend.evaluate([row])
                    for mode,metrics in (("control",baseline),("candidate",assessed)):
                        for accumulation in (expert[mode],sums[mode]):
                            accumulation[0]+=metrics["nll_sum"];accumulation[1]+=metrics["tokens"]
                assessments.append({"key":key,"control_nll":expert["control"][0]/expert["control"][1],
                                    "candidate_nll":expert["candidate"][0]/expert["candidate"][1]})
            if not assessments:raise SidecarError("DATASET_REQUIRED","composite evaluation needs expert Validation data")
            return {"experts":assessments,"control_nll":sums["control"][0]/sums["control"][1],
                    "candidate_nll":sums["candidate"][0]/sums["candidate"][1],"tokens":sums["candidate"][1],"model_cache_hit":warm}
    finally:
        for layer,(mode,top_k) in cache_mode.items():
            backend.layers[layer].router.mode=mode
            backend.layers[layer].router.top_k=top_k
        backend.clear();release()


def looped(model,loop,gates):
    return loop_text_layers(model,start=loop["start"],end=loop["end"],passes=loop["passes"],gate_parameters=gates) if loop["passes"]>1 else nullcontext()


def generate(msg,model,loop,gates,permit,step):
    import torch
    from .tokenize_rows import load_tokenizer
    text=msg.get("prompt")
    maximum=msg.get("max_new_tokens",32)
    if not isinstance(text,str) or not text.strip() or len(text)>4096 or type(maximum)!=int or not 1<=maximum<=128:
        raise SidecarError("INVALID_SCHEMA","invalid Fusion prompt or generation length")
    train,serving,_=load_tokenizer(msg["paths"]["model_dir"])
    tokenizer=serving or train
    inputs=tokenizer.apply_chat_template([{"role":"user","content":text}],tokenize=True,add_generation_prompt=True,return_tensors="pt")
    if not isinstance(inputs,torch.Tensor):inputs=inputs["input_ids"]
    inputs=inputs.to(next(model.parameters()).device)
    maximum_context=msg.get("max_length",256)
    if inputs.shape[-1]+maximum>maximum_context:raise SidecarError("INVALID_SCHEMA","Fusion context budget exceeded")
    result=[]
    cached=msg.get("use_cache",True) is not False
    cache=LoopCache(getattr(model.config,"text_config",model.config),start=loop["start"],end=loop["end"],passes=loop["passes"]) if cached and loop["passes"]>1 else None
    current=inputs
    with looped(model,loop,gates):
        for index in range(maximum):
            permit(msg["id"],step+index+1)
            output=model(input_ids=current,use_cache=cached,cache=cache,logits_to_keep=1)
            chosen=output.logits[0,-1].argmax()
            token=int(chosen.item())
            if token==tokenizer.eos_token_id:break
            result.append(token)
            if cached:
                cache=output.cache
                current=chosen.reshape(1,1)
            else:
                current=torch.cat((current,chosen.reshape(1,1)),dim=-1)
    return {"text":tokenizer.decode(result,skip_special_tokens=True),"generated_tokens":len(result),"kv_cache":cached}
