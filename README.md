# dsh-anthropic-oauth

Bridge your existing **Claude Code OAuth** session (Pro / Max / Team) into **DeepSeek Harness (DSH)** — with zero hardcoding.

- Reads `~/.claude/.credentials.json` `claudeAiOauth` live (same file Claude Code writes)
- Auto-refreshes `accessToken` via `https://platform.claude.com/v1/oauth/token` when <5 min remains
- Syncs `ANTHROPIC_OAUTH_TOKEN` (+ `CLAUDE_CODE_OAUTH_TOKEN` alias) into `~/.dsh/.credentials.yaml` — the credential seam `dsh-llm-pi-ai` already resolves
- Ensures `llm-pi-ai.providers.anthropic` (`api: anthropic-messages`) exists in `~/.dsh/settings.yaml`
- Billed to your **subscription**, not a console API key (`Bearer` + `oauth-2025-04-20`)

This does **not** embed or persist your tokens beyond the two standard DSH/Claude files.

## Install

```sh
# stable — from npm (once published):
dsh plugin --profile headless add dsh-anthropic-oauth
dsh plugin --profile web add dsh-anthropic-oauth   # optional; bridge is headless but harmless in web

# bleeding edge — from GitHub:
dsh plugin --profile headless add github:TrueNix/dsh-anthropic-oauth
```

## Prerequisites

- `Claude Code` logged in: `claude login` or `claude setup-token` at least once — `~/.claude/.credentials.json` must contain `claudeAiOauth`
- DSH `~0.1.0-rc.6`+ (has `dsh-llm-pi-ai`, `credentials`, `settings`, `fs`)

## How it works

```
~/.claude/.credentials.json  --watch-->  dsh-anthropic-oauth Host plugin
   claudeAiOauth {accessToken, refreshToken, expiresAt}
                                         │
                               refreshIfNeeded() if expiry <5m
                               POST https://platform.claude.com/v1/oauth/token
                               {grant_type: refresh_token, client_id: 9d1c25…f5e}
                                         │
                                         ├─► ~/.claude/.credentials.json (updated expiry)
                                         └─► ~/.dsh/.credentials.yaml
                                              ANTHROPIC_OAUTH_TOKEN: sk-ant-oat01-…
                                              CLAUDE_CODE_OAUTH_TOKEN: sk-ant-oat01-…

~/.dsh/settings.yaml llm-pi-ai.providers.anthropic {apiKeyEnv: ANTHROPIC_OAUTH_TOKEN}
         │
         └─► pi-ai anthropicMessagesApi — Authorization: Bearer sk-ant-oat01-…
             anthropic-beta: claude-code-20250219,oauth-2025-04-20
```

Verified live: `haiku-4.5` streaming returns `dsh-pi-ai ok` over the same `Bearer` path.

## Set as default model

```yaml
# ~/.dsh/settings.yaml
agent-default-model:
  provider: anthropic
  model: claude-sonnet-4-5
```

Or pick per-session in **Settings → Models** after a reload.

## Logs & manual sync

```sh
journalctl --user -u dsh-anthropic-oauth-bridge -f  # legacy external bridge (pre-plugin)
# plugin logs:
# DSH console: [anthropic-oauth] ...
node ~/Workspace/sync-claude-oauth.mjs   # manual one-shot (legacy)
```

## Troubleshooting

- `MISSING_CREDENTIAL llm-pi-ai: no credential for provider route "anthropic"` — bridge hasn't synced yet; run `node ~/Workspace/sync-claude-oauth.mjs` or re-login with `claude`.
- `state mismatch` during manual paste — you pasted a `code` from a different PKCE verifier.
- 401 from Anthropic — token expired and refresh failed; `claude login` again.

## Security

- Never commits tokens — `.gitignore` excludes `*.oat*`, `*.credentials.*`.
- Tokens live only in `0600` files owned by you: `~/.claude/.credentials.json` and `~/.dsh/.credentials.yaml`.
- A Feb-2026 Anthropic docs note declares Pro/Max OAuth for official clients only — personal use at your own risk; use a console `ANTHROPIC_API_KEY` for production.

## License

MIT
