# Kvalah desktop ↔ Compute Service integration (v0.4, COMPUTE-02 / UI-01 / UI-02 / UI-03)

`docs/kvalah-integration.patch` is a patch for the Kvalah desktop app (github.com/AranAragan/kvalah, made
against v0.9.0, commit `ba98e85`). It is **not applied or pushed anywhere**. Apply it yourself:

```bash
cd /path/to/kvalah            # clean checkout of v0.9.0
git apply --check /path/to/kvalah-offload/docs/kvalah-integration.patch
git apply /path/to/kvalah-offload/docs/kvalah-integration.patch
npm run check && npm test     # here: node --check 55/55, tests 99/99 (93 existing + 6 new)
```

## What it changes in kvalah

| File | Change |
|---|---|
| `compute-link.mjs` (new, ~110 lines, no dependencies) | Main-process client for the Compute Service: same socket/token paths as `servicePaths()` here, hello with `scope:'device'`, `lease()` / `release`, `snapshot()` for the dashboard, lazy reconnect every 5 s. No service → `lease()` returns immediately (kvalah works exactly as before). `KVALAH_COMPUTE_LINK=0` turns it off. |
| `scheduler.mjs` | Optional `local.gate`: a job on the local backend holds a shared lease for exactly its duration (released on failure too). |
| `server.mjs` | Creates the link; every main-agent model call and every local sub-task leases a slot **only when the backend is on this machine** (loopback URL). New `GET /api/compute` (token-protected like the rest of the API). |
| `public/devices.js`, `public/index.html` | New **Compute** tab in Settings → Devices: active agents (clients, requests, slots held), queue (busy/total slots, waiting, wait p50/p95), device load (this computer's slots, current leases, LAN nodes), errors and cancellations, savings with **estimated** and **measured** shown separately ("no paired benchmark results yet" while there are none). |
| `public/i18n/*.json` | 21 new keys; English and Russian written, the other 8 locales carry the English text (to be translated). |
| `test/compute-link.test.mjs` (new) | 6 tests: path layout, scheduler lease/release, no-service no-op, lease wait + abort, app chat leases and releases + `/api/compute`, app without service unchanged. |

## Shared queue and resource distribution

The service gained a `lease` method (lane `llm`) and a `device` connection scope:

* A lease occupies one of the service's model slots (`KVALAH_SERVICE_MAX_ACTIVE` or `KVALAH_MAX_PARALLEL`) from grant
  until `release`, disconnect, TTL (default 10 min, max 30 min) or service shutdown.
* Leases go through the same fair round-robin queue as MCP requests (interactive before background), so kvalah
  chats and cloud-agent delegations alternate instead of overloading the GPU.
* A `device`-scoped connection may only call `lease`, `release`, `metrics`, `status` — never workspace methods.
  A connection with `workspace:null` and no scope is still rejected (v0.3 contract unchanged).

Evidence: `test/v04-compute02-shared-queue.test.mjs` (3 tests, real service, real HTTP model stand-in) and
`scripts/check-kvalah-integration.mjs` — runs the real service + the patched kvalah `server.mjs` (the process
Electron starts) and checks lease/queue/dashboard end to end; output in `docs/logs/v04-kvalah-integration-check.log`.

## Not verified here

* **The Electron window was not started** (no display in this environment). The Compute tab was checked only through
  `/api/compute` and `node --check`; its look and the polling inside the real window are unverified.
* Windows named pipes and macOS were not run (Linux only).
* Who hosts the service: an MCP client (elected, COMPUTE-01) or `kvalah-offload-service`. Kvalah does not start the
  service itself; while no service runs, kvalah's local generations are not coordinated (as in v0.9.0).
