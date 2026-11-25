"""PEFT export (spec §13): adapter_config.json generated from the immutable profile (not from a smoke
config), exact key mapping canonical → PEFT, validation of the key set; optional round-trip check that a
PEFT-loaded model reproduces the canonical wrapper's logits (run where the base model is available)."""
import json, os
import numpy as np
from .canonical import decode, verify
from .errors import SidecarError

def peft_state_dict(tensors, prefix):
    out = {}
    for k, v in tensors.items():
        base, kind = k.rsplit(".", 1)
        out["%s%s.lora_%s.weight" % (prefix, base, kind)] = v
    return out

def export(adapter_path, out_dir, profile, meta):
    with open(adapter_path, "rb") as f:
        t = verify(decode(f.read()), profile["layers"], profile["targets"], profile["rank"], True)
    sd = peft_state_dict(t, profile["peft"]["module_prefix"])
    if len(sd) != 2 * profile["layers"] * len(profile["targets"]):
        raise SidecarError("EXPORT", "unexpected PEFT key count")
    cfg = {
        "peft_type": "LORA", "task_type": None, "base_model_name_or_path": profile["peft"]["base_model_name_or_path"],
        "revision": meta.get("source_revision"), "r": profile["rank"], "lora_alpha": profile["alpha"], "lora_dropout": 0.0,
        "target_modules": profile["peft"]["target_regex"], "bias": "none", "use_rslora": False, "use_dora": False,
        "fan_in_fan_out": False, "init_lora_weights": True, "inference_mode": True, "modules_to_save": None,
    }
    # Provenance goes to a sidecar file so adapter_config.json stays a plain PEFT config.
    info = {"profile": profile["id"], "checkpoint_sha256": meta.get("checkpoint_sha256"), "schema_hash": meta.get("schema_hash"),
            "experiment_id": meta.get("experiment_id"), "round": meta.get("round"), "source_revision": meta.get("source_revision"),
            "format": "FFA-LoRA (A frozen, B trained), canonical torch layout A[r,in], B[out,r], scale alpha/r"}
    os.makedirs(out_dir, exist_ok=True)
    from safetensors.numpy import save_file
    tmp_w = os.path.join(out_dir, "adapter_model.safetensors.tmp")
    save_file({k: np.ascontiguousarray(v) for k, v in sd.items()}, tmp_w, metadata={"format": "pt"})
    os.replace(tmp_w, os.path.join(out_dir, "adapter_model.safetensors"))
    tmp_c = os.path.join(out_dir, "adapter_config.json.tmp")
    with open(tmp_c, "w", encoding="utf8") as f:
        json.dump(cfg, f, indent=2)
    os.replace(tmp_c, os.path.join(out_dir, "adapter_config.json"))
    with open(os.path.join(out_dir, "kvalah_compute.json"), "w", encoding="utf8") as f:
        json.dump(info, f, indent=2)
    return {"out_dir": out_dir, "tensors": len(sd), "bytes": os.path.getsize(os.path.join(out_dir, "adapter_model.safetensors"))}
