"""Expert Fusion's torch reference runtime. No model code is loaded from artifact bundles."""

from dataclasses import dataclass
from math import isfinite

import torch
from torch import nn
from torch.nn import functional as F
from torch.utils.checkpoint import checkpoint


@dataclass(frozen=True)
class Loop:
    start: int = 0
    end: int = 0  # exclusive
    passes: int = 1
    sliding_window: int | None = None

    def schedule(self, layers):
        if not (1 <= self.passes <= 4 and 0 <= self.start <= self.end <= layers):
            raise ValueError("invalid loop bounds")
        if self.passes > 1 and self.end == self.start:
            raise ValueError("a repeated block needs at least one layer")
        if self.sliding_window is not None and self.sliding_window < 1:
            raise ValueError("invalid sliding window")
        return ([(0, i) for i in range(self.start)]
                + [(p, i) for p in range(self.passes) for i in range(self.start, self.end)]
                + [(0, i) for i in range(self.end, layers)])


class LoRA(nn.Module):
    def __init__(self, width, output, rank, alpha, *, frozen_a=True):
        super().__init__()
        if not 1 <= rank <= min(width, output) or not isfinite(alpha) or alpha <= 0:
            raise ValueError("invalid adapter rank or scale")
        self.A = nn.Parameter(torch.empty(rank, width), requires_grad=not frozen_a)
        self.B = nn.Parameter(torch.zeros(output, rank))
        nn.init.kaiming_uniform_(self.A, a=5 ** 0.5)
        self.scale = alpha / rank

    def forward(self, x):
        return (F.linear(F.linear(x.to(self.A.dtype), self.A), self.B) * self.scale).to(x.dtype)


class FFN(nn.Module):
    def __init__(self, width, intermediate, *, residual=False):
        super().__init__()
        self.gate = nn.Linear(width, intermediate, bias=False)
        self.up = nn.Linear(width, intermediate, bias=False)
        self.down = nn.Linear(intermediate, width, bias=False)
        self.adapter = None
        if residual:
            nn.init.zeros_(self.down.weight)

    def from_base(self, base):
        for destination, origin in zip((self.gate, self.up, self.down), base, strict=True):
            if origin.shape != destination.weight.shape:
                raise ValueError("incompatible FFN shape")
        with torch.no_grad():
            for destination, origin in zip((self.gate, self.up, self.down), base, strict=True):
                destination.weight.copy_(origin)
        return self

    def train_parts(self, mode, rank=4, alpha=8):
        if mode not in ("full", "down", "lora"):
            raise ValueError("unknown FFN training mode")
        self.requires_grad_(mode == "full")
        self.down.requires_grad_(mode != "lora")
        if mode == "lora":
            self.adapter = LoRA(self.down.in_features, self.down.out_features, rank, alpha).to(self.down.weight.device)

    def forward(self, x):
        x = x.to(self.gate.weight.dtype)
        hidden = F.silu(self.gate(x)) * self.up(x)
        out = self.down(hidden)
        return out if self.adapter is None else out + self.adapter(hidden)


class Router(nn.Module):
    def __init__(self, width, *, mode="token", top_k=1, temperature=1.0, capacity=None, domain_strength=1.0):
        super().__init__()
        if mode not in ("static", "domain", "request", "token", "domain-informed", "uniform", "random"):
            raise ValueError("unknown router")
        if top_k not in (1, 2, 4) or not isfinite(temperature) or temperature <= 0:
            raise ValueError("invalid router parameters")
        if capacity is not None and (not isinstance(capacity, int) or capacity < 1):
            raise ValueError("invalid capacity")
        self.width, self.mode, self.top_k = width, mode, top_k
        self.temperature, self.capacity, self.domain_strength = temperature, capacity, domain_strength
        self.rows = nn.ParameterDict()

    def add(self, key, device):
        if key in self.rows:
            raise ValueError("expert already installed")
        row = nn.Parameter(torch.empty(self.width, device=device))
        nn.init.normal_(row, std=self.width ** -0.5)
        self.rows[key] = row

    def forward(self, hidden, keys, domains=None, *, request=None, generator=None):
        if not keys:
            raise ValueError("router requires at least one enabled expert")
        batch, length, _ = hidden.shape
        if self.mode in ("domain", "domain-informed") and domains is None:
            raise ValueError("domain router requires one label per request")
        if self.mode in ("static", "uniform", "random", "domain"):
            logits = hidden.new_zeros((batch, length, len(keys)), dtype=torch.float32)
            if self.mode == "random":
                logits = torch.rand(logits.shape, device=logits.device, generator=generator)
        else:
            x = (request if request is not None else hidden[:, :1]) if self.mode == "request" else hidden
            weights = torch.stack([self.rows[k] for k in keys])
            logits = F.linear(x.to(weights.dtype), weights).float().expand(-1, length, -1)
        if domains is not None and self.mode in ("domain", "domain-informed"):
            if len(domains) != batch:
                raise ValueError("incorrect number of domain labels")
            bias = logits.new_tensor([[float(d == k) for k in keys] for d in domains])
            if self.mode == "domain" and not bias.sum(dim=-1).all():
                raise ValueError("domain has no enabled expert")
            logits = logits + self.domain_strength * bias[:, None, :]
        probs = (logits / self.temperature).softmax(-1)
        limit = len(keys) if self.mode == "uniform" else min(self.top_k, len(keys))
        idx = torch.argsort(probs, dim=-1, descending=True, stable=True)[..., :limit]
        chosen = probs.gather(-1, idx)
        # Apply the cap per sequence in causal order. Rejected assignments use the shared base.
        if self.capacity is not None and self.training:
            assignments = F.one_hot(idx, num_classes=len(keys))
            occupancy = assignments.sum(dim=-2).cumsum(dim=1).unsqueeze(-2)
            chosen = chosen * ((assignments * occupancy).sum(-1) <= self.capacity)
        denominator = chosen.sum(-1, keepdim=True).clamp_min(torch.finfo(chosen.dtype).tiny)
        hard = chosen / denominator
        # A normalized Top-1 coefficient is exactly one and has zero derivative. Use the
        # selected softmax probabilities as a straight-through surrogate during training.
        weights = hard.detach() + (chosen - chosen.detach()) if self.training else hard
        counts = torch.zeros_like(probs).scatter_add(-1, idx, (chosen > 0).to(probs.dtype))
        entropy = -(probs * probs.clamp_min(1e-30).log()).sum(-1).mean()
        balance = len(keys) * (probs.mean((0, 1)) * counts.mean((0, 1))).sum() / limit
        z_loss = (logits.logsumexp(-1) ** 2).mean()
        return idx, weights, {"keys": keys, "counts": counts.sum((0, 1)), "entropy": entropy,
                              "balance_loss": balance, "z_loss": z_loss, "logits": logits}


class ExpertMLP(nn.Module):
    def __init__(self, base, router, *, replacement=False):
        super().__init__()
        self.base = base.requires_grad_(False)
        self.router = router
        self.experts = nn.ModuleDict()
        self.disabled = set()
        self.fixed = None
        self.replacement = replacement

    def add(self, name, expert):
        if not name.isidentifier() or name in self.experts or hasattr(self.experts, name):
            raise ValueError("invalid or duplicate expert key")
        device = next(self.base.parameters()).device
        self.router.add(name, device)
        self.experts[name] = expert.to(device)

    def forward(self, hidden, *, domains=None, request=None, selection=None):
        base = self.base(hidden)
        keys = [k for k in self.experts if k not in self.disabled]
        fixed = self.fixed if selection is None else selection
        if fixed is not None:
            if not set(fixed).issubset(keys) or any(not isfinite(w) or w < 0 for w in fixed.values()):
                raise ValueError("invalid fixed expert weights")
            if not fixed:
                return base, None
            total = sum(fixed.values())
            if total <= 0:
                raise ValueError("fixed weights sum to zero")
            mixed = sum((self.experts[k](hidden).to(base.dtype) * (w / total)
                         for k, w in fixed.items()), torch.zeros_like(base))
            return (mixed if self.replacement else base + mixed), None
        if not keys:
            return base, None
        idx, weights, stats = self.router(hidden, keys, domains, request=request)
        src, dst = hidden.flatten(0, 1), base.flatten(0, 1)
        additions = torch.zeros_like(dst)
        for i, name in enumerate(keys):
            rows, slots = torch.where((idx == i).flatten(0, 1) & (weights.detach() != 0).flatten(0, 1))
            if rows.numel():
                value = self.experts[name](src.index_select(0, rows)).to(dst.dtype)
                scale = weights.flatten(0, 1)[rows, slots, None].to(dst.dtype)
                additions = additions.index_add(0, rows, value * scale)
        if self.replacement:
            fallback = (weights.detach().sum(-1, keepdim=True) == 0).flatten(0, 1).to(dst.dtype)
            dst = dst * fallback
        return (dst + additions).reshape_as(base), stats


class Block(nn.Module):
    def __init__(self, width, heads, intermediate, *, router):
        super().__init__()
        if width % heads:
            raise ValueError("attention width must be divisible by head count")
        self.heads = heads
        self.attn_norm = nn.LayerNorm(width)
        self.ffn_norm = nn.LayerNorm(width)
        self.qkv = nn.Linear(width, width * 3, bias=False)
        self.proj = nn.Linear(width, width, bias=False)
        self.ffn = ExpertMLP(FFN(width, intermediate), Router(width, **router))
        self.requires_grad_(False)

    def forward(self, x, *, previous=None, window=None, domains=None, request=None):
        batch, length, width = x.shape
        def split(part):
            return part.reshape(batch, length, self.heads, width // self.heads).transpose(1, 2)
        q, k, v = map(split, self.qkv(self.attn_norm(x)).chunk(3, dim=-1))
        start = 0 if previous is None else previous[0].shape[2]
        if previous is not None:
            k, v = torch.cat((previous[0], k), dim=2), torch.cat((previous[1], v), dim=2)
        queries = torch.arange(start, start + length, device=x.device)[:, None]
        keys = torch.arange(k.shape[2], device=x.device)[None, :]
        mask = keys <= queries
        if window is not None:
            mask &= keys > queries - window
        attn = F.scaled_dot_product_attention(q, k, v, attn_mask=mask)
        x = x + self.proj(attn.transpose(1, 2).reshape(batch, length, width))
        expert, stats = self.ffn(self.ffn_norm(x), domains=domains, request=request)
        return x + expert, (k, v), stats


class FusionModel(nn.Module):
    def __init__(self, vocab=32, width=24, heads=4, layers=4, intermediate=48, context=256, *, loop=Loop(),
                 router=None, activation_checkpointing=False):
        super().__init__()
        self.schedule = loop.schedule(layers)
        self.loop = loop
        self.config = dict(vocab=vocab, width=width, heads=heads, layers=layers, intermediate=intermediate,
                           context=context, router=router or {})
        self.tokens = nn.Embedding(vocab, width)
        self.positions = nn.Embedding(context, width)
        self.blocks = nn.ModuleList(Block(width, heads, intermediate, router=router or {}) for _ in range(layers))
        self.norm = nn.LayerNorm(width)
        self.output = nn.Linear(width, vocab, bias=False)
        self.requires_grad_(False)
        self.loop_gates = nn.Parameter(torch.full((loop.passes - 1,), -2.0))
        self.activation_checkpointing = activation_checkpointing

    def forward(self, tokens, *, cache=None, use_cache=False, domains=None):
        if cache is not None and not use_cache:
            raise ValueError("received a cache with caching disabled")
        if self.training and use_cache:
            raise ValueError("training requires the cache to be disabled")
        if cache is not None and set(cache["kv"]) != set(self.schedule):
            raise ValueError("cache does not match the execution schedule")
        start = 0 if cache is None else cache["length"]
        length = tokens.shape[1]
        if length < 1 or start + length > self.positions.num_embeddings:
            raise ValueError("input exceeds model context")
        x = self.tokens(tokens) + self.positions(torch.arange(start, start + length, device=tokens.device))
        request = x[:, :1] if cache is None else cache["request"]
        output_cache, routes = {}, []
        for iteration, i in self.schedule:
            key = iteration, i
            block = self.blocks[i]
            previous = None if cache is None else cache["kv"][key]
            def run(state, block=block, previous=previous):
                return block(state, previous=previous, window=self.loop.sliding_window, domains=domains, request=request)
            step, kv, stats = checkpoint(run, x, use_reentrant=False) if self.training and self.activation_checkpointing else run(x)
            # Repeated updates interpolate between the old state and an RMS-bounded candidate.
            if iteration:
                old_rms = (x.float().square().mean(-1, keepdim=True) + 1e-8).sqrt()
                new_rms = (step.float().square().mean(-1, keepdim=True) + 1e-8).sqrt()
                step = step * (old_rms / new_rms).clamp(max=1).to(step.dtype)
                x = torch.lerp(x, step, self.loop_gates[iteration - 1].sigmoid().to(x.dtype))
            else:
                x = step
            if use_cache:
                output_cache[key] = tuple(item.detach() for item in kv)
            if stats is not None:
                routes.append(stats)
        result_cache = {"length": start + length, "kv": output_cache, "request": request.detach()} if use_cache else None
        return self.output(self.norm(x)), result_cache, routes


def supervised_loss(logits, tokens, target_mask):
    if target_mask.dtype != torch.bool or target_mask.shape != tokens.shape or not target_mask[:, 1:].any():
        raise ValueError("no valid supervised targets")
    mask = target_mask[:, 1:]
    return F.cross_entropy(logits[:, :-1][mask].float(), tokens[:, 1:][mask]), int(mask.sum())
