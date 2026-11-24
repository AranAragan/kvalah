# Kvalah paired benchmark — real runs

**Status (v0.4.0, 2026-11-24): no real runs yet; `analyze` would report `verdict: NOT_MEASURED`. There are no measured results and no savings claim.**

The harness (`bench/paired.mjs`), the 54 scenarios (`bench/scenarios.mjs`) and the gate analysis are implemented and covered by tests (`test/v03-qa02-bench.test.mjs`). A mock run (`bench/RESULTS-mock-paired.md`) checks the pipeline only.

## What a real run needs
- Agents: Codex, Claude Code and Cursor (record name + version), the same cloud model and settings in both arms.
- Local backend: Ollama with `qwen3.5:9b` (record `ollama show` digest; reasoning off; `KVALAH_MAX_TOKENS` set), plus one OpenAI-compatible backend (llama.cpp server).
- Hardware: RTX 2070 8 GB profile (if available) and a CPU-only profile for Level 1. LAN: two nodes, load and node disconnect.
- Usage source: the agent's or API's usage report (`usageSource: agent-usage | api | provider-dashboard`). Kvalah estimates are never accepted as measured.

## Procedure
1. `node bench/paired.mjs plan --reps 3 --seed <n> --out plan.json` → randomized arm order per repetition; hybrid rep 0 is cold cache, later reps warm.
2. Create the corpus snapshot: `node -e "import('./bench/scenarios.mjs').then(m=>m.writeCorpus(2026)).then(c=>console.log(c.root))"` and run both arms on that same snapshot.
3. For each planned run, give the agent `prompt` unchanged. Baseline: Kvalah MCP server disabled. Hybrid: enabled (and `KVALAH_CACHE_DIR` emptied for cold runs).
4. Append one JSON line per run to `runs.jsonl` (schema in the header of `bench/paired.mjs`): usage, duration, errors, `assertionsPassed` from `scenario.assert.includes`, rubric score (blind grading where possible), `critical`, `kvalahOutcome`.
5. `node bench/paired.mjs analyze --records runs.jsonl --price-in <USD/1M> --price-out <USD/1M> --out bench/RESULTS-real.md` → per-scenario median/p95, cold vs warm, target-set and whole-set savings, quality, delegation (declined and fallback separately), small-task growth and the gates (≥30 % savings on the target set, ≥95 % quality, 0 critical errors, ≥95 % delegation, ≤5 % small-task growth).

Until this file is replaced by such a report, do not publish savings or quality numbers.
