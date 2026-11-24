# Install, update, uninstall, rollback, troubleshooting (v0.4)

## Install
Requirements: Node.js `^22.18.0 || >=24.11.0` (Babel 8), a local inference server (Ollama, LM Studio or llama.cpp `llama-server`) with the model pulled, e.g. `ollama pull qwen3.5:9b`.

**Standalone from the release archive** (the npm package is not published):
```bash
mkdir -p ~/kvalah-offload && cd ~/kvalah-offload
unzip /path/to/kvalah-offload-v0.4.zip            # archive root = package root
npm ci --omit=dev                                  # exact versions from package-lock.json
KVALAH_MODEL=qwen3.5:9b KVALAH_WORKSPACE=$PWD node mcp/server.mjs   # smoke test, Ctrl+C
```
Windows (PowerShell): `Expand-Archive kvalah-offload-v0.4.zip $HOME\kvalah-offload; cd $HOME\kvalah-offload; npm ci --omit=dev`.

**Overlay (inside a kvalah checkout):** unzip into `kvalah/offload/` and run `npm ci --omit=dev` there, or set `KVALAH_HOME=/path/to/kvalah`. `kvalah_status` then reports `kvalah.mode: "overlay"`.

**Register with the agent:** see the Claude Code / Codex / Cursor snippets in `README.md` (formats not verified against current client versions). Then copy `skill/` (or unzip `kvalah-offload-v0.3-skill.zip`) into the agent's skills folder.

**Optional shared service** (one engine for GUI + several MCP clients):
```bash
KVALAH_MODEL=qwen3.5:9b KVALAH_WORKSPACE=/abs/project node ~/kvalah-offload/compute/service.mjs
```
MCP servers with the same `KVALAH_WORKSPACE` and data dir connect automatically (`KVALAH_SERVICE=auto`). Run it under your user account only (systemd user unit, launchd agent or Task Scheduler "at logon").

## Update (0.3 → 0.4)
1. Stop agents and the service; keep the old folder (`mv ~/kvalah-offload ~/kvalah-offload-0.3`); install 0.4 into the same path.
2. Behaviour changes: `KVALAH_SERVICE=auto` (default) now elects one host among MCP servers — set `KVALAH_SERVICE=connect` for the 0.3 behaviour; the router may decline marginal tasks (`route.expected`); bench records need `config` and `snapshot`.
3. Cache entries from 0.3 miss once (checksum added). Delete any `.config/` folder that 0.3 tests may have created inside the package folder.
4. Rollback: stop everything, swap the folders back; 0.3 ignores the new variables (`KVALAH_SCHED_*`, `KVALAH_SERVICE_AGING_MS`, `KVALAH_BENCH_RESULTS`, `KVALAH_SKILL_FILE`). Rolling back re-opens the defects listed in `docs/V04-REPORT.md`.

## Update (0.2 → 0.3)
1. Stop agents using the server (and the service if running).
2. Keep the old folder: `mv ~/kvalah-offload ~/kvalah-offload-0.2`.
3. Install 0.3 as above into `~/kvalah-offload` (same path ⇒ agent configs keep working).
4. Review config changes:
   - Prices have **no defaults** now; set `KVALAH_PRICE_INPUT`/`KVALAH_PRICE_OUTPUT` if you want USD figures.
   - LAN needs `KVALAH_LAN_ALLOW` (node ids/names) and https, or `KVALAH_LAN_ALLOW_PLAINTEXT=1`.
   - `:cloud` / `-cloud` models need `KVALAH_ALLOW_CLOUD_MODELS=1`.
   - `kvalah_status.dashboard.url` no longer contains the token (it is printed to stderr).
5. The cache key changed (prompt v4, schema version): old cache entries simply miss. Optional cleanup: delete `KVALAH_CACHE_DIR` (`~/.cache/kvalah-offload`, `~/Library/Caches/kvalah-offload`, `%LOCALAPPDATA%\kvalah-offload\cache`).

## Rollback (0.3 → 0.2)
1. Stop agents and the service (`Ctrl+C` / `kill -TERM <pid>`; it removes its socket and token file).
2. `mv ~/kvalah-offload ~/kvalah-offload-0.3 && mv ~/kvalah-offload-0.2 ~/kvalah-offload` (or unzip `kvalah-offload-v0.2.zip` and `npm ci --omit=dev`).
3. Remove 0.3-only variables if you like (they are ignored by 0.2): `KVALAH_SERVICE*`, `KVALAH_LAN_ALLOW*`, `KVALAH_MCP_*`, `KVALAH_DET_*`, `KVALAH_CACHE_DISK`, `KVALAH_CACHE_SENSITIVE`, `KVALAH_REQUEST_DEADLINE_MS`, `KVALAH_MAX_PENDING_CALLS`, `KVALAH_ROUTER_MIN_TOKENS`, `KVALAH_BASELINE`, `KVALAH_DASHBOARD_SHOW_PATHS`.
4. Clear the cache directory (0.3 entries are ignored by 0.2 but use disk space) and restore the 0.2 skill files.
5. Note: rolling back re-opens the v0.2 defects fixed in 0.3 (see `docs/V03-REPORT.md`), including LAN without allow-list.

In the git working copy: `git checkout main` (0.2 baseline) or `git checkout fix/offload-v03` / `fix/offload-v04`.

## Uninstall
1. Remove the MCP entry from the agent (`claude mcp remove kvalah`; delete `[mcp_servers.kvalah]` from `~/.codex/config.toml`; delete `kvalah` from `.cursor/mcp.json`).
2. Remove the skill folder.
3. Delete the package folder, the cache dir (see above) and, if you used the service, `service.sock` / `service.token` in the kvalah data dir (normally removed on shutdown).
4. Kvalah writes nothing else; your workspace is never modified.

## Troubleshooting
| Symptom | Cause / fix |
|---|---|
| `Kvalah offload not configured: Set KVALAH_MODEL` | Set `KVALAH_MODEL` in the MCP entry's env. |
| `kvalah_status` → offline | The local server is not running or `KVALAH_LOCAL_URL` is wrong (loopback only). `ollama serve`, then `curl http://127.0.0.1:11434/api/tags`. |
| `QueueTimeoutError` / `ExecTimeoutError` / `DeadlineError` | Queue, execution or request timeout (model busy or too slow): raise `KVALAH_QUEUE_TIMEOUT_MS` / `KVALAH_TIMEOUT_MS` / `KVALAH_REQUEST_DEADLINE_MS`, lower input with `query`/`tailBytes`, or set `KVALAH_MAX_PARALLEL` to match `OLLAMA_NUM_PARALLEL`. The agent should retry at most once, then do the task itself. |
| `OverloadError` / `Service queue full` | Backpressure: too many pending calls. Wait, or raise `KVALAH_MAX_PENDING_CALLS` / `KVALAH_SERVICE_MAX_QUEUE*`. |
| `ContextOverflowError` | Instruction plus overhead does not fit the model context: shorten the instruction or raise `KVALAH_CONTEXT` (and the model's `num_ctx`). |
| A cancelled call keeps the GPU busy | Cancel aborts the HTTP request; whether the backend stops inference depends on the backend (not verified on real hardware for 0.3). Check `ollama ps`. Cancel also works from the dashboard. |
| `compute service unavailable` (KVALAH_SERVICE=required) | Start `compute/service.mjs`, check that both use the same `KVALAH_DATA_DIR`/`KVALAH_SERVICE_SOCKET` and the same `KVALAH_WORKSPACE`. |
| `authentication failed` / `workspace mismatch` | Token file from another service start or another user; or a different workspace. Restart the client; set matching `KVALAH_WORKSPACE`. |
| `a Kvalah service is already running` | Another service owns the socket; stop it or use `KVALAH_SERVICE_SOCKET`. |
| `refusing to replace non-socket file` | Something else is at the socket path; remove it manually. |
| LAN disabled with an error | `devices.json` missing, `KVALAH_LAN_ALLOW` empty, peer not on a private address, or certificate invalid. |
| `Secret-like content detected … blocked` | `KVALAH_SECRET_POLICY=block`; remove secrets from the files or add a narrow `KVALAH_SECRET_ALLOW` pattern. |
| Results look stale | The cache key covers file content, model digest and policy; to clear: dashboard "Clear cache", or delete the cache dir. |
| USD shows `null` / "unknown" | Prices not configured: set `KVALAH_PRICE_INPUT` and `KVALAH_PRICE_OUTPUT`. |
