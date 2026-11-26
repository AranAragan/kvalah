# Test report · 0.10.0-compute.2.dev.1

Baseline `d642625`. Local development branch `codex/compute-stability`. Windows x64, Node 24.20.0, Python 3.12.10, PyTorch 2.11.0+cu128 with the tiny-model tests configured for CPU. The legacy archive and existing Python environment were supplied by the test machine. Tests and build did not replace either.

| Check | Result |
|---|---|
| `npm run check` | 100 files passed syntax validation. |
| Full Windows Node, Chrome and CPU pass | 133 passed, 11 skipped and 1 CLI regression found in 145 tests. The CLI initially checked tokenization policy before handling the local join consent. Local evidence: `docs/compute/windows-test.log`. |
| Follow-up after the CLI fix | 4 passed. CLI and legacy import passed. Mock HTTPS completed 2 rounds with dropped declare/PUT/commit replies and a worker restart without repeating the saved training. Tiny PyTorch CPU completed 2 rounds, trusted evaluation, PEFT export and report verification. Local evidence: `docs/compute/windows-followup.log`. |
| Coordinator, governor and protocol follow-up | 36 passed. 2 Python/legacy tests skipped in this no-Python invocation and covered in the runs above. |
| Local checkpoint recovery | T13 used real Python safetensors and recovered the previous matching adapter and optimizer state after simulated corruption. |
| MLX parity | **SKIP**. MLX is unavailable in the local Windows environment. The backend test log records both omitted parity checks. |
| Hardware discovery | Driver 616.56 reported RTX 5070 Laptop GPU with 8151 MiB VRAM. |
| HW-A–D and fresh-install migration | **NOT RUN**. Requires the three physical devices and an isolated installer migration check. |
| Windows x64 package and native smoke | **PASS**. Built NSIS and portable ZIP locally. The unpacked Electron app initialized the review and composer in an isolated data folder. Selected packaged Compute sources match the workspace byte-for-byte. The installer is unsigned. Checksums are in `release/SHA256SUMS.txt`. |
| macOS ARM64 package | **NOT BUILT LOCALLY**. Electron Builder requires macOS for this target. The CI configuration includes ARM64 DMG/ZIP and artifact upload. |
| `npm audit --omit=dev` | 0 production advisories reported. The install-time audit including dev dependencies reported 6 moderate advisories. |

The reproducible tests use fake inputs, local HTTPS and tiny CPU models. See [HW-TEST.md](HW-TEST.md) for acceptance on the RTX 5070, RTX 2070 and M1 Pro.
