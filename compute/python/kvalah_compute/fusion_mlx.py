"""Native Apple Silicon backend for independent Fusion experts on the local text model."""

import json
import numpy as np

from .errors import SidecarError
from .sft import check_row


class MLXFusion:
    def __init__(self,model_dir):
        import mlx.core as mx
        import mlx.nn as nn
        self.mx,self.nn=mx,nn
        config=json.loads((model_dir/"config.json").read_text(encoding="utf-8"))
        text=config.get("text_config") or config
        if config.get("model_file") or config.get("auto_map") or text.get("ple_storage"):
            raise SidecarError("MODEL_UNVERIFIED","custom MLX model code is disabled")
        if config.get("model_type")=="mistral3":
            from mlx_vlm.utils import load_model
            self.lm=load_model(model_dir).language_model
        elif config.get("model_type")=="mistral":
            from mlx_lm.utils import load_model
            self.lm,_=load_model(model_dir)
        else:
            raise SidecarError("ARCHITECTURE","unsupported MLX Fusion backbone")
        self.lm.freeze()
        self.layers=list(self.lm.model.layers)
        if len(self.layers)!=text["num_hidden_layers"] or any(not hasattr(l,"mlp") for l in self.layers):
            raise SidecarError("ARCHITECTURE","MLX model layer layout differs from its configuration")
        self.width,self.vocab=text["hidden_size"],text["vocab_size"]
        self.base={}

    def install(self,spec,file,schema):
        from safetensors import safe_open
        mx,nn=self.mx,self.nn
        self.clear()
        self.schema=schema
        modules={}
        class Residual(nn.Module):
            def __init__(self,base,tensors,flags,scale):
                super().__init__()
                self.base=base
                self.scale=scale
                for name,t in tensors.items():setattr(self,name,mx.array(t))
                self.freeze()
                self.unfreeze(keys=[name for name,state in flags.items() if state],recurse=False,strict=True)

            def __call__(self,x):
                y=self.base(x)
                f=x.astype(mx.float32)
                if hasattr(self,"A"):
                    value=((f@self.A.T)@self.B.T)*self.scale
                else:
                    gate=nn.silu(f@self.gate.T)
                    value=(gate*(f@self.up.T))@self.down.T
                return y+value.astype(y.dtype)

        with safe_open(file,framework="numpy") as source:
            for i in spec["layers"]:
                stem=f"layers.{i}.fusion."
                keys={k:k[len(stem):].removesuffix(".weight") for k in schema if k.startswith(stem)}
                arrays={name:source.get_tensor(k) for k,name in keys.items()}
                if not all(np.isfinite(a).all() for a in arrays.values()):
                    raise SidecarError("NONFINITE","invalid MLX Fusion checkpoint")
                flags={name:schema[k][1] for k,name in keys.items()}
                scale=1 if spec["kind"]=="ffn" else spec["alpha"]/spec["rank"]
                base=self.layers[i].mlp
                self.base[i]=base
                module=Residual(base,arrays,flags,scale)
                self.layers[i].mlp=module
                modules[i]=(module,keys)
        from mlx.utils import tree_flatten
        actual=set(dict(tree_flatten(self.lm.trainable_parameters())))
        expected={f"model.layers.{i}.mlp.{name}" for i,(_,keys) in modules.items() for key,name in keys.items() if schema[key][1]}
        if actual!=expected:raise SidecarError("ARCHITECTURE","unexpected MLX trainable tensor set")
        self.mods=modules
        mx.eval(self.lm.trainable_parameters())

    def objective(self,model,ids,mask,denom):
        logits=model(ids[:,:-1])
        logits=getattr(logits,"logits",logits).astype(self.mx.float32)
        targets=ids[:,1:]
        losses=self.nn.losses.cross_entropy(logits,targets,reduction="none")
        return (losses*mask).sum()/denom

    def optimizer(self,cfg):
        import mlx.optimizers as opt
        self.lm.train()
        self.opt=(opt.AdamW if cfg["optimizer"]=="adamw" else opt.SGD)(learning_rate=cfg["lr"])
        self.clip=cfg["clip"]
        self.grad=self.nn.value_and_grad(self.lm,self.objective)

    def step(self,rows):
        from mlx.utils import tree_flatten,tree_unflatten,tree_map
        mx=self.mx
        total=sum(check_row(row,len(row["input_ids"])) for row in rows)
        accumulated=None
        nll=0.0
        for row in rows:
            ids=mx.array([row["input_ids"]],dtype=mx.int32)
            mask=mx.array([row["target_mask"][1:]],dtype=mx.float32)
            loss,gradient=self.grad(self.lm,ids,mask,total)
            mx.eval(loss,gradient)
            nll+=loss.item()*total
            accumulated=gradient if accumulated is None else tree_map(lambda a,b:a+b,accumulated,gradient)
        flat=tree_flatten(accumulated)
        norm=mx.sqrt(sum(mx.sum(v.astype(mx.float32)**2) for _,v in flat));mx.eval(norm)
        if not np.isfinite(nll) or not np.isfinite(norm.item()):raise SidecarError("NONFINITE","invalid MLX Fusion loss or gradient")
        clip=min(1.0,self.clip/(norm.item()+1e-6))
        self.opt.update(self.lm,tree_unflatten([(key,value*clip) for key,value in flat]))
        mx.eval(self.lm.trainable_parameters(),self.opt.state)
        if not all(np.isfinite(np.array(v)).all() for _,v in tree_flatten(self.lm.trainable_parameters())):
            raise SidecarError("NONFINITE","invalid MLX optimizer result")
        return nll,total

    def evaluate(self,rows):
        self.lm.eval()
        mx=self.mx
        nll=tokens=correct=0
        for row in rows:
            ids=mx.array([row["input_ids"]],dtype=mx.int32)
            logits=self.lm(ids[:,:-1]);logits=getattr(logits,"logits",logits).astype(mx.float32)
            mask=np.array(row["target_mask"][1:],dtype=bool)
            tgt=ids[:,1:]
            nll+=float(np.array(self.nn.losses.cross_entropy(logits,tgt,reduction="none"))[0,mask].sum())
            correct+=int((np.array(logits.argmax(-1))[0,mask]==np.array(tgt)[0,mask]).sum());tokens+=int(mask.sum())
        return {"nll_sum":nll,"tokens":tokens,"correct":correct}

    def arrays(self):
        return {key:np.array(getattr(module,name),dtype=np.float32) for module,keys in self.mods.values() for key,name in keys.items()}

    def clear(self):
        self.opt=None
        self.grad=None
        for i,base in self.base.items():
            self.layers[i].mlp=base
        self.base={}
        self.mods={}

    def metrics(self):
        getter=getattr(self.mx,"get_peak_memory",None)
        return {"mlx_peak_bytes":int(getter())} if getter else {}

    def release(self):
        self.clear()
        self.lm=None
        self.layers=[]
        if hasattr(self.mx,"clear_cache"):self.mx.clear_cache()
