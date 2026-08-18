// dsh-anthropic-oauth — Host half
// Bridges ~/.claude/.credentials.json claudeAiOauth -> ~/.dsh/.credentials.yaml + settings
// No token is hardcoded or committed. Pure plugin; no external daemon needed.
const name = 'dsh-anthropic-oauth'
const inject = ['credentials', 'settings', 'fs', 'timer']

// Same client as Claude Code / pi-ai
const CLIENT_ID_B64 = 'OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl'
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const CLAUDE_DIR = '.claude/.credentials.json' // relative to $HOME
const DSH_CREDENTIALS = '.dsh/.credentials.yaml'
const DSH_SETTINGS = '.dsh/settings.yaml'
const CREDS_REF = 'ANTHROPIC_OAUTH_TOKEN'
const CREDS_REF_ALIAS = 'CLAUDE_CODE_OAUTH_TOKEN'
const PROVIDER_KEY = 'anthropic'
const REFRESH_SKEW_MS = 5 * 60 * 1000
let _clientId = null
function clientId() {
  if (_clientId) return _clientId
  try { _clientId = atob(CLIENT_ID_B64) } catch { _clientId = '9d1c250a-e61b-44d9-88ed-5944d1962f5e' }
  return _clientId
}
function homeDir(ctx) {
  try {
    const sp = ctx.get('sandboxPolicy')
    if (sp && typeof sp.workspaceRoot === 'string' && sp.workspaceRoot) {
      // not the home — use HOME env instead
    }
  } catch {}
  // DSH runs as user; HOME is inherited. Fallback to filesystem scan.
  return null
}
function apply(ctx) {
  // All async I/O goes through Node builtins accessed via dynamic import inside handlers,
  // but Host plugins have Node builtins via the cordis loader's Node environment.
  // We resolve paths via ctx.fs + direct fs fallback.
  let stopped = false
  let timerHandle = null
  let fsWatcher = null
  let lastAuthState = { ok: false, message: 'initializing', expiresAt: null, tier: null, sub: null }
  let lastSyncOk = false

  // Helpers that use Host-provided fs when possible, else node:fs
  async function readClaudeCreds() {
    // Prefer node:fs directly — ctx.fs is workspace-scoped, Claude dir is outside
    const mod = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const file = path.join(os.homedir(), '.claude', '.credentials.json')
    const raw = mod.readFileSync(file, 'utf8')
    const j = JSON.parse(raw)
    if (!j.claudeAiOauth) throw new Error('No claudeAiOauth in ' + file)
    return { file, json: j, oauth: j.claudeAiOauth }
  }

  async function writeClaudeCreds(file, json) {
    const mod = await import('node:fs')
    mod.writeFileSync(file, JSON.stringify(json, null, 2))
    try { mod.chmodSync(file, 0o600) } catch {}
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
    // need refresh
    console.log(`[anthropic-oauth] token expires in ${exp ? ((exp - now) / 60000).toFixed(1) : 'unknown'}m — refreshing`)
    const cid = clientId()
    const body = await postJson(TOKEN_URL, {
      grant_type: 'refresh_token',
      client_id: cid,
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

  async function syncToDshCredentials(accessToken) {
    const creds = ctx.get('credentials')
    // ctx.credentials.set is the canonical seam; it writes via dsh-credentials-local
    // which handles shadowing, 0600, and file watching.
    try {
      // Use credentialRef branding via settings seam? credentials seam takes raw string/ref?
      // The provider expects credentialRef('NAME') but the Host plugin can call set(ref, value)
      // where ref is string-like. We pass the raw name — the local provider brands it internally
      // in hosted DSH versions. Fallback to direct fs if branded call rejects.
      // Try branded first via dynamic import of credentialRef
      let ref = CREDS_REF
      try {
        const m = await import('@deepseek-ai/dsh-credentials')
        if (m && typeof m.credentialRef === 'function') ref = m.credentialRef(CREDS_REF)
      } catch {}
      await creds.set(ref, accessToken)
      lastSyncOk = true
    } catch (e) {
      // If shadowed by env, we cannot write — report but don't throw for watch loop
      const msg = e && e.message ? e.message : String(e)
      if (String(msg).includes('shadowed') || String(msg).includes('read-only')) {
        console.warn('[anthropic-oauth] credentials.set shadowed by launching env — unset ANTHROPIC_OAUTH_TOKEN in shell that launched DSH:', msg)
        lastAuthState = { ok: false, message: 'shadowed by env: ' + msg.slice(0, 200), expiresAt: null, tier: null, sub: null }
        return false
      }
      console.error('[anthropic-oauth] credentials.set failed:', msg)
      // Fallback: direct yaml append (best-effort, for environments where seam is read-only)
      try {
        const fsMod = await import('node:fs')
        const osMod = await import('node:os')
        const pathMod = await import('node:path')
        const file = pathMod.join(osMod.homedir(), '.dsh', '.credentials.yaml')
        let content = ''
        try { content = fsMod.readFileSync(file, 'utf8') } catch {}
        const lines = content.split('\n')
        let found = false
        let aliasFound = false
        const out = []
        for (const line of lines) {
          if (/^\s*ANTHROPIC_OAUTH_TOKEN\s*:/.test(line)) { out.push(`ANTHROPIC_OAUTH_TOKEN: ${accessToken}`); found = true; continue }
          if (/^\s*CLAUDE_CODE_OAUTH_TOKEN\s*:/.test(line)) { out.push(`CLAUDE_CODE_OAUTH_TOKEN: ${accessToken}`); aliasFound = true; continue }
          out.push(line)
        }
        if (!found) out.push(`ANTHROPIC_OAUTH_TOKEN: ${accessToken}`)
        if (!aliasFound) out.push(`CLAUDE_CODE_OAUTH_TOKEN: ${accessToken}`)
        fsMod.writeFileSync(file, out.join('\n').replace(/\n\n+/g, '\n'))
        try { fsMod.chmodSync(file, 0o600) } catch {}
        console.log('[anthropic-oauth] fallback direct write to .credentials.yaml')
        lastSyncOk = true
        return true
      } catch (e2) {
        console.error('[anthropic-oauth] fallback write also failed:', e2)
        return false
      }
    }
    // Also sync alias (best-effort, ignore shadow)
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

  async function ensureAnthropicProvider() {
    const settings = ctx.get('settings')
    // Idempotent: only add if missing
    try {
      const cur = settings.get('llm-pi-ai')
      if (cur && typeof cur === 'object' && cur.providers && typeof cur.providers === 'object' && cur.providers[PROVIDER_KEY]) {
        return false
      }
    } catch {}
    // Build patch: insert anthropic under providers
    // We use settings.update with JSON-patch style; use mutate if available, else replace
    const patch = {
      providers: {
        [PROVIDER_KEY]: {
          displayName: 'Anthropic',
          apiKeyEnv: CREDS_REF,
          api: 'anthropic-messages',
          baseURL: 'https://api.anthropic.com',
          models: [
            { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', contextWindow: 200000, maxTokens: 64000 },
            { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', contextWindow: 200000, maxTokens: 32000 },
            { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', contextWindow: 200000, maxTokens: 64000 },
            { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', contextWindow: 200000, maxTokens: 64000 },
          ],
        },
      },
    }
    try {
      // Use update (deep merge) if available, else mutate
      if (typeof settings.update === 'function') {
        await settings.update('llm-pi-ai', patch)
      } else if (typeof settings.mutate === 'function') {
        // JSON-patch style
        await settings.mutate('llm-pi-ai', [{ op: 'add', path: ['providers', PROVIDER_KEY], value: patch.providers[PROVIDER_KEY] }])
      } else {
        // fallback: direct yaml edit
        const fsMod = await import('node:fs')
        const osMod = await import('node:os')
        const pathMod = await import('node:path')
        const file = pathMod.join(osMod.homedir(), '.dsh', 'settings.yaml')
        let yaml = fsMod.readFileSync(file, 'utf8')
        if (!yaml.includes('anthropic:')) {
          const block = [
            `    ${PROVIDER_KEY}:`,
            `      displayName: Anthropic`,
            `      apiKeyEnv: ${CREDS_REF}`,
            `      api: anthropic-messages`,
            `      baseURL: https://api.anthropic.com`,
            `      models:`,
            `        - id: claude-sonnet-4-5`,
            `          name: Claude Sonnet 4.5`,
            `          contextWindow: 200000`,
            `          maxTokens: 64000`,
            `        - id: claude-opus-4-6`,
            `          name: Claude Opus 4.6`,
            `          contextWindow: 200000`,
            `          maxTokens: 32000`,
            `        - id: claude-haiku-4-5`,
            `          name: Claude Haiku 4.5`,
            `          contextWindow: 200000`,
            `          maxTokens: 64000`,
            `        - id: claude-opus-4-5`,
            `          name: Claude Opus 4.5`,
            `          contextWindow: 200000`,
            `          maxTokens: 64000`,
          ].join('\n') + '\n'
          if (yaml.includes('    qwen-token-plan:')) yaml = yaml.replace('    qwen-token-plan:', block + '    qwen-token-plan:')
          else yaml = yaml.replace(/(providers:\n)/, `$1${block}`)
          fsMod.writeFileSync(file, yaml)
        }
      }
      console.log('[anthropic-oauth] ensured llm-pi-ai.providers.anthropic in settings.yaml')
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
        await ensureAnthropicProvider()
        lastAuthState = { ok: true, message: 'bridged', expiresAt: oauth.expiresAt, tier: oauth.rateLimitTier || null, sub: oauth.subscriptionType || null }
        if (!lastSyncOk) console.log(`[anthropic-oauth] bridged token ${oauth.accessToken.slice(0, 22)}... expires ${new Date(oauth.expiresAt).toISOString()} sub=${oauth.subscriptionType || '?'} tier=${oauth.rateLimitTier || '?'}`)
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

  // Kick off immediately (don't block apply)
  void oneShot()

  // Poll every 60s (refresh skew is 5m)
  const schedule = () => {
    if (stopped) return
    timerHandle = setTimeout(async () => {
      await oneShot()
      schedule()
    }, 60_000)
  }
  schedule()

  // fs.watch on Claude credentials (debounced)
  void (async () => {
    try {
      const fsMod = await import('node:fs')
      const osMod = await import('node:os')
      const pathMod = await import('node:path')
      const file = pathMod.join(osMod.homedir(), '.claude', '.credentials.json')
      let debounce = null
      fsWatcher = fsMod.watch(file, () => {
        if (debounce) clearTimeout(debounce)
        debounce = setTimeout(() => { void oneShot() }, 400)
      })
      fsWatcher.on('error', () => {})
    } catch {}
  })()

  // Expose a tiny HTTP status endpoint via webServer for diagnostics (optional)
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
          res.end(JSON.stringify({ ...lastAuthState, now: Date.now(), synced: lastSyncOk }))
        },
      }))
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/api/anthropic-oauth/sync',
        handler: async (req, res) => {
          if (req.method !== 'POST') { res.statusCode = 405; res.end(); return }
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
