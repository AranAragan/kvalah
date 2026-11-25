"""Canonical adapter I/O, byte-compatible with compute/protocol/safetensors.mjs (sorted keys, compact JSON
header padded to 8 bytes, little-endian F32). Parsing is bounded and rejects anything but F32 2-D tensors."""
import hashlib, json, struct, re
import numpy as np
from .errors import SidecarError

MAX_HEADER = 1 << 20
_KEY = re.compile(r"^layers\.(\d+)\.self_attn\.(q_proj|v_proj)\.(A|B)$")

def encode(tensors, metadata=None):
    header = {}
    if metadata:
        header["__metadata__"] = {str(k): str(v) for k, v in metadata.items()}
    off = 0
    names = sorted(tensors)
    for n in names:
        a = tensors[n]
        ln = a.size * 4
        header[n] = {"dtype": "F32", "shape": list(a.shape), "data_offsets": [off, off + ln]}
        off += ln
    js = json.dumps(header, separators=(",", ":"), ensure_ascii=False)
    js += " " * ((8 - (len(js.encode()) + 8) % 8) % 8)
    hb = js.encode()
    parts = [struct.pack("<Q", len(hb)), hb]
    for n in names:
        parts.append(np.ascontiguousarray(tensors[n], dtype="<f4").tobytes())
    return b"".join(parts)

def decode(buf, max_bytes=64 << 20):
    if len(buf) > max_bytes:
        raise SidecarError("TOO_LARGE", "adapter too large")
    if len(buf) < 8:
        raise SidecarError("INVALID_TENSOR", "short payload")
    n = struct.unpack("<Q", buf[:8])[0]
    if n < 2 or n > MAX_HEADER or 8 + n > len(buf):
        raise SidecarError("INVALID_TENSOR", "bad header length")
    try:
        header = json.loads(buf[8:8 + n].decode("utf8"))
    except Exception:
        raise SidecarError("INVALID_TENSOR", "header is not JSON")
    base = 8 + n
    out = {}
    spans = []
    for name, info in header.items():
        if name == "__metadata__":
            continue
        if info.get("dtype") != "F32":
            raise SidecarError("INVALID_TENSOR", "only F32 tensors are accepted")
        shape = info.get("shape")
        s, e = info.get("data_offsets", [None, None])
        if not (isinstance(shape, list) and len(shape) == 2 and all(isinstance(d, int) and d >= 0 for d in shape)):
            raise SidecarError("INVALID_TENSOR", "bad shape for " + name)
        if not (isinstance(s, int) and isinstance(e, int) and 0 <= s <= e <= len(buf) - base and e - s == shape[0] * shape[1] * 4):
            raise SidecarError("INVALID_TENSOR", "bad offsets for " + name)
        spans.append((s, e))
        out[name] = np.frombuffer(buf, dtype="<f4", count=shape[0] * shape[1], offset=base + s).reshape(shape).astype(np.float32, copy=True)
    spans.sort()
    cur = 0
    for s, e in spans:
        if s != cur:
            raise SidecarError("INVALID_TENSOR", "overlapping or sparse tensor data")
        cur = e
    if cur != len(buf) - base:
        raise SidecarError("INVALID_TENSOR", "trailing bytes")
    return out

def schema(layers, targets, rank, full=True):
    s = {}
    for i in range(layers):
        for p in sorted(targets):
            fin, fout = targets[p]
            if full:
                s[f"layers.{i}.self_attn.{p}.A"] = (rank, fin)
            s[f"layers.{i}.self_attn.{p}.B"] = (fout, rank)
    return s

def verify(tensors, layers, targets, rank, full=True):
    s = schema(layers, targets, rank, full)
    if set(s) != set(tensors):
        raise SidecarError("INVALID_TENSOR", "tensor keys differ from schema")
    for k, shp in s.items():
        a = tensors[k]
        if tuple(a.shape) != tuple(shp) or a.dtype != np.float32:
            raise SidecarError("INVALID_TENSOR", "bad tensor " + k)
        if not np.isfinite(a).all():
            raise SidecarError("NONFINITE", "non-finite values in " + k)
    return tensors

def frozen_a_hash(tensors):
    return hashlib.sha256(encode({k: v for k, v in tensors.items() if k.endswith(".A")})).hexdigest()

def sha256_file(path, chunk=1 << 22):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()
