# kvalah-offload skill

Instructions for coding agents (Codex, Claude Code, Cursor) on when and how to use the Kvalah MCP tools.
The skill is text only (no scripts). It **requires the kvalah-offload MCP server** — Node.js `^22.18.0 || >=24.11.0`
(same as `engines` in the server's package.json) and a local model (Ollama or llama.cpp) — which this skill does not contain.

## Install the MCP server
From the release archive (the npm package is not published):

```bash
unzip kvalah-offload-v0.4.zip -d ~/kvalah-offload && cd ~/kvalah-offload && npm ci --omit=dev
```

Environment: `KVALAH_MODEL` (an installed local model, e.g. `qwen3.5:9b`), `KVALAH_WORKSPACE` (read-only project root), optional `KVALAH_PRICE_INPUT`/`KVALAH_PRICE_OUTPUT` (USD per 1M tokens of your cloud model). Several agents on one machine share one compute service automatically (`KVALAH_SERVICE=auto`).

Client configuration, per each client's MCP docs (checked 2026-11-24; **not verified with live clients in this release**):

- Codex — `codex mcp add kvalah --env KVALAH_MODEL=qwen3.5:9b --env KVALAH_WORKSPACE=/path/to/project -- node /home/you/kvalah-offload/mcp/server.mjs`, or `~/.codex/config.toml`:
  ```toml
  [mcp_servers.kvalah]
  command = "node"
  args = ["/home/you/kvalah-offload/mcp/server.mjs"]
  env = { KVALAH_MODEL = "qwen3.5:9b", KVALAH_WORKSPACE = "/path/to/project" }
  ```
  (https://developers.openai.com/codex/mcp)
- Claude Code — `claude mcp add --transport stdio kvalah --env KVALAH_MODEL=qwen3.5:9b --env KVALAH_WORKSPACE=/path/to/project -- node /home/you/kvalah-offload/mcp/server.mjs` (https://code.claude.com/docs/en/mcp)
- Cursor — `.cursor/mcp.json` (project) or `~/.cursor/mcp.json`: `{"mcpServers":{"kvalah":{"command":"node","args":["/home/you/kvalah-offload/mcp/server.mjs"],"env":{"KVALAH_MODEL":"qwen3.5:9b","KVALAH_WORKSPACE":"/path/to/project"}}}}` (https://cursor.com/docs/context/mcp)

## Install the skill
Copy this folder (`SKILL.md`, `references/`) into your agent's skills directory (for example `~/.claude/skills/kvalah-offload/`).

## Limits
Savings depend on the task: small inputs or content the agent already read cost more when offloaded, and the router declines them. No measured savings are claimed for this release (the mock benchmark is not a real-world result). Local output can be wrong; verified quotes only show the text exists in the file.

## Publishing (Agensi)
Packaged per Agensi's rules (https://www.agensi.io/docs/packaging, https://www.agensi.io/docs/review-and-approval): one top-level folder with SKILL.md (frontmatter `name`, `description`), text files only, no secrets, no scripts. The listing must state that the MCP server and a local model are required. Not submitted.

License: MIT (see LICENSE).
