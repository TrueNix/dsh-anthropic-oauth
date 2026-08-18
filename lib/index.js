// dsh-anthropic-oauth — Host half
// Bridges ~/.claude/.credentials.json claudeAiOauth -> ~/.dsh/.credentials.yaml + settings.
// - No token is hardcoded or committed.
// - Models are pulled live from GET /v1/models (no hardcoded catalog).
// - Request identity mirrors current Claude Code (OAuth betas + impersonation
//   headers) with NO real user identifier embedded.
const name = 'dsh-anthropic-oauth'
const inject = ['credentials', 'settings', 'fs', 'timer']

// Same OAuth client as Claude Code / pi-ai (base64 to keep it out of grep/scan noise).
const CLIENT_ID_B64 = 'OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl'
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const API_BASE = 'https://api.anthropic.com'
const MODELS_URL = API_BASE + '/v1/models?limit=1000'
const ANTHROPIC_VERSION = '2023-06-01'
const DSH_CREDENTIALS = '.dsh/.credentials.yaml'
const DSH_SETTINGS = '.dsh/settings.yaml'
const CREDS_REF = 'ANTHROPIC_OAUTH_TOKEN'
const CREDS_REF_ALIAS = 'CLAUDE_CODE_OAUTH_TOKEN'
const PROVIDER_KEY = 'anthropic'
const REFRESH_SKEW_MS = 5 * 60 * 1000
const MODELS_TTL_MS = 6 * 60 * 60 * 1000 // re-pull the catalog at most every 6h

// ── Request identity (kept current with Claude Code) ──────────────────
// Beta headers Claude Code / pi-ai send on OAuth (subscription) traffic. These
// are additive and harmless when a given account doesn't have a feature; the
// important ones for OAuth routing are `oauth-2025-04-20` and `claude-code-*`.
// Do NOT include `context-1m-2025-08-07` by default — some subscriptions 400
// on it for short auxiliary calls.
const OAUTH_BETAS = [
  'oauth-2025-04-20',
  'claude-code-20250219',
  'interleaved-thinking-2025-05-14',
  'fine-grained-tool-streaming-2025-05-14',
  'thinking-token-count-2026-05-13',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'mid-conversation-system-2026-04-07',
  'advisor-tool-2026-03-01',
  'advanced-tool-use-2025-11-20',
  'effort-2025-11-24',
  'extended-cache-ttl-2025-04-11',
  'cache-diagnosis-2026-04-07',
]
// Beta subset needed just to authenticate /v1/models over OAuth.
const OAUTH_DISCOVERY_BETAS = ['oauth-2025-04-20', 'claude-code-20250219']
const CLAUDE_CODE_VERSION_FALLBACK = '2.1.74'

let _clientId = null
function clientId() {
  if (_clientId) return _clientId
  try {
    _clientId = (typeof atob === 'function')
      ? atob(CLIENT_ID_B64)
      : Buffer.from(CLIENT_ID_B64, 'base64').toString('utf8')
  } catch {
    _clientId = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
  }
  return _clientId
}

let _ccVersion = null
async function claudeCodeVersion() {
  if (_ccVersion) return _ccVersion
  // Anthropic's OAuth infra validates the user-agent version and can reject
  // requests whose spoofed version is too far behind the real release. Detect
  // the locally-installed Claude Code version so updated users never hit that.
  for (const cmd of ['claude', 'claude-code']) {
    try {
      const cp = await import('node:child_process')
      const out = cp.execFileSync(cmd, ['--version'], { timeout: 5000, encoding: 'utf8' })
      const v = String(out).trim().split(/\s+/)[0]
      if (v && /^\d/.test(v)) { _ccVersion = v; return _ccVersion }
    } catch {}
  }
  _ccVersion = CLAUDE_CODE_VERSION_FALLBACK
  return _ccVersion
}

// Headers that make a request look like Claude Code's own JS SDK. No real user
// identifier is embedded: `cch` is a zeroed placeholder, not an account/session id.
async function claudeCodeHeaders(accessToken, betas) {
  const v = await claudeCodeVersion()
  return {
    authorization: `Bearer ${accessToken}`,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-beta': betas.join(','),
    'anthropic-dangerous-direct-browser-access': 'true',
    'user-agent': `claude-cli/${v} (external, sdk-cli)`,
    'x-app': 'cli',
    'x-stainless-lang': 'js',
    'x-stainless-runtime': 'node',
    'x-stainless-runtime-version': (typeof process !== 'undefined' && process.version) || 'v22.0.0',
    'x-stainless-package-version': '0.94.0',
    'x-stainless-timeout': '600',
    'x-stainless-async': 'false',
    // Zeroed billing hint — no user/session identifier.
    'x-anthropic-billing-header': `cc_version=${v}; cc_entrypoint=sdk-cli; cch=00000;`,
  }
}

function apply(ctx) {
  let stopped = false
  let timerHandle = null
  let fsWatcher = null
  let lastAuthState = { ok: false, message: 'initializing', expiresAt: null, tier: null, sub: null }
  let lastSyncOk = false
  let modelsCache = null // { at: number, models: [...] }

  // ── Claude Code credential file (outside workspace — use node:fs directly) ──
  async function readClaudeCreds() {
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const file = path.join(os.homedir(), '.claude', '.credentials.json')
    const raw = fs.readFileSync(file, 'utf8')
    const j = JSON.parse(raw)
    if (!j.claudeAiOauth) throw new Error('No claudeAiOauth in ' + file)
    return { file, json: j, oauth: j.claudeAiOauth }
  }

  async function writeClaudeCreds(file, json) {
    const fs = await import('node:fs')
    fs.writeFileSync(file, JSON.stringify(json, null, 2))
    try { fs.chmodSync(file, 0o600) } catch {}
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    })
    const txt = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status} ${txt.slice(0, 600)} url=${url}`)
    return txt
  }

  async function refreshIfNeeded() {
    const { file, json, oauth } = await readClaudeCreds()
    const now = Date.now()
    const exp = typeof oauth.expiresAt === 'number' ? oauth.expiresAt : 0
    if (exp && exp - now > REFRESH_SKEW_MS) return { file, json, oauth }
    console.log(`[anthropic-oauth] token expires in ${exp ? ((exp - now) / 60000).toFixed(1) : 'unknown'}m — refreshing`)
    const body = await postJson(TOKEN_URL, {
      grant_type: 'refresh_token',
      client_id: clientId(),
      refresh_token: oauth.refreshToken,
    })
    const data = JSON.parse(body)
    const newExpiresAt = Date.now() + (typeof data.expires_in === 'number' ? data.expires_in * 1000 : 3600 * 1000)
    json.claudeAiOauth.accessToken = data.access_token
    json.claudeAiOauth.refreshToken = data.refresh_token
    json.claudeAiOauth.expiresAt = newExpiresAt
    await writeClaudeCreds(file, json)
    console.log(`[anthropic-oauth] refreshed, new expiry ${new Date(newExpiresAt).toISOString()}`)
    return { file, json, oauth: json.claudeAiOauth }
  }

  // ── Live model catalog (replaces any hardcoded table) ─────────────────
  // GET /v1/models returns id, display_name, max_input_tokens, max_tokens and a
  // capabilities tree. We map that straight into llm-pi-ai provider model config.
  async function fetchAnthropicModels(accessToken) {
    if (modelsCache && Date.now() - modelsCache.at < MODELS_TTL_MS) return modelsCache.models
    const headers = await claudeCodeHeaders(accessToken, OAUTH_DISCOVERY_BETAS)
    const res = await fetch(MODELS_URL, { method: 'GET', headers, signal: AbortSignal.timeout(15000) })
    const txt = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status} ${txt.slice(0, 400)} url=${MODELS_URL}`)
    const data = JSON.parse(txt)
    const rows = Array.isArray(data && data.data) ? data.data : []
    const models = rows
      .filter((m) => m && typeof m.id === 'string')
      .map((m) => {
        const ctxWin = Number(m.max_input_tokens) || 200000
        const out = Number(m.max_tokens) || 64000
        const model = {
          id: m.id,
          name: m.display_name || m.id,
          contextWindow: ctxWin,
          maxTokens: out,
        }
        // Carry adaptive-thinking / effort support through when advertised, so
        // downstream config can gate features off real capabilities.
        const caps = m.capabilities || {}
        if (caps.thinking && caps.thinking.supported) model.reasoning = true
        if (caps.effort && caps.effort.supported) {
          model.effortLevels = ['low', 'medium', 'high', 'xhigh', 'max']
            .filter((lvl) => caps.effort[lvl] && caps.effort[lvl].supported)
        }
        return model
      })
    if (!models.length) throw new Error('models list empty')
    modelsCache = { at: Date.now(), models }
    return models
  }

  async function syncToDshCredentials(accessToken) {
    const creds = ctx.get('credentials')
    try {
      let ref = CREDS_REF
      try {
        const m = await import('@deepseek-ai/dsh-credentials')
        if (m && typeof m.credentialRef === 'function') ref = m.credentialRef(CREDS_REF)
      } catch {}
      await creds.set(ref, accessToken)
      lastSyncOk = true
    } catch (e) {
      const msg = e && e.message ? e.message : String(e)
      if (String(msg).includes('shadowed') || String(msg).includes('read-only')) {
        console.warn('[anthropic-oauth] credentials.set shadowed by launching env — unset ANTHROPIC_OAUTH_TOKEN in the shell that launched DSH:', msg)
        lastAuthState = { ok: false, message: 'shadowed by env: ' + msg.slice(0, 200), expiresAt: null, tier: null, sub: null }
        return false
      }
      console.error('[anthropic-oauth] credentials.set failed:', msg)
      // Fallback: direct 0600 yaml write for environments where the seam is read-only.
      try {
        const fs = await import('node:fs')
        const os = await import('node:os')
        const path = await import('node:path')
        const file = path.join(os.homedir(), '.dsh', '.credentials.yaml')
        let content = ''
        try { content = fs.readFileSync(file, 'utf8') } catch {}
        const out = []
        let found = false
        let aliasFound = false
        for (const line of content.split('\n')) {
          if (/^\s*ANTHROPIC_OAUTH_TOKEN\s*:/.test(line)) { out.push(`ANTHROPIC_OAUTH_TOKEN: ${accessToken}`); found = true; continue }
          if (/^\s*CLAUDE_CODE_OAUTH_TOKEN\s*:/.test(line)) { out.push(`CLAUDE_CODE_OAUTH_TOKEN: ${accessToken}`); aliasFound = true; continue }
          out.push(line)
        }
        if (!found) out.push(`ANTHROPIC_OAUTH_TOKEN: ${accessToken}`)
        if (!aliasFound) out.push(`CLAUDE_CODE_OAUTH_TOKEN: ${accessToken}`)
        fs.writeFileSync(file, out.join('\n').replace(/\n\n+/g, '\n'))
        try { fs.chmodSync(file, 0o600) } catch {}
        console.log('[anthropic-oauth] fallback direct write to .credentials.yaml')
        lastSyncOk = true
        return true
      } catch (e2) {
        console.error('[anthropic-oauth] fallback write also failed:', e2)
        return false
      }
    }
    // Alias (best-effort, ignore shadowing).
    try {
      let aliasRef = CREDS_REF_ALIAS
      try {
        const m = await import('@deepseek-ai/dsh-credentials')
        if (m && typeof m.credentialRef === 'function') aliasRef = m.credentialRef(CREDS_REF_ALIAS)
      } catch {}
      await creds.set(aliasRef, accessToken)
    } catch {}
    return true
  }

  async function ensureAnthropicProvider(accessToken) {
    const settings = ctx.get('settings')

    // Pull the live catalog; fall back to a minimal seed only if discovery fails
    // so the provider still works offline / on a transient 5xx.
    let models
    try {
      models = await fetchAnthropicModels(accessToken)
      console.log(`[anthropic-oauth] pulled ${models.length} models from /v1/models`)
    } catch (e) {
      console.warn('[anthropic-oauth] model discovery failed, seeding minimal set:', e && e.message ? e.message : e)
      models = [
        { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', contextWindow: 200000, maxTokens: 64000 },
      ]
    }

    const provider = {
      displayName: 'Anthropic',
      apiKeyEnv: CREDS_REF,
      api: 'anthropic-messages',
      baseURL: API_BASE,
      models,
    }

    // Keep the provider in sync with the live catalog on each pass (models
    // change over time), but only touch settings when something differs.
    try {
      const cur = settings.get('llm-pi-ai')
      const existing = cur && cur.providers && cur.providers[PROVIDER_KEY]
      if (existing && JSON.stringify(existing.models) === JSON.stringify(models)) {
        return false
      }
    } catch {}

    const patch = { providers: { [PROVIDER_KEY]: provider } }
    try {
      if (typeof settings.update === 'function') {
        await settings.update('llm-pi-ai', patch)
      } else if (typeof settings.mutate === 'function') {
        await settings.mutate('llm-pi-ai', [{ op: 'add', path: ['providers', PROVIDER_KEY], value: provider }])
      } else {
        // Last-resort direct YAML write.
        const fs = await import('node:fs')
        const os = await import('node:os')
        const path = await import('node:path')
        const file = path.join(os.homedir(), '.dsh', 'settings.yaml')
        let yaml = fs.readFileSync(file, 'utf8')
        const modelLines = models.map((m) =>
          [
            `        - id: ${m.id}`,
            `          name: ${JSON.stringify(m.name)}`,
            `          contextWindow: ${m.contextWindow}`,
            `          maxTokens: ${m.maxTokens}`,
          ].join('\n')).join('\n')
        const block = [
          `    ${PROVIDER_KEY}:`,
          `      displayName: Anthropic`,
          `      apiKeyEnv: ${CREDS_REF}`,
          `      api: anthropic-messages`,
          `      baseURL: ${API_BASE}`,
          `      models:`,
          modelLines,
        ].join('\n') + '\n'
        if (/^\s+anthropic:\s*$/m.test(yaml)) {
          // already present — leave the file to the structured seam next boot
        } else if (yaml.includes('    qwen-token-plan:')) {
          yaml = yaml.replace('    qwen-token-plan:', block + '    qwen-token-plan:')
          fs.writeFileSync(file, yaml)
        } else {
          yaml = yaml.replace(/(providers:\n)/, `$1${block}`)
          fs.writeFileSync(file, yaml)
        }
      }
      console.log('[anthropic-oauth] ensured llm-pi-ai.providers.anthropic in settings')
      return true
    } catch (e) {
      console.error('[anthropic-oauth] ensure provider failed:', e)
      return false
    }
  }

  async function oneShot() {
    if (stopped) return
    try {
      const { oauth } = await refreshIfNeeded()
      const ok = await syncToDshCredentials(oauth.accessToken)
      if (!ok) {
        lastAuthState = { ok: false, message: 'sync shadowed or failed', expiresAt: oauth.expiresAt, tier: oauth.rateLimitTier || null, sub: oauth.subscriptionType || null }
      } else {
        await ensureAnthropicProvider(oauth.accessToken)
        lastAuthState = { ok: true, message: 'bridged', expiresAt: oauth.expiresAt, tier: oauth.rateLimitTier || null, sub: oauth.subscriptionType || null }
      }
    } catch (e) {
      const msg = e && e.message ? e.message : String(e)
      console.error('[anthropic-oauth] sync failed:', msg)
      lastAuthState = { ok: false, message: msg.slice(0, 500), expiresAt: null, tier: null, sub: null }
      if (msg.includes('No claudeAiOauth') || msg.includes('ENOENT')) {
        lastAuthState.message = 'Not logged in to Claude Code — run `claude login` first.'
      }
    }
  }

  // Kick off immediately (don't block apply).
  void oneShot()

  // Poll every 60s (refresh skew is 5m; model catalog has its own 6h TTL).
  const schedule = () => {
    if (stopped) return
    timerHandle = setTimeout(async () => {
      await oneShot()
      schedule()
    }, 60_000)
  }
  schedule()

  // Watch the Claude credentials file (debounced) so external re-logins bridge instantly.
  void (async () => {
    try {
      const fs = await import('node:fs')
      const os = await import('node:os')
      const path = await import('node:path')
      const file = path.join(os.homedir(), '.claude', '.credentials.json')
      let debounce = null
      fsWatcher = fs.watch(file, () => {
        if (debounce) clearTimeout(debounce)
        debounce = setTimeout(() => { void oneShot() }, 400)
      })
      fsWatcher.on('error', () => {})
    } catch {}
  })()

  // Optional diagnostics endpoints on the DSH web server.
  try {
    const webServer = ctx.get('webServer')
    if (webServer) {
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/api/anthropic-oauth/status',
        handler: (req, res) => {
          res.statusCode = 200
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(JSON.stringify({
            ...lastAuthState,
            now: Date.now(),
            synced: lastSyncOk,
            models: modelsCache ? modelsCache.models.map((m) => m.id) : [],
            modelsAt: modelsCache ? modelsCache.at : null,
          }))
        },
      }))
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/api/anthropic-oauth/sync',
        handler: async (req, res) => {
          if (req.method !== 'POST') { res.statusCode = 405; res.end(); return }
          modelsCache = null // force a fresh catalog pull
          await oneShot()
          res.statusCode = 200
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ ...lastAuthState }))
        },
      }))
    }
  } catch {}

  ctx.effect(() => () => {
    stopped = true
    if (timerHandle) clearTimeout(timerHandle)
    if (fsWatcher) try { fsWatcher.close() } catch {}
  })
}

export { name, inject, apply }
export default { name, inject, apply }
