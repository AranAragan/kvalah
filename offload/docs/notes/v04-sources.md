# v0.4 sources (checked 2026-11-24)
## BENCH-03 usage semantics
- OpenAI Chat Completions usage (prompt_tokens_details.cached_tokens ⊂ prompt_tokens; completion_tokens_details.reasoning_tokens ⊂ completion_tokens): https://platform.openai.com/docs/api-reference/chat/object , https://platform.openai.com/docs/guides/prompt-caching
- OpenAI Responses usage (input_tokens_details.cached_tokens, output_tokens_details.reasoning_tokens): https://platform.openai.com/docs/api-reference/responses/object
- Anthropic: total input = input_tokens + cache_creation_input_tokens + cache_read_input_tokens: https://platform.claude.com/docs/en/build-with-claude/prompt-caching , https://platform.claude.com/docs/en/api/messages
- Gemini UsageMetadata: promptTokenCount includes cachedContentTokenCount; totalTokenCount = prompt + candidates + toolUsePrompt + thoughts: https://ai.google.dev/api/generate-content , https://googleapis.github.io/js-genai/release_docs/classes/types.GenerateContentResponseUsageMetadata.html

## SKILL-06 / SKILL-09 (checked 2026-11-24)
- Codex MCP config (`codex mcp add`, `[mcp_servers.<name>]` in ~/.codex/config.toml): https://developers.openai.com/codex/mcp
- Claude Code MCP (`claude mcp add --transport stdio <name> --env K=V -- <cmd>`): https://code.claude.com/docs/en/mcp
- Cursor MCP (`.cursor/mcp.json`, `~/.cursor/mcp.json`): https://cursor.com/docs/context/mcp
- Agensi packaging: ZIP with SKILL.md + frontmatter (`name` required in the top SKILL.md, `description` for every SKILL.md; optional summary/version/tags/keywords/use_cases/docs_url), text/code allowed, executables fail, 50 MB upload limit: https://www.agensi.io/docs/packaging
- Agensi review: 8-check scan (file structure, file types, dangerous commands, secrets, env harvesting, network access, obfuscation, prompt injection), score −20 per fail / −5 per warning (curl, fetch, file writes, sudo, base64 warn), then AI review and human approval (up to 48 h): https://www.agensi.io/docs/review-and-approval
- Agensi security page: < 50 MB and < 1,000 files, no bundled dependencies (node_modules etc.), .git removed: https://www.agensi.io/security
- Agensi creator checklist: single top-level folder, slug name, trigger-style "Use when…" description, README recommended, no OS hidden files: https://www.agensi.io/learn/skill-md-creator-checklist
