"""Local trusted evaluation and generation of bounded Torch Fusion compositions."""

from contextlib import nullcontext

from .errors import SidecarError
from .fusion_ministral import loop_text_layers,request
from .fusion_runtime import TorchFusion,acquire,checked_path,inspect_checkpoint,read_rows,release,schema_for


def run(msg,*,permit,emit,infer=False):
    import torch
    cid=msg["id"]
    if msg.get("backend") not in ("cuda","torch-cpu-test") or msg["router"].get("mode")!="uniform":
        raise SidecarError("ARCHITECTURE","composed runtime requires Torch and uniform routing")
    backend,warm=acquire(msg,permit,emit)
    assert isinstance(backend,TorchFusion)
    model=backend.model
    specs=msg["experts"]
    if not isinstance(specs,list) or len(specs)>16 or len({x["spec"]["key"] for x in specs})!=len(specs):
        raise SidecarError("INVALID_SCHEMA","invalid composition experts")
    cache_mode={}
    try:
        backend.clear()
        for i,item in enumerate(specs,1):
            permit(cid,i)
            spec=item["spec"]
            layout=schema_for(spec,backend.width,len(backend.layers))
            file=checked_path(item["checkpoint"])
            inspect_checkpoint(file,item["sha256"],layout)
            backend.install(spec,file,layout,append=True)
        for layer,slot in backend.layers.items():
            cache_mode[layer]=slot.router.mode
            slot.router.mode="uniform"
        model.eval()
        loop=msg["loop"]
        with torch.no_grad():
            if infer:return generate(msg,model,loop,permit,len(specs))
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
                    with looped(model,loop):
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
        for layer,mode in cache_mode.items():backend.layers[layer].router.mode=mode
        backend.clear();release()


def looped(model,loop):
    return loop_text_layers(model,start=loop["start"],end=loop["end"],passes=loop["passes"]) if loop["passes"]>1 else nullcontext()


def generate(msg,model,loop,permit,step):
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
    with looped(model,loop):
        for index in range(maximum):
            permit(msg["id"],step+index+1)
            chosen=model(input_ids=inputs,use_cache=False,logits_to_keep=1).logits[0,-1].argmax()
            token=int(chosen.item())
            if token==tokenizer.eos_token_id:break
            result.append(token)
            inputs=torch.cat((inputs,chosen.reshape(1,1)),dim=-1)
    return {"text":tokenizer.decode(result,skip_special_tokens=True),"generated_tokens":len(result)}
