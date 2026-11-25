# Runbook — Kvalah Compute v0.2

## Enable / disable
* Sidebar → **Compute** → *Enable the Compute section* (writes `settings.computeV2 = true`, starts the compute
  host process). *Switch Compute off completely* stops participation, the worker and the coordinator and
  ends the host process. Data stays in `<kvalah data>/compute-v2/` (identity, consent records, budget ledger,
  coordinator DB + CAS). Rollback = switch off; deleting that folder resets Compute completely.
* Closing the Kvalah window stops Compute (no background mode in v0.2).

## Typical LAN session
1. Every device: Models & data → runtime check → model verify → preflight.
2. Coordinator machine: Devices → start coordinator on its LAN IP → join self → pairing codes.
3. Other devices: paste pairing string → admin approves → consent on each device.
4. Training Lab: register variants (local + *Reported by approved devices*), import dataset, dry run, start.
5. Monitoring → wait for COMPLETED → export report → verify report.

## CLI (same controller as the app)
`node compute/cli.mjs --help` (Mac/Linux from source) or, from an installed Windows build,
`$env:ELECTRON_RUN_AS_NODE=1; & kvalah.exe resources\app\compute\cli.mjs <cmd> … 2>&1 | Out-Host`.
Commands: `doctor`, `coordinator`, `run`, `worker` (needs `--i-consent`), `export`, `verify-report`,
`legacy-import`, `status`. The CLI keeps its own state in `~/.kvalah-compute-cli` (`--dir` to change).

## Troubleshooting
| Symptom | Cause / action |
|---|---|
| State *Setup required* | The checklist on *Participation* names the missing step (link, runtime, model, architecture, preflight) |
| *Paused — sensor unavailable* | The policy needs a sensor this device lacks (games on macOS/Linux, power/idle outside Electron). Untick that option or accept the pause |
| *Paused — local AI is in use* | Kvalah's own local model is generating; work resumes when it finishes |
| *Daily time limit reached* | Budget is wall time of active sessions, persisted; resumes next local day or raise *hours/day* |
| Device stays `pending` | Approve on the coordinator, then *Check approval* |
| Device shows `revoked` | Revoked by the admin; *Forget* and pair again with a new code (new approval needed) |
| Workers cannot connect after changing bind IP/port | The TLS certificate is regenerated → pair all devices again |
| Windows firewall | Allow kvalah on **Private** networks only; never disable the firewall or forward router ports |
| Round BLOCKED | Fewer accepted updates than the quorum minimum at the deadline; the blocker text names the devices; *Resume / retry* re-runs the round from the same parent |
| `task.model_mismatch` event | The device's model files digest differs from the registered variant — re-verify the folder or register the variant from that device deliberately |
| CUDA OOM | Close other GPU users (Ollama, games), keep max length 256, re-run preflight |
| MLX errors on Mac | Check the venv python is arm64; versions per `compute/runtime/requirements-mlx.txt` |
| `CLOCK_SKEW` | Device clock differs > 2 min from the coordinator: enable automatic time sync |
| Report verification fails | The zip was modified or is incomplete; re-export from the coordinator |
