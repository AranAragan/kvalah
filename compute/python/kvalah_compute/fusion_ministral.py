"""Install opt-in Fusion FFN slots in a local, trusted one-pass Mistral/Ministral model."""

import contextvars
import re
from contextlib import contextmanager

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
