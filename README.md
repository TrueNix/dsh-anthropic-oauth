# dsh-anthropic-oauth

Bridge your existing **Claude Code OAuth** session (Pro / Max / Team) into **DeepSeek Harness (DSH)** — with zero hardcoding.

- Reads `~/.claude/.credentials.json` `claudeAiOauth` live (same file Claude Code writes)
- Auto-refreshes `accessToken` via `https://platform.claude.com/v1/oauth/token` when <5 min remains
- Syncs `ANTHROPIC_OAUTH_TOKEN` (+ `CLAUDE_CODE_OAUTH_TOKEN` alias) into `~/.dsh/.credentials.yaml` — the credential seam `dsh-llm-pi-ai` already resolves
- Ensures `llm-pi-ai.providers.anthropic` (`api: anthropic-messages`) exists in `~/.dsh/settings.yaml`
- **Pulls the model catalog live** from `GET /v1/models` (id, display name, context window, max output, thinking/effort capabilities) — no hardcoded model list; new Claude releases appear automatically
- Sends the **current Claude Code request identity** (up-to-date OAuth beta set + `claude-cli` impersonation headers) with **no real user identifier** — `cch` is a zeroed placeholder
- Billed to your **subscription**, not a console API key (`Bearer` + `oauth-2025-04-20`)
- **Live quota panel**: shows your subscription's **5-hour and 7-day usage** with a reset countdown, read from the `anthropic-ratelimit-unified-*` headers on a cheap `max_tokens:1` probe (these headers ride only on `/v1/messages`, never `/v1/models`)

This does **not** embed or persist your tokens beyond the two standard DSH/Claude files.

## Quota display

In the DSH web UI, the plugin's client half docks a themed **quota panel** in the composer's ambient readout slot (`conversation.composer.dock`) — non-invasive (touches no shell chrome) and theme-aware (uses `--dsw-*` tokens, so it adapts to light/dark):

- **5h / 7d bars** with per-window utilization (green → amber ≥70% → red ≥90%)
- **live reset countdown** to the representative (usually 5-hour) window
- **Check quota** button forcing a fresh probe (otherwise auto-refreshes every 60s)
- **model-aware**: the panel only appears while the session's active model routes through the Anthropic provider. Switch to a non-Anthropic model (Qwen, DeepSeek, GLM, …) and it hides itself; switch back and it returns — read live from the shared model-selection directory, so it reacts immediately. If the model-selection service is unavailable, the gate is skipped (panel shown) rather than hidden forever.

The client half is authored directly in the DSH client-bundle format (`window.__ModuleLoader__.load`) and served verbatim — **no bundler or build step**. It reads two JSON endpoints the host half serves:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/anthropic-oauth/status` | Bridge state + last `rateLimit` snapshot (folded into `lastAuthState`) |
| `GET /api/anthropic-oauth/quota` | Live quota (60s TTL); `?force=1` or `POST` bypasses the cache |

The quota probe spends a negligible amount (Haiku, 1 output token) and is throttled to 60s + manual refresh.

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

                                          └─► GET /v1/models  (live catalog)
                                               → llm-pi-ai.providers.anthropic.models
                                                 [{id, name, contextWindow, maxTokens,
                                                   reasoning, effortLevels}, …]

~/.dsh/settings.yaml llm-pi-ai.providers.anthropic {apiKeyEnv: ANTHROPIC_OAUTH_TOKEN}
         │
         └─► pi-ai anthropicMessagesApi — Authorization: Bearer sk-ant-oat01-…
             anthropic-beta: oauth-2025-04-20,claude-code-20250219,…
```

The model catalog is refreshed from `GET /v1/models` (≤6h TTL, or on demand via
`POST /api/anthropic-oauth/sync`); if discovery fails the provider keeps a minimal
Sonnet-4.5 seed so it still resolves offline. Quota is probed from
`POST /v1/messages` (`max_tokens:1`, Haiku — fractions of a cent, 60s TTL)
and exposed at `/api/anthropic-oauth/quota`.

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
# DSH console (bridge + quota probe):
# [anthropic-oauth] pulled N models from /v1/models
# [anthropic-oauth] refreshed, new expiry …

# Force-refresh the model catalog (also syncs quota):
curl -X POST http://127.0.0.1:3080/api/anthropic-oauth/sync

# Live quota (60s TTL; ?force=1 bypasses cache):
curl http://127.0.0.1:3080/api/anthropic-oauth/quota
curl "http://127.0.0.1:3080/api/anthropic-oauth/quota?force=1"
```

## Troubleshooting

- `MISSING_CREDENTIAL llm-pi-ai: no credential for provider route "anthropic"` — bridge hasn't synced yet; re-login with `claude login`.
- 401 from Anthropic — token expired and refresh failed; `claude login` again.
- Quota `ok:false` with a refresh error — subscription may have changed; re-login, then check `/api/anthropic-oauth/quota?force=1`.

## Security

- Never commits tokens — `.gitignore` excludes `*.oat*`, `*.credentials.*`.
- Tokens live only in `0600` files owned by you: `~/.claude/.credentials.json` and `~/.dsh/.credentials.yaml`.
- A Feb-2026 Anthropic docs note declares Pro/Max OAuth for official clients only — personal use at your own risk; use a console `ANTHROPIC_API_KEY` for production.

## License

MIT
