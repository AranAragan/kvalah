# Threat model — Kvalah Compute v0.2 (LAN)

Scope: a coordinator run by the owner on a private network, workers on the owner's own devices or devices
of explicitly approved people. **Not** a public volunteer network; a public release needs an independent
security/legal/abuse review (spec §17).

| Asset | Threat | Mitigation in v0.2 | Residual risk |
|---|---|---|---|
| User files, chats, prompts, code | Leak via task/upload/logs | Sidecar has no network; uploads are B tensors + metrics only; training data only from datasets imported in the Lab; reports redact device aliases → `device-N`; sensors are reduced to booleans/numbers (no process names) | A malicious *coordinator operator* sees device capabilities (GPU name, memory) |
| Device identity | Impersonation (v0.1 shared token) | Per-installation random id + Ed25519 key, signed requests, single-use nonces, ±120 s window, admin approval, revoke | Key in a 0600 file where safeStorage is unavailable (Linux basic_text, CLI) — UI shows `file-0600` |
| Coordinator endpoint | MITM / rogue coordinator | Pinned self-signed fingerprint in the pairing string, no fallback; consent bound to project+endpoint+fingerprint; remote (non-private) endpoints need an explicit extra consent | Pairing string must be transferred out-of-band by the owner |
| Global model | Poisoned/invalid update | Exact keys/shapes/dtype, finite check, size caps, frozen-A check, payload hash, token count recomputed by the coordinator, late/duplicate updates quarantined | A legitimate but malicious worker can still submit *valid-looking* bad B values (no robust aggregation in v0.2) |
| Worker machine | Remote code execution | Tasks are data (manifest + tensors + pretokenized rows); no code, URLs or shell fields are accepted; zip import checks traversal/bombs/CRC; safetensors only (no pickle); model folder must not contain symlinks out of it | Python packages in the runtime are installed by the user (unpinned hashes) |
| Resources (GPU/CPU/battery/heat) | Abuse, overheating, surprise usage | Off by default; versioned consent; Governor permits per micro-step; GPU share, CPU threads, hours/day budget persisted, idle/AC/games/local-AI/full-screen/thermal/memory/quiet hours/traffic; missing sensor ⇒ pause with reason; coordinator cannot change the policy | GPU share is a duty-cycle target, not a hard cap; game detection exists only on Windows |
| Coordinator DB | Crash/corruption | SQLite WAL + transactions, CAS with hashes, SEALING recovery | Single coordinator (no replication) |
| Local API | Other local apps calling `/api/compute/v2` | Existing local token + origin check; compute host has no listening port except the Lab coordinator | — |

Known gaps (tracked in requirements-map.md): no robust aggregation/anomaly detection, no key rotation UI,
no signed task manifests beyond TLS pinning, no automatic runtime installer with hash pinning, no
tray/background mode, no energy metrics.
