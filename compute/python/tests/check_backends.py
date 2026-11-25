"""Backend correctness checks on tiny random models (CPU, seconds, no downloads). Prints one JSON report and
exits non-zero on failure. Run by test/compute2-python.test.mjs.
  M03  MLX vs PyTorch: same weights, same adapter -> same logits / loss / one optimizer step (if mlx present)
  M04  PEFT export: PeftModel logits == canonical FFA wrapper logits
  E01  SFT mask: only assistant spans (+EOS) are targets; logits[t-1] predicts token t
  ARCH Mistral3 (ministral3 text) architecture: exactly the 2*L language-model q/v projections are wrapped,
       the vision tower is never touched, and the PEFT regex matches exactly the same modules.
They prove code paths, not training quality (random weights)."""
import json, os, sys, tempfile, shutil
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
os.environ.setdefault("KVALAH_COMPUTE_TEST", "1")
from kvalah_compute.canonical import decode, encode
from tiny import build as build_tiny

REPORT = {"checks": {}}
def check(name, ok, **info):
    REPORT["checks"][name] = {"ok": bool(ok), **info}

def tiny_mistral3(out):
    import torch
    from transformers import AutoModelForImageTextToText, Mistral3Config
    text = dict(model_type="ministral3", hidden_size=64, intermediate_size=128, num_hidden_layers=2, num_attention_heads=4, num_key_value_heads=2,
                head_dim=16, vocab_size=300, max_position_embeddings=262144, rms_norm_eps=1e-5, tie_word_embeddings=True, hidden_act="silu", sliding_window=None,
                rope_parameters={"beta_fast": 32.0, "beta_slow": 1.0, "factor": 16.0, "llama_4_scaling_beta": 0.1, "mscale": 1.0, "mscale_all_dim": 1.0,
                                 "original_max_position_embeddings": 16384, "rope_theta": 1000000.0, "rope_type": "yarn", "type": "yarn"})
    vision = dict(model_type="pixtral", hidden_size=32, intermediate_size=64, num_hidden_layers=1, num_attention_heads=2, head_dim=16, image_size=56, patch_size=14,
                  num_channels=3, hidden_act="silu", rope_parameters={"rope_theta": 10000.0, "rope_type": "default"})
    cfg = Mistral3Config(text_config=text, vision_config=vision, image_token_index=10, multimodal_projector_bias=False, projector_hidden_act="gelu",
                         spatial_merge_size=2, vision_feature_layer=-1, tie_word_embeddings=True)
    torch.manual_seed(0)
    m = AutoModelForImageTextToText.from_config(cfg)
    m.save_pretrained(out)
    return out

TASK = {"layers": 2, "targets": {"q_proj": [64, 64], "v_proj": [64, 32]}, "rank": 4, "alpha": 8}
def adapter(seed=1, bscale=0.02):
    rng = np.random.default_rng(seed)
    t = {}
    for i in range(2):
        for p, (fin, fout) in sorted(TASK["targets"].items()):
            k = "layers.%d.self_attn.%s" % (i, p)
            t[k + ".A"] = rng.uniform(-1 / np.sqrt(fin), 1 / np.sqrt(fin), (4, fin)).astype(np.float32)
            t[k + ".B"] = (rng.standard_normal((fout, 4)) * bscale).astype(np.float32)
    return t

def parity(model_dir, label):
    from kvalah_compute.backends.torch_backend import TorchBackend
    tb = TorchBackend("cpu"); tb.load(model_dir, TASK)
    found = sorted(tb.mods)
    check(label + ".torch_targets", found == sorted("layers.%d.self_attn.%s" % (i, p) for i in range(2) for p in ("q_proj", "v_proj")), found=found)
    ad = adapter()
    tb.set_adapter(ad)
    ids = [2, 11, 12, 13, 14, 15, 16, 17, 3]
    row = {"id": "r", "input_ids": ids, "target_mask": [0, 0, 0, 0, 1, 1, 1, 1, 1]}
    lt = np.asarray(tb.logits(ids), dtype=np.float64)
    try:
        import mlx.core  # noqa
        from kvalah_compute.backends.mlx_backend import MLXBackend
    except Exception as e:
        check(label + ".mlx_parity", True, skipped="mlx not installed: %s" % e)
        return
    mb = MLXBackend(); mb.load(model_dir, TASK); mb.set_adapter(ad)
    lm = np.asarray(mb.logits(ids), dtype=np.float64)
    d = float(np.max(np.abs(lt - lm)))
    check(label + ".mlx_logits", d < 1e-4, max_abs_diff=d, logit_scale=float(np.max(np.abs(lt))))
    opt = {"name": "sgd", "lr": 0.05, "clip_norm": 1.0}
    tb.make_optimizer(opt); mb.make_optimizer(opt)
    l1, n1, g1 = tb.train_step([row]); l2, n2, g2 = mb.train_step([row])
    check(label + ".mlx_loss", abs(l1 / n1 - l2 / n2) < 1e-4 and n1 == n2 == 5, torch=l1 / n1, mlx=l2 / n2, tokens=n1)
    check(label + ".mlx_gradnorm", abs(g1 - g2) / max(g1, 1e-12) < 1e-3, torch=g1, mlx=g2)
    Bt, Bm = tb.get_B(), mb.get_B()
    dd = max(float(np.max(np.abs(Bt[k] - Bm[k]))) for k in Bt)
    delta = max(float(np.max(np.abs(Bt[k] - ad[k]))) for k in Bt)
    check(label + ".mlx_step", dd < 1e-5 and delta > 0, max_abs_diff=dd, delta_scale=delta)
    At, Am = tb.get_A(), mb.get_A()
    check(label + ".A_frozen", all(np.array_equal(At[k], ad[k]) and np.array_equal(Am[k], ad[k]) for k in At))

def peft_roundtrip(model_dir, profile, label):
    import torch
    from transformers import AutoConfig
    from kvalah_compute.backends.torch_backend import TorchBackend
    from kvalah_compute.peft_export import export
    from peft import PeftModel
    ad = adapter(3, 0.05)
    d = tempfile.mkdtemp()
    with open(os.path.join(d, "a.safetensors"), "wb") as f:
        f.write(encode(ad))
    export(os.path.join(d, "a.safetensors"), os.path.join(d, "peft"), profile, {})
    tb = TorchBackend("cpu"); tb.load(model_dir, TASK); tb.set_adapter(ad); tb.model.eval()
    ids = [2, 11, 12, 13, 14, 3]
    ref = np.asarray(tb.logits(ids), dtype=np.float64)
    cfg = AutoConfig.from_pretrained(model_dir)
    if cfg.model_type == "mistral3":
        from transformers import AutoModelForImageTextToText as cls
    else:
        from transformers import AutoModelForCausalLM as cls
    base = cls.from_pretrained(model_dir, dtype=torch.float32)
    base0 = base(input_ids=torch.tensor([ids])).logits[0].detach().numpy().astype(np.float64)
    pm = PeftModel.from_pretrained(base, os.path.join(d, "peft")); pm.eval()
    got = pm(input_ids=torch.tensor([ids])).logits[0].detach().numpy().astype(np.float64)
    wrapped = [n for n, _ in pm.named_modules() if n.endswith(("q_proj", "v_proj")) and hasattr(_, "lora_A")]
    diff = float(np.max(np.abs(got - ref)))
    check(label + ".peft_logits", diff < 1e-4, max_abs_diff=diff, adapter_effect=float(np.max(np.abs(ref - base0))), wrapped_modules=len(wrapped))
    check(label + ".peft_no_vision", not any("vision" in n for n in wrapped) and len(wrapped) == 4, wrapped=wrapped)
    shutil.rmtree(d)

def masks(model_dir):
    from kvalah_compute.tokenize_rows import run
    rows = [{"id": "m1", "messages": [{"role": "user", "content": "hello there"}, {"role": "assistant", "content": "general kenobi"},
                                       {"role": "user", "content": "again"}, {"role": "assistant", "content": "yes indeed"}]}]
    res = run(model_dir, rows, 256)
    r = res["rows"][0]
    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(model_dir)
    tgt = [tok.convert_ids_to_tokens(i) for i, m in zip(r["input_ids"], r["target_mask"]) if m]
    check("E01.assistant_only_targets", tgt == ["general", "kenobi", "</s>", "yes", "indeed", "</s>"] and r["target_mask"][0] == 0, targets=tgt)

def main():
    tmp = tempfile.mkdtemp()
    try:
        texts = ["hello there", "general kenobi", "again", "yes indeed"]
        m1 = build_tiny(os.path.join(tmp, "mistral"), texts + ["a b c d e f g"])
        masks(m1)
        parity(m1, "mistral")
        from kvalah_compute.canonical import decode as _d  # noqa
        tiny_profile = {"id": "tiny-test-ffa-r4", "layers": 2, "targets": TASK["targets"], "rank": 4, "alpha": 8,
                        "peft": {"base_model_name_or_path": "local/tiny", "module_prefix": "base_model.model.model.", "target_regex": r"model\.layers\.\d+\.self_attn\.(q_proj|v_proj)"}}
        peft_roundtrip(m1, tiny_profile, "mistral")
        m3 = tiny_mistral3(os.path.join(tmp, "mistral3"))
        parity(m3, "mistral3")
        prod_like = dict(tiny_profile, peft={"base_model_name_or_path": "local/tiny3", "module_prefix": "base_model.model.model.language_model.",
                                             "target_regex": r"model\.language_model\.layers\.\d+\.self_attn\.(q_proj|v_proj)"})
        peft_roundtrip(m3, prod_like, "mistral3")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    REPORT["ok"] = all(c["ok"] for c in REPORT["checks"].values())
    print(json.dumps(REPORT))
    sys.exit(0 if REPORT["ok"] else 1)

if __name__ == "__main__":
    main()
