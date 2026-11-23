# Security policy

## Supported versions

Only the latest release receives security fixes.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private reporting: **Security → Report a vulnerability** on <https://github.com/AranAragan/kvalah/security/advisories/new>. You should get a reply within 7 days.

## Threat model (what kvalah does and does not protect)

- kvalah runs shell commands and edits files **with your user's permissions**. The approval modes (*Ask*, *Auto*, *Full access*) are a policy, **not an operating-system sandbox**. In *Full access* the model can do anything your account can.
- The local backend listens on `127.0.0.1` only and requires a random per-session token on every API route. The desktop window receives the token over Electron IPC; it is never served over HTTP.
- Model output is untrusted input. Prompt injection from files, web pages or tool results can make a model propose harmful commands — review approval cards, especially for commands outside the project folder.
- API keys for OpenAI-compatible servers are stored in the local settings file and are never sent back to the UI.
- Updates are downloaded from GitHub Releases over HTTPS and verified by SHA-512 from the release feed; signed Windows builds additionally check the publisher of the installer.

Out of scope: issues that require an attacker who already runs code as your user, and behaviour of the model server you connect to.
