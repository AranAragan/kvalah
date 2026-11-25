"""Central tokenization on the coordinator (spec §7): one pinned tokenizer + chat template produces
input_ids and target_mask once; workers never tokenize. Assistant spans are found by rendering the
conversation prefix (with generation prompt) and the prefix plus the assistant turn and checking that the
first is an exact token prefix of the second — no heuristic text markers. Rows that violate the prefix
property, exceed max_length, or end up with zero targets are excluded with a reason."""
import hashlib, json, os
from .errors import SidecarError

ROLES = {"system", "user", "assistant"}

def _render(tok, msgs, gen):
    ids = tok.apply_chat_template(msgs, tokenize=True, add_generation_prompt=gen, return_dict=False)
    if isinstance(ids, dict):
        ids = ids["input_ids"]
    if hasattr(ids, "tolist"):
        ids = ids.tolist()
    if ids and isinstance(ids[0], list):
        ids = ids[0]
    return [int(x) for x in ids]

def tokenize_row(tok, row, max_length):
    msgs = [{"role": m["role"], "content": m["content"]} for m in row["messages"]]
    full = _render(tok, msgs, False)
    mask = [0] * len(full)
    for i, m in enumerate(msgs):
        if m["role"] != "assistant":
            continue
        pre = _render(tok, msgs[:i], True)
        upto = _render(tok, msgs[:i + 1], False)
        if upto[:len(pre)] != pre:
            return None, "template_prefix_mismatch"
        if full[:len(upto)] != upto:
            return None, "template_turn_mismatch"
        for t in range(len(pre), len(upto)):
            mask[t] = 1
    mask[0] = 0
    if len(full) > max_length:
        return None, "too_long"
    if sum(mask[1:]) == 0:
        return None, "no_target_tokens"
    return {"id": row["id"], "input_ids": full, "target_mask": mask}, None

def tokenizer_fingerprint(model_dir):
    h = hashlib.sha256()
    names = ["tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "chat_template.jinja", "chat_template.json", "tekken.json", "tokenizer.model"]
    found = []
    for n in names:
        p = os.path.join(model_dir, n)
        if os.path.isfile(p):
            with open(p, "rb") as f:
                h.update(n.encode() + b"\0" + hashlib.sha256(f.read()).digest())
            found.append(n)
    if not found:
        raise SidecarError("MODEL_INVALID", "no tokenizer files in model directory")
    return h.hexdigest(), found

def chat_template_hash(tok):
    t = getattr(tok, "chat_template", None)
    if not t:
        raise SidecarError("MODEL_INVALID", "tokenizer has no chat template")
    if isinstance(t, dict):
        t = json.dumps(t, sort_keys=True)
    return hashlib.sha256(t.encode()).hexdigest()

DEFAULT_SYSTEM = "You are a helpful assistant for software engineering and QA."

def load_tokenizer(model_dir):
    """Pinned options: fix_mistral_regex=True where the installed transformers supports it (the published
    Ministral tokenizer.json ships a known-wrong pre-tokenizer regex), trust_remote_code=False."""
    import inspect
    from transformers import AutoTokenizer
    opts = {"local_files_only": True, "trust_remote_code": False}
    applied = {}
    try:
        tok = AutoTokenizer.from_pretrained(model_dir, fix_mistral_regex=True, **opts)
        applied["fix_mistral_regex"] = True
    except TypeError:
        tok = AutoTokenizer.from_pretrained(model_dir, **opts)
        applied["fix_mistral_regex"] = False
    return tok, applied

def run(model_dir, rows, max_length, default_system=DEFAULT_SYSTEM):
    tok, applied = load_tokenizer(model_dir)
    tok_hash, files = tokenizer_fingerprint(model_dir)
    tpl = getattr(tok, "chat_template", "") or ""
    # Templates that read the clock (Ministral's default system prompt contains today's date) would make
    # tokenization depend on the day. Rows without a system message get one fixed, recorded system prompt.
    date_dependent = "strftime_now" in tpl
    if date_dependent:
        rows = [r if any(m.get("role") == "system" for m in r["messages"]) else {**r, "messages": [{"role": "system", "content": default_system}] + list(r["messages"])} for r in rows]
    out, excluded = [], []
    for r in rows:
        if any(m.get("role") not in ROLES for m in r["messages"]):
            excluded.append({"id": r["id"], "reason": "unsupported_role"})
            continue
        t, why = tokenize_row(tok, r, max_length)
        if why:
            excluded.append({"id": r["id"], "reason": why})
        else:
            out.append(t)
    return {"rows": out, "excluded": excluded, "tokenizer_hash": tok_hash, "tokenizer_files": files, "chat_template_hash": chat_template_hash(tok),
            "tokenizer_options": {**applied, "date_dependent_template": date_dependent, "default_system": default_system if date_dependent else None}}
