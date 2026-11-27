"""PyTorch FFA-LoRA backend. Production: CUDA with bitsandbytes NF4 (double quant), BF16 compute where the
GPU supports it natively (RTX 5070), FP16 otherwise (RTX 2070), adapters always FP32. Test-only: CPU FP32
on a tiny random model (exercises exactly the same wrapper, masking and optimizer code).

The adapter is a small explicit wrapper rather than PEFT so the math is the canonical formula on every
backend: y = W x + (alpha/r) * B (A x), A frozen (buffer), B trainable (FP32 Parameter)."""
import inspect, re, time, os
import numpy as np
from ..errors import SidecarError

_MOD = re.compile(r"(?:^|\.)layers\.(\d+)\.self_attn\.(q_proj|v_proj)$")

def _torch():
    import torch
    return torch


def _make_wrapper(torch):
    nn = torch.nn
    class FFA(nn.Module):
        def __init__(self, base, rank, scale):
            super().__init__()
            self.base = base
            fin, fout = base.in_features, base.out_features
            dev = next(base.parameters()).device
            self.register_buffer("A", torch.zeros(rank, fin, dtype=torch.float32, device=dev), persistent=False)
            self.B = nn.Parameter(torch.zeros(fout, rank, dtype=torch.float32, device=dev))
            self.scale = float(scale)
        def forward(self, x):
            y = self.base(x)
            return y + (self.scale * ((x.to(torch.float32) @ self.A.t()) @ self.B.t())).to(y.dtype)
    return FFA

class TorchBackend:
    name = "torch"
    def __init__(self, device):
        self.device = device
        self.model = None
        self.mods = {}
        self.opt = None
        self.dtype = None

    def probe(self):
        torch = _torch()
        info = {"torch": torch.__version__, "device": self.device}
        if self.device == "cuda":
            if not torch.cuda.is_available():
                raise SidecarError("NO_GPU", "CUDA GPU not available to PyTorch")
            try:
                bf16 = torch.cuda.is_bf16_supported(including_emulation=False)
            except TypeError:
                bf16 = torch.cuda.is_bf16_supported()
            free, total = torch.cuda.mem_get_info()
            info.update(cuda=torch.version.cuda, gpu=torch.cuda.get_device_name(0), capability=list(torch.cuda.get_device_capability(0)),
                        bf16_native=bool(bf16), precision="bf16" if bf16 else "fp16", memory_free_bytes=int(free), memory_total_bytes=int(total))
            try:
                import bitsandbytes
                info["bitsandbytes"] = bitsandbytes.__version__
            except Exception as e:
                info["bitsandbytes_error"] = str(e)[:200]
        else:
            info.update(precision="fp32")
        return info

    def load(self, model_dir, task):
        torch = _torch()
        import transformers
        from transformers import AutoConfig
        torch.set_num_threads(int(os.environ.get("KVALAH_SIDECAR_THREADS", "1")))
        cfg = AutoConfig.from_pretrained(model_dir, local_files_only=True, trust_remote_code=False)
        kw = dict(local_files_only=True, trust_remote_code=False, use_safetensors=True)
        if self.device == "cuda":
            from transformers import BitsAndBytesConfig
            try:
                bf16 = torch.cuda.is_bf16_supported(including_emulation=False)
            except TypeError:
                bf16 = torch.cuda.is_bf16_supported()
            self.dtype = torch.bfloat16 if bf16 else torch.float16
            kw.update(quantization_config=BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_use_double_quant=True, bnb_4bit_compute_dtype=self.dtype),
                      device_map={"": 0}, dtype=self.dtype)
        else:
            self.dtype = torch.float32
            kw.update(dtype=torch.float32)
        if getattr(cfg, "model_type", "") == "mistral3":
            from transformers import AutoModelForImageTextToText as cls
        else:
            from transformers import AutoModelForCausalLM as cls
        if self.device == "cuda":
            torch.cuda.reset_peak_memory_stats()
        self.model = cls.from_pretrained(model_dir, **kw)
        self.model.requires_grad_(False)
        FFA = _make_wrapper(torch)
        scale = task["alpha"] / task["rank"]
        found = {}
        for name, mod in list(self.model.named_modules()):
            if "vision" in name or "multi_modal_projector" in name:
                continue
            m = _MOD.search(name)
            if not m:
                continue
            key = "layers.%s.self_attn.%s" % (m.group(1), m.group(2))
            if key in found:
                raise SidecarError("ARCHITECTURE", "duplicate target module " + key)
            exp_in, exp_out = task["targets"][m.group(2)]
            if (mod.in_features, mod.out_features) != (exp_in, exp_out):
                raise SidecarError("ARCHITECTURE", "%s is %dx%d, profile expects %dx%d" % (key, mod.in_features, mod.out_features, exp_in, exp_out))
            parent = self.model.get_submodule(name.rsplit(".", 1)[0])
            w = FFA(mod, task["rank"], scale)
            setattr(parent, name.rsplit(".", 1)[1], w)
            found[key] = w
        expected = {"layers.%d.self_attn.%s" % (i, p) for i in range(task["layers"]) for p in task["targets"]}
        if set(found) != expected:
            raise SidecarError("ARCHITECTURE", "model does not match the profile (%d of %d targets found)" % (len(set(found) & expected), len(expected)))
        self.mods = found
        trainable = [n for n, p in self.model.named_parameters() if p.requires_grad]
        if len(trainable) != len(expected) or not all(n.endswith(".B") for n in trainable):
            raise SidecarError("ARCHITECTURE", "unexpected trainable parameters")
        gc = getattr(self.model, "gradient_checkpointing_enable", None)
        if self.device == "cuda" and gc is not None:
            if "gradient_checkpointing_kwargs" in inspect.signature(gc).parameters:
                gc(gradient_checkpointing_kwargs={"use_reentrant": False})
            else:
                gc()
        self.model.train()
        return {"precision": str(self.dtype).replace("torch.", ""), "transformers": transformers.__version__, "torch": torch.__version__, "trainable_tensors": len(trainable)}

    def set_adapter(self, t):
        torch = _torch()
        with torch.no_grad():
            for k, w in self.mods.items():
                w.A.copy_(torch.from_numpy(t[k + ".A"]))
                w.B.copy_(torch.from_numpy(t[k + ".B"]))

    def make_optimizer(self, o):
        torch = _torch()
        params = [w.B for _, w in sorted(self.mods.items())]
        if o["name"] == "sgd":
            self.opt = torch.optim.SGD(params, lr=o["lr"])
        elif o["name"] == "adamw":
            self.opt = torch.optim.AdamW(params, lr=o["lr"], betas=(o["beta1"], o["beta2"]), eps=o["eps"], weight_decay=o["weight_decay"])
        else:
            raise SidecarError("INVALID_SCHEMA", "unknown optimizer")
        self.clip = float(o["clip_norm"])

    def _nll(self, row):
        torch = _torch()
        ids = torch.tensor([row["input_ids"]], dtype=torch.long, device=self.device)
        mask = torch.tensor(row["target_mask"][1:], dtype=torch.bool, device=self.device)
        out = self.model(input_ids=ids, use_cache=False)
        logits = out.logits[0, :-1]
        sel = logits[mask].to(torch.float32)
        tgt = ids[0, 1:][mask]
        return torch.nn.functional.cross_entropy(sel, tgt, reduction="sum"), sel, tgt

    def train_step(self, rows):
        torch = _torch()
        self.opt.zero_grad(set_to_none=True)
        total = sum(sum(1 for m in r["target_mask"][1:] if m) for r in rows)
        loss_sum = 0.0
        for r in rows:
            nll, _, _ = self._nll(r)
            if not torch.isfinite(nll):
                raise SidecarError("NONFINITE", "non-finite loss")
            (nll / total).backward()
            loss_sum += float(nll.detach())
        params = [w.B for _, w in sorted(self.mods.items())]
        norm = torch.nn.utils.clip_grad_norm_(params, self.clip)
        if not torch.isfinite(norm):
            # Skipped step is not counted: the task fails and is reported, never uploaded.
            raise SidecarError("NONFINITE", "non-finite gradient (overflow); step skipped, task aborted")
        self.opt.step()
        for p in params:
            if not torch.isfinite(p).all():
                raise SidecarError("NONFINITE", "non-finite adapter after step")
        self.sync()
        return loss_sum, total, float(norm)

    def sync(self):
        if self.device == "cuda":
            _torch().cuda.synchronize()

    def get_A(self):
        return {k + ".A": w.A.detach().cpu().numpy().astype(np.float32).copy() for k, w in self.mods.items()}

    def get_B(self):
        return {k + ".B": w.B.detach().cpu().numpy().astype(np.float32).copy() for k, w in self.mods.items()}

    def optimizer_state(self):
        out, meta = {}, {}
        for i, (k, w) in enumerate(sorted(self.mods.items())):
            st = self.opt.state.get(w.B, {})
            for name, v in st.items():
                if hasattr(v, "detach") and v.dim() > 0:
                    out["%s.%s" % (k, name)] = v.detach().cpu().numpy().astype(np.float32)
                else:
                    meta["%s.%s" % (k, name)] = float(v)
        return out, meta

    def load_optimizer_state(self, arrays, meta):
        torch = _torch()
        for k, w in sorted(self.mods.items()):
            st = {}
            for name in ("exp_avg", "exp_avg_sq", "momentum_buffer"):
                key = "%s.%s" % (k, name)
                if key in arrays:
                    st[name] = torch.from_numpy(arrays[key]).to(w.B.device)
            if "%s.step" % k in meta:
                st["step"] = torch.tensor(meta["%s.step" % k])
            if st:
                self.opt.state[w.B] = st

    def evaluate(self, rows):
        torch = _torch()
        self.model.eval()
        nll, n, correct = 0.0, 0, 0
        with torch.no_grad():
            for r in rows:
                s, sel, tgt = self._nll(r)
                nll += float(s)
                n += int(tgt.numel())
                correct += int((sel.argmax(-1) == tgt).sum())
        self.model.train()
        return {"nll_sum": nll, "tokens": n, "correct": correct}

    def logits(self, input_ids):
        torch = _torch()
        with torch.no_grad():
            return self.model(input_ids=torch.tensor([input_ids], device=self.device), use_cache=False).logits[0].float().cpu().numpy()

    def metrics(self):
        if self.device != "cuda":
            return {}
        torch = _torch()
        free, total = torch.cuda.mem_get_info()
        return {"peak_allocated_bytes": int(torch.cuda.max_memory_allocated()), "peak_reserved_bytes": int(torch.cuda.max_memory_reserved()),
                "device_memory_used_bytes": int(total - free), "device_memory_total_bytes": int(total)}

    def release(self):
        self.model = None
        self.mods = {}
        self.opt = None
        import gc
        gc.collect()
        if self.device == "cuda":
            _torch().cuda.empty_cache()

    def reset_task(self):
        if self.opt is not None:
            self.opt.zero_grad(set_to_none=True)
        self.opt = None
        if self.device == "cuda":
            _torch().cuda.empty_cache()
