"""Exercise the real MistralCommonBackend with a local, byte-only Tekken vocabulary."""
import base64
import json
import os
from pathlib import Path
import tempfile
import unittest

from mistral_common.tokens.tokenizers.base import SpecialTokens
from transformers import AutoTokenizer

from kvalah_compute.tokenize_rows import run


def make_tokenizer(path):
    path.joinpath("config.json").write_text('{"model_type":"mistral3"}', encoding="utf-8")
    vocab = [
        {"rank": i, "token_bytes": base64.b64encode(bytes([i])).decode("ascii"),
         "token_str": bytes([i]).decode("utf-8", errors="replace")}
        for i in range(256)
    ]
    special = [{"rank": i, "token_str": token.value, "is_control": True}
               for i, token in enumerate(SpecialTokens)]
    size = len(vocab) + len(special)
    data = {
        "config": {"pattern": r"(?s).+", "num_vocab_tokens": size, "default_vocab_size": size,
                   "default_num_special_tokens": len(special), "version": "v13"},
        "vocab": vocab,
        "special_tokens": special,
        "image": {"image_patch_size": 14, "max_image_size": 1540, "spatial_merge_size": 2},
    }
    path.joinpath("tekken.json").write_text(json.dumps(data), encoding="utf-8")


class MistralMasks(unittest.TestCase):
    def test_masks(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory)
            make_tokenizer(fixture)
            self.check_model(fixture)
        if model := os.environ.get("KVALAH_MISTRAL_MODEL_DIR"):
            self.check_model(Path(model))

    def check_model(self, path):
        languages = {
            "en": ("Use short answers.", "How many?", "Three.", "And now?", "Four."),
            "ru": ("Отвечай кратко.", "Сколько?", "Три.", "А теперь?", "Четыре."),
        }
        rows = []
        for language, (system, user, answer, next_user, next_answer) in languages.items():
            single = [{"role": "user", "content": user}, {"role": "assistant", "content": answer}]
            multi = [{"role": "system", "content": system}, *single,
                     {"role": "user", "content": next_user + " " + answer},
                     {"role": "assistant", "content": next_answer}]
            rows.extend([{"id": language + ".single", "messages": single},
                         {"id": language + ".multi", "messages": multi}])

        reference = AutoTokenizer.from_pretrained(
            path, mode="finetuning", local_files_only=True, trust_remote_code=False)
        self.assertEqual(reference.backend, "mistral_common")
        result = run(path, rows, 256)
        self.assertEqual(result["excluded"], [])
        self.assertEqual(result["tokenizer_options"]["training_mode"], "finetuning")
        self.assertEqual(result["tokenizer_options"]["prefix_mode"], "serving")
        self.assertRegex(result["chat_template_hash"], r"^[a-f0-9]{64}$")
        inst_end = reference.convert_tokens_to_ids(SpecialTokens.end_inst.value)
        eos = reference.eos_token_id
        encoder = reference.tokenizer.instruct_tokenizer.tokenizer
        for source, tokenized in zip(rows, result["rows"], strict=True):
            with self.subTest(model=path.name, row=source["id"]):
                ids = tokenized["input_ids"]
                self.assertEqual(ids, reference.apply_chat_template(
                    source["messages"], tokenize=True, return_dict=False))
                starts = [i + 1 for i, token in enumerate(ids) if token == inst_end]
                ends = [i + 1 for i, token in enumerate(ids) if token == eos]
                answers = [msg["content"] for msg in source["messages"] if msg["role"] == "assistant"]
                self.assertEqual(len(starts), len(answers))
                expected = [0] * len(ids)
                for start, end, answer in zip(starts, ends, answers, strict=True):
                    self.assertEqual(ids[start:end], encoder.encode(answer, bos=False, eos=True))
                    expected[start:end] = [1] * (end - start)
                self.assertEqual(tokenized["target_mask"], expected)
                self.assertEqual(tokenized["target_mask"][0], 0)

        # Invalid or too-long rows must not stop tokenization of the rest of the dataset.
        invalid = {"id": "input-only", "messages": rows[0]["messages"][:1]}
        too_long = {"id": "over-limit", "messages": [
            {"role": "user", "content": " question" * 300},
            {"role": "assistant", "content": "answer"}]}
        mixed = run(path, [invalid, rows[0], too_long], 256)
        self.assertEqual([r["id"] for r in mixed["rows"]], [rows[0]["id"]])
        self.assertEqual(mixed["excluded"], [{"id": "input-only", "reason": "last_message_not_assistant"},
                                             {"id": "over-limit", "reason": "too_long"}])


if __name__ == "__main__":
    unittest.main()
