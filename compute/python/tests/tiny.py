"""Builds the tiny test model + tokenizer used by CPU integration tests (test profile tiny-test-ffa-r4).
Random weights, seed 0: it measures nothing about quality, only that code paths are correct."""
import json, os, re, sys
TEMPLATE = ("{{ bos_token }}{% for m in messages %}{% if m['role'] == 'system' %}[SYS] {{ m['content'] }} [/SYS]"
            "{% elif m['role'] == 'user' %}[INST] {{ m['content'] }} [/INST]{% elif m['role'] == 'assistant' %} {{ m['content'] }}{{ eos_token }}{% endif %}{% endfor %}")
SPECIAL = ["<unk>", "<pad>", "<s>", "</s>", "[INST]", "[/INST]", "[SYS]", "[/SYS]"]

def words(texts):
    vocab = set()
    for t in texts:
        vocab.update(re.findall(r"\w+|[^\w\s]", t))
    return sorted(vocab)

def build(out_dir, texts, seed=0):
    import torch
    from tokenizers import Tokenizer, models, pre_tokenizers, AddedToken
    from transformers import PreTrainedTokenizerFast, MistralConfig, MistralForCausalLM
    os.makedirs(out_dir, exist_ok=True)
    vocab = {t: i for i, t in enumerate(SPECIAL + words(texts))}
    tk = Tokenizer(models.WordLevel(vocab=vocab, unk_token="<unk>"))
    tk.pre_tokenizer = pre_tokenizers.Whitespace()
    tk.add_special_tokens([AddedToken(t, special=True) for t in SPECIAL])
    fast = PreTrainedTokenizerFast(tokenizer_object=tk, bos_token="<s>", eos_token="</s>", unk_token="<unk>", pad_token="<pad>")
    fast.chat_template = TEMPLATE
    fast.save_pretrained(out_dir)
    torch.manual_seed(seed)
    cfg = MistralConfig(vocab_size=len(vocab), hidden_size=64, intermediate_size=128, num_hidden_layers=2, num_attention_heads=4,
                        num_key_value_heads=2, head_dim=16, max_position_embeddings=512, rms_norm_eps=1e-5, tie_word_embeddings=False,
                        bos_token_id=2, eos_token_id=3, pad_token_id=1, sliding_window=None)
    m = MistralForCausalLM(cfg)
    m.save_pretrained(out_dir, safe_serialization=True)
    return out_dir

if __name__ == "__main__":
    out, src = sys.argv[1], sys.argv[2]
    texts = []
    with open(src, encoding="utf8") as f:
        for line in f:
            if line.strip():
                texts += [m["content"] for m in json.loads(line)["messages"]]
    build(out, texts)
    print(out)
