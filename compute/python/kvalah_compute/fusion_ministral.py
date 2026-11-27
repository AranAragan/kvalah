"""Install opt-in Fusion FFN slots in a local, trusted one-pass Mistral/Ministral model."""

import contextvars
import re
from contextlib import contextmanager

import torch
from torch import nn

from .fusion import ExpertMLP, FFN, LoRA, Router


_request=contextvars.ContextVar("fusion_request",default=None)


@contextmanager
def request(*, weights=None, domains=None):
    """Pass a per-request adapter selection without changing another request's selection."""
    token=_request.set((None if weights is None else dict(weights),None if domains is None else tuple(domains)))
    try:
        yield
    finally:
        _request.reset(token)


class RoutedMLP(ExpertMLP):
    def forward(self, hidden):
        context=_request.get()
        if context is None:
            selection,domains=None,None
        else:
            selection,domains=context
            if selection is not None:
                selection={k:w for k,w in selection.items() if k in self.experts and k not in self.disabled}
        return super().forward(hidden,selection=selection,domains=domains)[0]


def attach_to_mistral(model, *, router=None, replacement=False):
    config=getattr(model.config,"text_config",model.config)
    if config.model_type not in ("mistral","ministral3") or (router or {}).get("mode")=="request":
        raise ValueError("unsupported Mistral text architecture or cached request-level router")
    found={}
    for name,module in list(model.named_modules()):
        match=re.search(r"(?:^|\.)layers\.(\d+)\.mlp$",name)
        if not match or not all(hasattr(module,k) for k in ("gate_proj","up_proj","down_proj")):
            continue
        i=int(match[1])
        if i in found or module.gate_proj.in_features!=config.hidden_size or module.down_proj.out_features!=config.hidden_size:
            raise ValueError("Mistral layer layout does not match the configuration")
        found[i]=(name,module)
    if set(found)!=set(range(config.num_hidden_layers)):
        raise ValueError("incomplete Mistral layer layout")
    model.requires_grad_(False)
    slots={}
    for i,(path,base) in sorted(found.items()):
        slot=RoutedMLP(base,Router(config.hidden_size,**(router or {})),replacement=replacement)
        model.set_submodule(path,slot)
        slots[i]=slot
    return slots


def insert_expert(slots, *, name, kind, layers, rank=8, alpha=16, intermediate=None, copy_base=False):
    if not layers or len(set(layers))!=len(layers) or not set(layers).issubset(slots):
        raise ValueError("invalid expert placement")
    if any(name in slots[i].experts for i in layers):
        raise ValueError("expert key already exists in one of the requested layers")
    modules={}
    for i in layers:
        slot=slots[i]
        width=slot.router.width
        if kind in ("lora","ffa-lora"):
            module=LoRA(width,width,rank,alpha,frozen_a=kind=="ffa-lora")
        elif kind=="ffn":
            if not isinstance(intermediate,int) or not 1<=intermediate<=32768:
                raise ValueError("invalid intermediate width")
            module=FFN(width,intermediate,residual=not slot.replacement)
            if copy_base:
                projections=[slot.base.gate_proj,slot.base.up_proj,slot.base.down_proj]
                if not all(isinstance(p,nn.Linear) for p in projections) or any(getattr(p.weight,"quant_state",None) is not None for p in projections):
                    raise ValueError("copy initialization requires dequantized FFN matrices")
                if not slot.replacement:
                    raise ValueError("copy initialization into a nonzero residual changes the control model")
                module.from_base([p.weight for p in projections])
        else:
            raise ValueError("unknown expert kind")
        modules[i]=module
    for i,module in modules.items():
        slots[i].add(name,module)
    return modules


class _IdentityLayer(nn.Module):
    def forward(self,hidden,**kwargs):
        return hidden


class _LoopSpan(nn.Module):
    def __init__(self,layers,gates):
        super().__init__()
        self.layers=nn.ModuleList(layers)
        self.gates=gates

    def forward(self,hidden,**kwargs):
        if any(kwargs.get(key) is not None for key in ("cache","past_key_values")) or kwargs.get("use_cache"):
            raise ValueError("HF Fusion Loop requires uncached execution")
        for iteration in range(self.gates.numel()+1):
            candidate=hidden
            for layer in self.layers:
                candidate=layer(candidate,**kwargs)
            if iteration:
                old=(hidden.float().square().mean(-1,keepdim=True)+1e-8).sqrt()
                new=(candidate.float().square().mean(-1,keepdim=True)+1e-8).sqrt()
                candidate=candidate*(old/new).clamp(max=1).to(candidate.dtype)
                hidden=torch.lerp(hidden,candidate,self.gates[iteration-1].sigmoid().to(hidden.dtype))
            else:
                hidden=candidate
        return hidden


@contextmanager
def loop_text_layers(model, *, start, end, passes,gate_parameters=None):
    """Temporarily repeat one contiguous text-layer span, sharing the original layer objects."""
    roots=[module for module in model.modules() if isinstance(getattr(module,"layers",None),nn.ModuleList) and
           len(module.layers) and isinstance(getattr(module.layers[0],"mlp",None),RoutedMLP)]
    if len(roots)!=1 or type(passes)!=int or not 1<=passes<=4 or not 0<=start<end<=len(roots[0].layers):
        raise ValueError("invalid HF Fusion Loop placement")
    root=roots[0]
    original=root.layers
    if passes==1:
        yield None
        return
    device=next(original[start].parameters()).device
    gates=gate_parameters if gate_parameters is not None else nn.Parameter(torch.full((passes-1,),-2.,device=device))
    if not isinstance(gates,nn.Parameter) or gates.shape!=(passes-1,) or gates.device!=device:
        raise ValueError("incompatible Fusion Loop gates")
    # Keep the physical ModuleList length that the HF model iterates over. Placeholders must return
    # the residual untouched. The same original layer modules are used for every iteration.
    span=_LoopSpan(list(original[start:end]),gates)
    root.layers=nn.ModuleList([*original[:start],span,*(_IdentityLayer() for _ in range(end-start-1)),*original[end:]])
    try:
        yield gates
    finally:
        root.layers=original


def load_verified_model(model_dir, expected_digest, *, router=None):
    """Reuse the Compute NF4 loader on an existing on-disk model, after verifying its digest."""
    from .backends.torch_backend import TorchBackend
    from .sidecar import verify_model

    if not re.fullmatch(r"[0-9a-f]{64}",expected_digest or ""):
        raise ValueError("pinned model digest is required")
    if verify_model({"model_dir":str(model_dir)})["files_digest"]!=expected_digest:
        raise ValueError("local backbone does not match the pinned digest")
    runtime=TorchBackend("cuda")
    runtime.load(str(model_dir),{"layers":26,"rank":8,"alpha":16,"targets":{"q_proj":[3072,4096],"v_proj":[3072,1024]}})
    model=runtime.model
    # Remove the temporary Compute wrappers. Fusion installs private per-layer slots on the same
    # frozen base and leaves all production Compute classes and checkpoint formats untouched.
    wrappers={id(w):w.base for w in runtime.mods.values()}
    for name,layer in list(model.named_modules()):
        if id(layer) in wrappers:
            model.set_submodule(name,wrappers[id(layer)])
    if hasattr(model,"gradient_checkpointing_disable"):
        model.gradient_checkpointing_disable()
    return model,attach_to_mistral(model,router=router)
