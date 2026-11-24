# MCP clients: `content` vs `structuredContent` (v0.4, MCP-01)

Real Codex / Claude Code / Cursor sessions were **not run** for this release (not available in the build
environment). The table below comes from the MCP specification, vendor documentation/maintainer statements and
public reproductions. It was checked on 2026-11-24. Clients change, so re-check with a marker probe before relying
on it (see "How to verify").

| Client | What reaches the model when a result has both | Structured-only result | Source |
|---|---|---|---|
| MCP spec 2025-06-18 | — (server guidance: a tool returning `structuredContent` SHOULD also return the serialized JSON in a text block) | allowed | https://modelcontextprotocol.io/specification/2025-06-18/server/tools#structured-content |
| Codex (CLI / app) | only `structuredContent` (serialized); `content` dropped by design | works | https://github.com/openai/codex/pull/2594 , https://github.com/openai/codex/issues/10334 (maintainer: "by design"), https://github.com/openai/codex/blob/178c3d30/codex-rs/protocol/src/models.rs (`as_function_call_output_payload`) |
| Claude Code | `structuredContent` preferred since v2.0.21; text `content` not forwarded when structured is present | works | https://github.com/anthropics/claude-code/issues/9962 (maintainer reply), https://github.com/anthropics/claude-code/issues/55677 |
| Cursor | only text `content` | **model receives an empty result** (Cursor staff: known issue; workaround = also send the JSON as text) | https://forum.cursor.com/t/mcp-tool-results-containing-only-structuredcontent-are-silently-dropped/167346 |

## Consequences for Kvalah

* `KVALAH_MCP_PAYLOAD=both` (default) is the only mode that works in all three clients, and **none of them shows
  both copies to the model** — the model pays for the result once. The second copy only travels over the local
  stdio pipe (counted as `mcp.duplicatedChars`, costs no cloud tokens).
* `structured` (structuredContent + a one-line text pointer) is fine for Codex and Claude Code but **breaks Cursor**
  (the model would see only the pointer). Use it only for clients you have verified.
* `text` (no structuredContent) works everywhere; clients that prefer structured data fall back to `content`.
* `kvalah_metrics.mcp` reports `client` (from the MCP `initialize` clientInfo), `modelChannel`
  (`structuredContent`, `content` or `unknown`) and `modelDuplicatedChars`: 0 for the clients above, the full
  amount (worst case) for unknown clients. Client detection is by name (`codex`, `claude-code`, `cursor`) and is a
  heuristic.

## How to verify on a real client (NOT RUN here)

Return a result whose text and structured channels carry different random markers, ask the model which markers it
can see, and compare with the server log (the method used in the Cursor thread above). Record the client version.
