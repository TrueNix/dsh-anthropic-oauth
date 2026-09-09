import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

const text = value => typeof value === 'string' && value.length > 0
const fingerprint = oauth => createHash('sha256').update(JSON.stringify([
  oauth.accessToken, oauth.refreshToken, oauth.expiresAt, oauth.refreshTokenExpiresAt,
])).digest('hex')

export function createCredentialManager({ file, clientId, refreshUrl, skewMs = 300000, fetchImpl = fetch, now = Date.now } = {}) {
  const configured = process.env.CLAUDE_CONFIG_DIR
  const dir = configured ? resolve(configured.startsWith('~/') ? join(homedir(), configured.slice(2)) : configured) : join(homedir(), '.claude')
  file ??= join(dir, '.credentials.json')
  let pending = null
  let blocked = null
  let warning = null
  let closed = false
  const controller = new AbortController()

  async function read() {
    let raw, json
    try { raw = await readFile(file, 'utf8'); json = JSON.parse(raw) }
    catch { throw new Error('Claude credential file unavailable or invalid; run claude login.') }
    const oauth = json?.claudeAiOauth
    if (!oauth || !text(oauth.accessToken) || !Number.isFinite(oauth.expiresAt) || oauth.expiresAt <= 0) {
      throw new Error('Claude credentials lack a valid access token or expiry; run claude login. No refresh request was sent.')
    }
    return { file, raw, json, oauth, fingerprint: fingerprint(oauth) }
  }
  function usableOrLogin(snapshot, message) {
    warning = message
    if (snapshot.oauth.expiresAt > now()) return snapshot
    throw new Error(message + ' Access token has expired; run claude login.')
  }
  function reject(snapshot, message, retryAt = Infinity) {
    blocked = { fingerprint: snapshot.fingerprint, message, retryAt }
    return usableOrLogin(snapshot, message)
  }
  async function refresh() {
    if (closed) throw new Error('Credential manager stopped')
    let snapshot = await read()
    if (blocked?.fingerprint !== snapshot.fingerprint) { blocked = null; warning = null }
    if (snapshot.oauth.expiresAt - now() > skewMs) return snapshot
    if (blocked && now() < blocked.retryAt) return usableOrLogin(snapshot, blocked.message)
    const oauth = snapshot.oauth
    if (!text(oauth.refreshToken)) return reject(snapshot, 'Claude has no refresh token; a new login is required.')
    if (Number.isFinite(oauth.refreshTokenExpiresAt) && oauth.refreshTokenExpiresAt <= now()) {
      return reject(snapshot, 'Claude refresh token has expired; a new login is required.')
    }
    // A separate lock serializes this plugin across DSH processes. It is not
    // Claude Code's lock. Re-read after acquiring it and after the HTTP call.
    return withFileLock(file + '.dsh-refresh', async () => {
      if (closed) throw new Error('Credential manager stopped')
      const latest = await read()
      if (latest.raw !== snapshot.raw) { blocked = null; warning = null; return latest }
      snapshot = latest
      let response
      try {
        response = await fetchImpl(refreshUrl, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ grant_type: 'refresh_token', client_id: clientId, refresh_token: snapshot.oauth.refreshToken }),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        })
      } catch {
        if (closed) throw new Error('Credential manager stopped')
        const changed = await read()
        if (changed.raw !== snapshot.raw) { blocked = null; warning = null; return changed }
        return reject(snapshot, 'Claude refresh temporarily failed; retrying after one minute.', now() + 60000)
      }
      let data
      try { data = await response.json() } catch { data = null }
      const changed = await read()
      if (changed.raw !== snapshot.raw) { blocked = null; warning = null; return changed }
      if (closed) throw new Error('Credential manager stopped')
      if (!response.ok) {
        const permanent = response.status === 400 || response.status === 401 || response.status === 403
        return reject(snapshot, permanent ? 'Claude rejected this refresh token; refresh is paused until credentials change. Run claude login.' : 'Claude refresh service failed; retrying after one minute.', permanent ? Infinity : now() + 60000)
      }
      const expiry = now() + data?.expires_in * 1000
      if (!text(data?.access_token) || !Number.isFinite(data?.expires_in) || data.expires_in <= 0 || !Number.isSafeInteger(expiry) || (data.refresh_token !== undefined && !text(data.refresh_token))) {
        return reject(snapshot, 'Claude returned an invalid refresh response; credentials were not overwritten. Run claude login.')
      }
      const next = { ...snapshot.json, claudeAiOauth: {
        ...snapshot.oauth, accessToken: data.access_token,
        refreshToken: data.refresh_token ?? snapshot.oauth.refreshToken, expiresAt: expiry,
      } }
      if (data.refresh_token !== undefined && data.refresh_token !== snapshot.oauth.refreshToken) delete next.claudeAiOauth.refreshTokenExpiresAt
      if (Number.isFinite(data.refresh_token_expires_in) && data.refresh_token_expires_in > 0) {
        next.claudeAiOauth.refreshTokenExpiresAt = now() + data.refresh_token_expires_in * 1000
      }
      await writeFileAtomic(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, dirMode: 0o700 })
      blocked = null; warning = null
      return { file, json: next, oauth: next.claudeAiOauth }
    }, { waitMs: 20000 })
  }
  return {
    file,
    get warning() { return warning },
    get() {
      if (!pending) pending = refresh().finally(() => { pending = null })
      return pending
    },
    close() { closed = true; controller.abort() },
  }
}
