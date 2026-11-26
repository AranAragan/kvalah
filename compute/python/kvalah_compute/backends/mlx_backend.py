"""MLX FFA-LoRA backend (Apple Silicon; the MLX CPU build is used only by tests). Ported from v0.1:
MLX keeps the transposes Aᵀ[in,r], Bᵀ[r,out] and computes x·Aᵀ·Bᵀ·scale; only Bᵀ is trainable.
Canonical tensors are converted with exact transposes in set_adapter/get_A/get_B (round trip is bitwise).
Production model: Ministral 3 through mlx-vlm (text-only path); test model: tiny Mistral through mlx-lm."""
import inspect, re, os
import numpy as np
from ..errors import SidecarError

def _logits(out):
    # mlx_lm models return the logits array; mlx_vlm language models return an output object with .logits.
    return getattr(out, "logits", out)

class MLXBackend:
    name = "mlx"
    def __init__(self):
        self.lm = None
        self.mods = {}
        self.opt = None

    def probe(self):
        import mlx.core as mx
        info = {"mlx": getattr(mx, "__version__", "?"), "device": str(mx.default_device())}
        try:
            info["metal_available"] = bool(mx.metal.is_available())
        except Exception:
            info["metal_available"] = False
        info["precision"] = "mlx-mixed+fp32-B"
        return info

    def load(self, model_dir, task):
        import json
        import mlx.core as mx
        import mlx.nn as nn
        with open(os.path.join(model_dir, "config.json"), encoding="utf8") as f:
            cfg = json.load(f)
        if cfg.get("model_file") or cfg.get("auto_map") or (cfg.get("text_config") or {}).get("ple_storage"):
            raise SidecarError("MODEL_INVALID", "custom MLX model loading is disabled")
        if cfg.get("model_type") == "mistral3":
            # load_model takes a local Path only (no hub lookup, no processor); offline env is also enforced.
            from pathlib import Path
            from mlx_vlm.utils import load_model as load_vlm_model
            model = load_vlm_model(Path(model_dir))
            model.freeze()
            lm = model.language_model
            layers = lm.model.layers
            self.prefix = "model.layers."
        else:
            from pathlib import Path
            from mlx_lm.utils import load_model as load_lm_model
            model, _ = load_lm_model(Path(model_dir))
            model.freeze()
            lm = model
            layers = lm.model.layers
            self.prefix = "model.layers."
        if len(layers) != task["layers"]:
            raise SidecarError("ARCHITECTURE", "model has %d layers, profile expects %d" % (len(layers), task["layers"]))
        scale = task["alpha"] / task["rank"]
        r = task["rank"]
        class FixedLoRA(nn.Module):
            def __init__(self, base, fin, fout):
                super().__init__()
                self.base = base
                self.a = mx.zeros((fin, r), mx.float32)
                self.b = mx.zeros((r, fout), mx.float32)
                self.freeze()
                self.unfreeze(keys=["b"], recurse=False)
            def __call__(self, x):
                y = self.base(x)
                return y + (scale * ((x.astype(mx.float32) @ self.a) @ self.b)).astype(y.dtype)
        self.mods = {}
        for i, layer in enumerate(layers):
            att = layer.self_attn
            for p in sorted(task["targets"]):
                fin, fout = task["targets"][p]
                base = getattr(att, p)
                w = FixedLoRA(base, fin, fout)
                setattr(att, p, w)
                self.mods["layers.%d.self_attn.%s" % (i, p)] = w
        from mlx.utils import tree_flatten
        trainable = dict(tree_flatten(lm.trainable_parameters()))
        expected = {self.prefix + k[len("layers."):] + ".b" for k in self.mods}
        if set(trainable) != expected:
            raise SidecarError("ARCHITECTURE", "unexpected trainable parameters in MLX model")
        self.lm = lm
        self.mx, self.nn = mx, nn
        import mlx.core as _m
        return {"precision": "mlx-mixed+fp32-B", "mlx": getattr(_m, "__version__", "?"), "trainable_tensors": len(trainable)}

    def set_adapter(self, t):
        mx = self.mx
        for k, w in self.mods.items():
            w.a = mx.array(np.ascontiguousarray(t[k + ".A"].T))
            w.b = mx.array(np.ascontiguousarray(t[k + ".B"].T))
        mx.eval(self.lm.parameters())

    def make_optimizer(self, o):
        import mlx.optimizers as optim
        if o["name"] == "sgd":
            self.opt = optim.SGD(learning_rate=o["lr"])
        else:
            kw = dict(learning_rate=o["lr"], betas=[o["beta1"], o["beta2"]], eps=o["eps"], weight_decay=o["weight_decay"])
            if "bias_correction" in inspect.signature(optim.AdamW.__init__).parameters:
                kw["bias_correction"] = True   # match torch.optim.AdamW
            self.opt = optim.AdamW(**kw)
        self.clip = float(o["clip_norm"])
        nn = self.nn
        mx = self.mx
        def loss_fn(model, x, m, total):
            logits = _logits(model(x[:, :-1])).astype(mx.float32)
            ce = nn.losses.cross_entropy(logits, x[:, 1:], reduction="none")
            return (ce * m).sum() / total
        self.grad = nn.value_and_grad(self.lm, loss_fn)
        self.loss_fn = loss_fn

    def train_step(self, rows):
        mx = self.mx
        from mlx.utils import tree_flatten, tree_unflatten, tree_map
        total = sum(sum(1 for v in r["target_mask"][1:] if v) for r in rows)
        acc = None
        loss_sum = 0.0
        for r in rows:
            x = mx.array([r["input_ids"]], dtype=mx.int32)
            m = mx.array([r["target_mask"][1:]], dtype=mx.float32)
            l, g = self.grad(self.lm, x, m, float(total))
            mx.eval(l, g)
            if not np.isfinite(l.item()):
                raise SidecarError("NONFINITE", "non-finite loss")
            loss_sum += l.item() * total
            acc = g if acc is None else tree_map(lambda a, b: a + b, acc, g)
        flat = tree_flatten(acc)
        norm = mx.sqrt(sum(mx.sum(v.astype(mx.float32) ** 2) for _, v in flat))
        mx.eval(norm)
        n = norm.item()
        if not np.isfinite(n):
            raise SidecarError("NONFINITE", "non-finite gradient; step skipped, task aborted")
        coef = min(1.0, self.clip / (n + 1e-6))     # same rule as torch.nn.utils.clip_grad_norm_
        g = tree_unflatten([(k, v * coef) for k, v in flat])
        self.opt.update(self.lm, g)
        mx.eval(self.lm.trainable_parameters(), self.opt.state)
        for w in self.mods.values():
            if not np.isfinite(np.array(w.b)).all():
                raise SidecarError("NONFINITE", "non-finite adapter after step")
        return loss_sum, total, n

    def sync(self):
        self.mx.eval(self.lm.parameters())

    def get_A(self):
        return {k + ".A": np.ascontiguousarray(np.array(w.a, dtype=np.float32).T) for k, w in self.mods.items()}

    def get_B(self):
        return {k + ".B": np.ascontiguousarray(np.array(w.b, dtype=np.float32).T) for k, w in self.mods.items()}

    def optimizer_state(self):
        from mlx.utils import tree_flatten
        arrays, meta = {}, {}
        for k, v in tree_flatten(self.opt.state):
            a = np.array(v)
            if a.ndim == 0:
                meta[k] = float(a)
            else:
                arrays[k] = a.astype(np.float32)
        return arrays, meta

    def load_optimizer_state(self, arrays, meta):
        from mlx.utils import tree_unflatten
        mx = self.mx
        items = [(k, mx.array(v)) for k, v in arrays.items()] + [(k, mx.array(v)) for k, v in meta.items()]
        if items:
            self.opt.state = tree_unflatten(items)

    def evaluate(self, rows):
        mx, nn = self.mx, self.nn
        nll, n, correct = 0.0, 0, 0
        for r in rows:
            x = mx.array([r["input_ids"]], dtype=mx.int32)
            m = np.array(r["target_mask"][1:], dtype=bool)
            logits = _logits(self.lm(x[:, :-1])).astype(mx.float32)
            ce = np.array(nn.losses.cross_entropy(logits, x[:, 1:], reduction="none"))[0]
            pred = np.array(logits.argmax(-1))[0]
            tgt = np.array(r["input_ids"][1:])
            nll += float(ce[m].sum()); n += int(m.sum()); correct += int((pred[m] == tgt[m]).sum())
        return {"nll_sum": nll, "tokens": n, "correct": correct}

    def logits(self, input_ids):
        mx = self.mx
        return np.array(_logits(self.lm(mx.array([input_ids], dtype=mx.int32))).astype(mx.float32))[0]

    def metrics(self):
        mx = self.mx
        out = {}
        for name, fn in (("mlx_active_bytes", "get_active_memory"), ("mlx_cache_bytes", "get_cache_memory"), ("mlx_peak_bytes", "get_peak_memory")):
            f = getattr(mx, fn, None) or getattr(getattr(mx, "metal", None), fn, None)
            if f:
                try:
                    out[name] = int(f())
                except Exception:
                    pass
        return out

    def release(self):
        self.lm = None
        self.mods = {}
        try:
            self.mx.clear_cache()
        except Exception:
            pass
