# Fusion quality

A reproducible reference fixture uses three synthetic token tasks, deterministic disjoint prompt-group variants and 48 Validation sequences (96 supervised tokens). At seed 934, Validation NLL was 3.474873 for the frozen base, 2.353205 with routed experts, and 2.334696 with routed experts and Loop. These are local CPU measurements on the fixture, not claims about general quality or Ministral.

The practical panel of 100–200 tasks, repeated seeds, code execution in isolation, error analysis and comparisons with R0, R60 and centralized FFA-LoRA remain open. Historical R60 Test remains outside Fusion configuration selection.

Dataset candidates require pinned revisions and derivation review. GSM8K's card lists MIT; OpenMathInstruct-2 lists CC BY 4.0 and includes a contamination explorer; OASST1 lists Apache-2.0 and includes Russian and English conversation trees. Code Alpaca provides a separate data license. None of these candidate datasets is distributed with the reference run. [GSM8K](https://huggingface.co/datasets/openai/gsm8k) · [OpenMathInstruct-2](https://huggingface.co/datasets/nvidia/OpenMathInstruct-2) · [OASST1](https://huggingface.co/datasets/OpenAssistant/oasst1) · [Code Alpaca data license](https://github.com/sahil280114/codealpaca/blob/master/DATA_LICENSE)
