"""JSONL stdio sidecar. Commands (one JSON object per line on stdin):
  probe, verify_model, tokenize, train, evaluate, export_peft, shutdown
and, during train, the supervisor answers each permit_request with {"cmd":"permit"} or {"cmd":"stop"}.
Every reply is one JSON line on stdout; diagnostics go to stderr. The process never opens a network socket."""
import json, os, sys, time, platform, hashlib, traceback, re, shutil, uuid
import numpy as np
from . import __version__
from .errors import SidecarError
from .canonical import decode, encode, verify, frozen_a_hash, sha256_file
from .sft import check_row

OUT = sys.stdout
_pending = []
_resident = None


def release_model(_msg=None):
    _release_legacy()
    if __package__+".fusion_runtime" in sys.modules:
        sys.modules[__package__+".fusion_runtime"].release()
    return {"resident": False}

def _release_legacy():
    global _resident
    if _resident is not None:
        _, model, _ = _resident
        _resident = None
        model.release()

def emit(obj):
    OUT.write(json.dumps(obj, separators=(",", ":")) + "\n")
    OUT.flush()

def read_cmd(use_pending=True):
    if use_pending and _pending:
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
        m = read_cmd(use_pending=False)
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
        if any(os.path.islink(os.path.join(dp, child)) for child in dn):
            raise SidecarError("MODEL_INVALID", "linked model directories are not supported")
        for n in sorted(fn):
            p = os.path.join(dp, n)
            if os.path.islink(p):
                raise SidecarError("MODEL_INVALID", "linked model files are not supported")
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

def _sync_dir(directory):
    if os.name == "nt":
        return
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _checkpoint_names(directory):
    try:
        with open(os.path.join(directory, "CURRENT"), encoding="utf8") as f:
            names = json.load(f)
        if not isinstance(names, list):
            return []
        return [n for n in names[:2] if isinstance(n, str) and re.fullmatch(r"generation-[0-9a-f]{32}", n)]
    except (FileNotFoundError, ValueError):
        return []


def _save_checkpoint(directory, previous, task, backend, step, adapter, arrays, opt_meta):
    from safetensors.numpy import save
    os.makedirs(directory, exist_ok=True)
    generation = "generation-" + uuid.uuid4().hex
    folder = os.path.join(directory, generation)
    os.mkdir(folder)
    adapter_bytes = encode(adapter)
    optimizer_bytes = save({name: np.ascontiguousarray(value) for name, value in arrays.items()})
    _atomic(os.path.join(folder, "B.safetensors"), adapter_bytes)
    _atomic(os.path.join(folder, "opt.safetensors"), optimizer_bytes)
    state = {"task": task, "backend": backend, "step": step, "opt_meta": opt_meta,
             "adapter_hash": hashlib.sha256(adapter_bytes).hexdigest(), "optimizer_hash": hashlib.sha256(optimizer_bytes).hexdigest()}
    _atomic(os.path.join(folder, "state.json"), json.dumps(state).encode())
    _sync_dir(folder)
    _atomic(os.path.join(directory, "CURRENT"), json.dumps([generation] + ([previous] if previous else [])).encode())
    _sync_dir(directory)
    for name in os.listdir(directory):
        if name not in (generation, previous) and re.fullmatch(r"generation-[0-9a-f]{32}", name):
            shutil.rmtree(os.path.join(directory, name), ignore_errors=True)
    return generation


def _restore_checkpoint(directory, task, backend, base, model, cid):
    from safetensors.numpy import load
    for generation in _checkpoint_names(directory):
        folder = os.path.join(directory, generation)
        try:
            with open(os.path.join(folder, "state.json"), encoding="utf8") as f:
                state = json.load(f)
            step = state["step"]
            if state["task"] != task or state["backend"] != backend or type(step) is not int or not 1 <= step <= task["local_steps"]:
                raise ValueError("checkpoint belongs to a different assignment")
            with open(os.path.join(folder, "B.safetensors"), "rb") as f:
                adapter_bytes = f.read()
            with open(os.path.join(folder, "opt.safetensors"), "rb") as f:
                optimizer_bytes = f.read()
            if hashlib.sha256(adapter_bytes).hexdigest() != state["adapter_hash"] or hashlib.sha256(optimizer_bytes).hexdigest() != state["optimizer_hash"]:
                raise ValueError("checkpoint hash mismatch")
            bb = verify(decode(adapter_bytes), task["layers"], task["targets"], task["rank"], False)
            arrays = load(optimizer_bytes)
            if any(a.dtype.kind not in "fiu" or not np.isfinite(a).all() for a in arrays.values()):
                raise ValueError("invalid optimizer state")
            model.set_adapter({**base, **bb})
            model.make_optimizer(task["optimizer"])
            model.load_optimizer_state(arrays, state["opt_meta"])
        except Exception as error:
            emit({"type": "checkpoint_rejected", "id": cid, "reason": type(error).__name__})
            continue
        emit({"type": "resumed", "id": cid, "step": step})
        return step, generation
    model.set_adapter(base)
    model.make_optimizer(task["optimizer"])
    return 0, None


def train(msg):
    from .backends import make_backend
    global _resident
    task, d, base, rows, k = _load_task(msg)
    cid = msg.get("id")
    wait_permit(cid, 0)
    model_dir = msg["paths"].get("model_dir")
    warm = msg.get("retain_model") is True
    key = (msg["backend"], os.path.realpath(model_dir) if model_dir else None, task.get("model_files_digest"),
           task.get("profile"), task["layers"], task["rank"], task["alpha"], json.dumps(task["targets"], sort_keys=True))
    hit = warm and _resident is not None and _resident[0] == key
    if not hit:
        release_model()
    if task.get("model_files_digest") and not hit:
        verified = verify_model({"model_dir": model_dir})
        if verified["files_digest"] != task["model_files_digest"]:
            raise SidecarError("HASH_MISMATCH", "model files differ from the signed task")
        wait_permit(cid, 0)
    t0 = time.perf_counter()
    if hit:
        _, b, info = _resident
    else:
        b = make_backend(msg["backend"])
        info = b.load(_safe_dir(model_dir) if model_dir else "", task)
        if warm:
            _resident = (key, b, info)
    load_s = 0 if hit else time.perf_counter() - t0
    emit({"type": "loaded", "id": cid, "model_load_s": round(load_s, 3), "cache_hit": hit, "info": info, **b.metrics()})
    cdir = os.path.join(d, "checkpoint")
    start, generation = _restore_checkpoint(cdir, task, msg["backend"], base, b, cid)
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
        arrays, meta = b.optimizer_state()
        generation = _save_checkpoint(cdir, generation, task, msg["backend"], step + 1, b.get_B(), arrays, meta)
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
    if warm and hasattr(b, "reset_task"):
        b.reset_task()
    if not warm:
        b.release()
    return {"update_path": out, "steps": task["local_steps"], "supervised_tokens": tokens_total, "a_unchanged": True,
            "timing": {"model_load_s": round(load_s, 3), "worker_compute_s": round(compute_total / 1000, 3)}, "runtime_version": "kvalah-compute-sidecar/" + __version__, "memory": m}

def evaluate(msg):
    from .backends import make_backend
    t = msg["task"]
    cid = msg.get("id")
    wait_permit(cid, 0)
    if msg.get("model_files_digest") and verify_model(msg)["files_digest"] != msg["model_files_digest"]:
        raise SidecarError("HASH_MISMATCH", "evaluator files differ from the experiment snapshot")
    with open(_safe_dir(msg["adapter_path"]), "rb") as f:
        ad = verify(decode(f.read()), t["layers"], t["targets"], t["rank"], True)
    with open(_safe_dir(msg["rows_path"]), encoding="utf8") as f:
        rows = json.load(f)["rows"]
    b = make_backend(msg["backend"])
    wait_permit(cid, 0)
    b.load(_safe_dir(msg["model_dir"]) if msg.get("model_dir") else "", t)
    b.set_adapter(ad)
    def guarded_rows():
        for i, row in enumerate(rows, 1):
            wait_permit(cid, i)
            yield row
    try:
        r = b.evaluate(guarded_rows())
    finally:
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
    wait_permit(cid, 0)
    if msg.get("model_files_digest") and verify_model(msg)["files_digest"] != msg["model_files_digest"]:
        raise SidecarError("HASH_MISMATCH", "model files changed since verification")
    wait_permit(cid, 0)
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
    wait_permit(msg.get("id"), 0)
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

def fusion_operation(msg):
    from .fusion_runtime import run
    _release_legacy()
    return run(msg,permit=wait_permit,emit=emit,evaluation=msg["cmd"]=="fusion_evaluate")

def composed_operation(msg):
    from .fusion_composed import run
    _release_legacy()
    return run(msg,permit=wait_permit,emit=emit,infer=msg["cmd"]=="fusion_generate",fit=msg["cmd"]=="fusion_fit")

HANDLERS = {"preflight": preflight, "probe": probe, "verify_model": verify_model, "train": train, "evaluate": evaluate, "tokenize": tokenize, "export_peft": export_peft, "release_model": release_model}
HANDLERS.update(fusion_train=fusion_operation,fusion_evaluate=fusion_operation)
HANDLERS.update(fusion_compare=composed_operation,fusion_generate=composed_operation,fusion_fit=composed_operation)

def main():
    while True:
        m = read_cmd()
        if m is None:
            continue
        c, cid = m.get("cmd"), m.get("id")
        if c == "shutdown":
            release_model()
            return
        if c in ("permit", "stop"):
            continue
        h = HANDLERS.get(c)
        if not h:
            emit({"type": "error", "id": cid, "code": "UNKNOWN_COMMAND", "message": "unknown command"})
            continue
        try:
            if c in ("preflight","train","evaluate") and __package__+".fusion_runtime" in sys.modules:
                sys.modules[__package__+".fusion_runtime"].release()
            emit({"type": "result", "id": cid, "data": h(m)})
        except Stopped as e:
            release_model()
            emit({"type": "error", "id": cid, "code": "STOPPED", "message": str(e)})
        except SidecarError as e:
            release_model()
            emit({"type": "error", "id": cid, "code": e.code, "message": str(e)})
        except MemoryError:
            release_model()
            emit({"type": "error", "id": cid, "code": "OOM", "message": "out of memory"})
        except Exception as e:
            release_model()
            msg = str(e)
            code = "OOM" if "out of memory" in msg.lower() else "SIDECAR_ERROR"
            sys.stderr.write(traceback.format_exc()[-2000:])
            emit({"type": "error", "id": cid, "code": code, "message": msg[:300]})

if __name__ == "__main__":
    main()
