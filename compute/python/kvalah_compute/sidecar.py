"""JSONL stdio sidecar. Commands (one JSON object per line on stdin):
  probe, verify_model, tokenize, train, evaluate, export_peft, shutdown
and, during train, the supervisor answers each permit_request with {"cmd":"permit"} or {"cmd":"stop"}.
Every reply is one JSON line on stdout; diagnostics go to stderr. The process never opens a network socket."""
import json, os, sys, time, platform, hashlib, traceback
import numpy as np
from . import __version__
from .errors import SidecarError
from .canonical import decode, encode, verify, frozen_a_hash, sha256_file
from .sft import check_row

OUT = sys.stdout
_pending = []

def emit(obj):
    OUT.write(json.dumps(obj, separators=(",", ":")) + "\n")
    OUT.flush()

def read_cmd():
    if _pending:
        return _pending.pop(0)
    line = sys.stdin.readline()
    if not line:
        raise SystemExit(0)
    try:
        m = json.loads(line)
        if not isinstance(m, dict):
            raise ValueError
        return m
    except ValueError:
        emit({"type": "error", "code": "INVALID_SCHEMA", "message": "command must be a JSON object"})
        return None

class Stopped(Exception):
    pass

def wait_permit(cid, step):
    emit({"type": "permit_request", "id": cid, "step": step})
    while True:
        m = read_cmd()
        if m is None:
            continue
        c = m.get("cmd")
        if c == "permit" and m.get("id") == cid:
            return
        if c == "stop" and m.get("id") in (cid, "*"):
            raise Stopped(str(m.get("reason") or "stopped")[:80])
        if c == "shutdown":
            raise Stopped("shutdown")
        _pending.append(m) if c not in ("permit", "stop") else None

def _atomic(path, data):
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)

def _safe_dir(p):
    if not isinstance(p, str) or not os.path.isabs(p):
        raise SidecarError("INVALID_SCHEMA", "paths must be absolute")
    return os.path.realpath(p)

def probe(msg):
    from .backends import make_backend
    info = {"python": platform.python_version(), "platform": sys.platform, "machine": platform.machine(), "sidecar": __version__}
    try:
        b = make_backend(msg.get("backend", "cuda"))
        info.update(b.probe())
        info["backend_ok"] = True
    except SidecarError as e:
        info.update(backend_ok=False, backend_error={"code": e.code, "message": str(e)})
    except Exception as e:
        info.update(backend_ok=False, backend_error={"code": "IMPORT", "message": str(e)[:300]})
    for mod in ("transformers", "safetensors", "numpy", "mlx_lm", "mlx_vlm", "peft", "accelerate"):
        try:
            info[mod] = __import__(mod).__version__
        except Exception:
            pass
    return info

def verify_model(msg):
    """Hash every file of a local model directory (no symlinks out of it, no pickle weights) and read the
    architecture fingerprint from config.json."""
    root = _safe_dir(msg["model_dir"])
    files = []
    total = 0
    for dp, dn, fn in os.walk(root):
        dn[:] = sorted(d for d in dn if not d.startswith("."))
        for n in sorted(fn):
            p = os.path.join(dp, n)
            if os.path.islink(p) and not os.path.realpath(p).startswith(root + os.sep):
                raise SidecarError("MODEL_INVALID", "symlink outside the model directory: " + n)
            if n.endswith((".bin", ".pt", ".pth", ".pkl", ".ckpt")):
                raise SidecarError("MODEL_INVALID", "pickle-based weight file refused: " + n)
            if n.startswith("."):
                continue
            size = os.path.getsize(p)
            total += size
            emit({"type": "progress", "id": msg.get("id"), "file": n, "bytes": size})
            files.append({"path": os.path.relpath(p, root).replace(os.sep, "/"), "size": size, "sha256": sha256_file(p)})
    with open(os.path.join(root, "config.json"), encoding="utf8") as f:
        cfg = json.load(f)
    text = cfg.get("text_config", cfg)
    arch = {k: text.get(k) for k in ("model_type", "hidden_size", "num_hidden_layers", "num_attention_heads", "num_key_value_heads", "head_dim", "vocab_size", "intermediate_size")}
    arch["outer_model_type"] = cfg.get("model_type")
    digest = hashlib.sha256(json.dumps(files, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return {"files": files, "files_digest": digest, "total_bytes": total, "architecture": arch,
            "architecture_fingerprint": hashlib.sha256(json.dumps(arch, sort_keys=True).encode()).hexdigest(),
            "quantization": cfg.get("quantization_config") or cfg.get("quantization")}

def _load_task(msg):
    task, paths = msg["task"], msg["paths"]
    d = _safe_dir(paths["task_dir"])
    with open(os.path.join(d, "base.safetensors"), "rb") as f:
        base = verify(decode(f.read()), task["layers"], task["targets"], task["rank"], True)
    if frozen_a_hash(base) != task["frozen_A_hash"]:
        raise SidecarError("FROZEN_A_CHANGED", "base adapter A does not match the task")
    with open(os.path.join(d, "rows.json"), encoding="utf8") as f:
        rows = json.load(f)["rows"]
    k = int(task.get("grad_accum", 1))
    if len(rows) != task["local_steps"] * k:
        raise SidecarError("INVALID_SCHEMA", "row count does not match local_steps x grad_accum")
    total = sum(check_row(r, task["max_length"]) for r in rows)
    if total != task["expected_supervised_tokens"]:
        raise SidecarError("TOKEN_MISMATCH", "supervised token count differs from the task")
    return task, d, base, rows, k

def _ckpt_paths(d):
    c = os.path.join(d, "checkpoint")
    return c, os.path.join(c, "state.json"), os.path.join(c, "B.safetensors"), os.path.join(c, "opt.safetensors")

def train(msg):
    from .backends import make_backend
    task, d, base, rows, k = _load_task(msg)
    cid = msg.get("id")
    b = make_backend(msg["backend"])
    t0 = time.perf_counter()
    info = b.load(_safe_dir(msg["paths"]["model_dir"]) if msg["paths"].get("model_dir") else "", task)
    load_s = time.perf_counter() - t0
    b.set_adapter(base)
    b.make_optimizer(task["optimizer"])
    emit({"type": "loaded", "id": cid, "model_load_s": round(load_s, 3), "info": info, **b.metrics()})
    start = 0
    cdir, cstate, cb, copt = _ckpt_paths(d)
    opt_sig = hashlib.sha256(json.dumps(task["optimizer"], sort_keys=True).encode()).hexdigest()
    if os.path.isfile(cstate):
        with open(cstate, encoding="utf8") as f:
            st = json.load(f)
        if st.get("task_id") == task["task_id"] and st.get("base") == task["base_adapter_hash"] and st.get("opt") == opt_sig:
            with open(cb, "rb") as f:
                bb = verify(decode(f.read()), task["layers"], task["targets"], task["rank"], False)
            merged = dict(base); merged.update(bb)
            b.set_adapter(merged)
            arrays = {}
            if os.path.isfile(copt):
                from safetensors.numpy import load_file
                arrays = load_file(copt)
            b.load_optimizer_state(arrays, st.get("opt_meta", {}))
            start = int(st["step"])
            emit({"type": "resumed", "id": cid, "step": start})
    tokens_total = sum(sum(1 for m in r["target_mask"][1:] if m) for r in rows[:start * k])
    compute_total = 0.0
    for step in range(start, task["local_steps"]):
        wait_permit(cid, step + 1)
        w0, c0 = time.perf_counter(), time.process_time()
        loss_sum, n, gnorm = b.train_step(rows[step * k:(step + 1) * k])
        b.sync()
        cm = (time.perf_counter() - w0) * 1000
        compute_total += cm
        tokens_total += n
        os.makedirs(cdir, exist_ok=True)
        _atomic(cb, encode(b.get_B()))
        arrays, meta = b.optimizer_state()
        if arrays:
            from safetensors.numpy import save
            _atomic(copt, save({kk: np.ascontiguousarray(v) for kk, v in arrays.items()}))
        _atomic(cstate, json.dumps({"task_id": task["task_id"], "base": task["base_adapter_hash"], "opt": opt_sig, "step": step + 1, "opt_meta": meta}).encode())
        emit({"type": "step", "id": cid, "step": step + 1, "loss": loss_sum / n, "supervised_tokens": n, "supervised_tokens_total": tokens_total,
              "grad_norm": gnorm, "compute_ms": round(cm, 3), "cpu_ms": round((time.process_time() - c0) * 1000, 3), "wall_ms": round((time.perf_counter() - w0) * 1000, 3), **b.metrics()})
    A_after = b.get_A()
    a_ok = all(np.array_equal(A_after[kk], base[kk]) for kk in A_after) and set(A_after) == {kk for kk in base if kk.endswith(".A")}
    if not a_ok:
        raise SidecarError("FROZEN_A_CHANGED", "A changed during local training")
    B = verify(b.get_B(), task["layers"], task["targets"], task["rank"], False)
    out = os.path.join(d, "update.safetensors")
    _atomic(out, encode(B))
    m = b.metrics()
    b.release()
    return {"update_path": out, "steps": task["local_steps"], "supervised_tokens": tokens_total, "a_unchanged": True,
            "timing": {"model_load_s": round(load_s, 3), "worker_compute_s": round(compute_total / 1000, 3)}, "runtime_version": "kvalah-compute-sidecar/" + __version__, "memory": m}

def evaluate(msg):
    from .backends import make_backend
    t = msg["task"]
    with open(_safe_dir(msg["adapter_path"]), "rb") as f:
        ad = verify(decode(f.read()), t["layers"], t["targets"], t["rank"], True)
    with open(_safe_dir(msg["rows_path"]), encoding="utf8") as f:
        rows = json.load(f)["rows"]
    b = make_backend(msg["backend"])
    b.load(_safe_dir(msg["model_dir"]) if msg.get("model_dir") else "", t)
    b.set_adapter(ad)
    r = b.evaluate(rows)
    b.release()
    n = max(1, r["tokens"])
    return {"nll": r["nll_sum"] / n, "perplexity": float(np.exp(r["nll_sum"] / n)), "tokens": r["tokens"], "token_accuracy": r["correct"] / n, "rows": len(rows)}

def preflight(msg):
    """Memory/compatibility preflight (spec §8.2): load the model, wrap the targets, run ONE forward+backward
    on a synthetic max_length sequence under a Governor permit, measure time and peak memory, discard
    everything. Nothing is uploaded; the adapter used here is random and thrown away."""
    from .backends import make_backend
    t = msg["task"]
    cid = msg.get("id")
    b = make_backend(msg["backend"])
    t0 = time.perf_counter()
    info = b.load(_safe_dir(msg["model_dir"]) if msg.get("model_dir") else "", t)
    load_s = time.perf_counter() - t0
    rng = np.random.default_rng(0)
    ad = {}
    for i in range(t["layers"]):
        for p, (fin, fout) in sorted(t["targets"].items()):
            k = "layers.%d.self_attn.%s" % (i, p)
            ad[k + ".A"] = rng.uniform(-1 / np.sqrt(fin), 1 / np.sqrt(fin), (t["rank"], fin)).astype(np.float32)
            ad[k + ".B"] = np.zeros((fout, t["rank"]), np.float32)
    b.set_adapter(ad)
    b.make_optimizer({"name": "sgd", "lr": 1e-12, "clip_norm": 1.0})
    n = int(t["max_length"])
    vocab = int(msg.get("vocab_hint") or 1000)
    ids = [int(x) for x in (np.arange(n) % max(2, min(vocab, 1000) - 10) + 5)]
    row = {"id": "preflight", "input_ids": ids, "target_mask": [0] * (n // 2) + [1] * (n - n // 2)}
    wait_permit(cid, 1)
    s0 = time.perf_counter()
    loss_sum, tokens, gnorm = b.train_step([row])
    b.sync()
    step_s = time.perf_counter() - s0
    m = b.metrics()
    b.release()
    return {"ok": bool(np.isfinite(loss_sum)), "model_load_s": round(load_s, 3), "step_s": round(step_s, 3), "max_length": n, "info": info, **m}

def tokenize(msg):
    from .tokenize_rows import run
    with open(_safe_dir(msg["rows_path"]), encoding="utf8") as f:
        rows = json.load(f)["rows"]
    kw = {"default_system": str(msg["default_system"])[:2000]} if msg.get("default_system") else {}
    res = run(_safe_dir(msg["model_dir"]), rows, int(msg["max_length"]), **kw)
    out = _safe_dir(msg["out_path"])
    _atomic(out, json.dumps(res, separators=(",", ":")).encode())
    return {"out_path": out, "rows": len(res["rows"]), "excluded": len(res["excluded"]), "tokenizer_hash": res["tokenizer_hash"], "chat_template_hash": res["chat_template_hash"], "tokenizer_options": res["tokenizer_options"]}

def export_peft(msg):
    from .peft_export import export
    return export(_safe_dir(msg["adapter_path"]), _safe_dir(msg["out_dir"]), msg["profile"], msg.get("meta", {}))

HANDLERS = {"preflight": preflight, "probe": probe, "verify_model": verify_model, "train": train, "evaluate": evaluate, "tokenize": tokenize, "export_peft": export_peft}

def main():
    while True:
        m = read_cmd()
        if m is None:
            continue
        c, cid = m.get("cmd"), m.get("id")
        if c == "shutdown":
            return
        if c in ("permit", "stop"):
            continue
        h = HANDLERS.get(c)
        if not h:
            emit({"type": "error", "id": cid, "code": "UNKNOWN_COMMAND", "message": "unknown command"})
            continue
        try:
            emit({"type": "result", "id": cid, "data": h(m)})
        except Stopped as e:
            emit({"type": "error", "id": cid, "code": "STOPPED", "message": str(e)})
        except SidecarError as e:
            emit({"type": "error", "id": cid, "code": e.code, "message": str(e)})
        except MemoryError:
            emit({"type": "error", "id": cid, "code": "OOM", "message": "out of memory"})
        except Exception as e:
            msg = str(e)
            code = "OOM" if "out of memory" in msg.lower() else "SIDECAR_ERROR"
            sys.stderr.write(traceback.format_exc()[-2000:])
            emit({"type": "error", "id": cid, "code": code, "message": msg[:300]})

if __name__ == "__main__":
    main()
