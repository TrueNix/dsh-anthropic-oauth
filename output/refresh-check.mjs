import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { createCredentialManager } from '../lib/credentials.js'
const dir = await fs.mkdtemp(join(os.tmpdir(), 'oauth-refresh-check-'))
const epoch = 1800000000000
let passed = 0
const base = () => ({ mcpOAuth: { preserved: true }, claudeAiOauth: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: epoch + 120000, refreshTokenExpiresAt: epoch + 86400000 } })
const response = (status, data) => new Response(JSON.stringify(data), { status })
const refreshed = () => response(200, { access_token: 'fixture-rotated-access', refresh_token: 'fixture-rotated-refresh', expires_in: 3600, refresh_token_expires_in: 86400 })
async function scenario(name, test) {
  const file = join(dir, name + '.json')
  await fs.writeFile(file, JSON.stringify(base()), {mode:0o600})
  const managers = []
  const manager = (fetchImpl, now = () => epoch) => {const m = createCredentialManager({file,clientId:'fixture-client',refreshUrl:'https://fixture.invalid/oauth',fetchImpl,now});managers.push(m);return m}
  try { await test({file,manager}); passed++; console.log('PASS '+name) }
  finally { managers.forEach(m=>m.close()) }
}
try {
  await scenario('fresh-token-no-http', async ({file,manager}) => {const j=base();j.claudeAiOauth.expiresAt=epoch+3600000;await fs.writeFile(file,JSON.stringify(j));let calls=0;const m=manager(async()=>{calls++;return refreshed()});await m.get();assert.equal(calls,0)})
  await scenario('single-flight',async({file,manager})=>{let calls=0;const m=manager(async()=>{calls++;await new Promise(r=>setTimeout(r,20));return refreshed()});const requests=Array.from({length:20},()=>m.get());assert.equal(new Set(requests).size,1);await Promise.all(requests);assert.equal(calls,1);const j=JSON.parse(await fs.readFile(file,'utf8'));assert.equal(j.mcpOAuth.preserved,true);assert.equal(j.claudeAiOauth.refreshToken,'fixture-rotated-refresh');assert.equal((await fs.stat(file)).mode&511,0o600)})
  await scenario('separate-managers-share-lock',async({manager})=>{let calls=0;const fetcher=async()=>{calls++;await new Promise(r=>setTimeout(r,20));return refreshed()};await Promise.all([manager(fetcher).get(),manager(fetcher).get()]);assert.equal(calls,1)})
  await scenario('invalid-grant-pauses',async({file,manager})=>{let calls=0;let now=epoch;const m=manager(async()=>{calls++;return response(400,{error:'invalid_grant'})},()=>now);const before=await fs.readFile(file,'utf8');await m.get();await m.get();assert.equal(calls,1);assert.ok(m.warning.includes('paused'));assert.equal(await fs.readFile(file,'utf8'),before);now+=180000;await assert.rejects(m.get(),/Access token has expired/);assert.equal(calls,1)})
  await scenario('relogin-clears-pause',async({file,manager})=>{let calls=0;const m=manager(async()=>{calls++;return calls===1?response(400,{error:'invalid_grant'}):refreshed()});await m.get();const j=base();j.claudeAiOauth.refreshToken='new-login-refresh';await fs.writeFile(file,JSON.stringify(j));const s=await m.get();assert.equal(calls,2);assert.equal(s.oauth.accessToken,'fixture-rotated-access');assert.equal(m.warning,null)})
  await scenario('missing-refresh-no-http',async({file,manager})=>{const j=base();delete j.claudeAiOauth.refreshToken;await fs.writeFile(file,JSON.stringify(j));let calls=0;const m=manager(async()=>{calls++;return refreshed()});await m.get();assert.equal(calls,0);assert.ok(m.warning.includes('no refresh token'))})
  await scenario('missing-expiry-no-http',async({file,manager})=>{const j=base();delete j.claudeAiOauth.expiresAt;await fs.writeFile(file,JSON.stringify(j));let calls=0;const m=manager(async()=>{calls++;return refreshed()});await assert.rejects(m.get(),/valid access token or expiry/);assert.equal(calls,0)})
  await scenario('expired-refresh-no-http',async({file,manager})=>{const j=base();j.claudeAiOauth.refreshTokenExpiresAt=epoch-1;await fs.writeFile(file,JSON.stringify(j));let calls=0;const m=manager(async()=>{calls++;return refreshed()});await m.get();assert.equal(calls,0);assert.ok(m.warning.includes('has expired'))})
  await scenario('malformed-success-never-overwrites',async({file,manager})=>{const before=await fs.readFile(file,'utf8');let calls=0;const m=manager(async()=>{calls++;return response(200,{error:'unexpected'})});await m.get();await m.get();assert.equal(calls,1);assert.equal(await fs.readFile(file,'utf8'),before);assert.ok(m.warning.includes('invalid refresh response'))})
  for(const status of [200,400])await scenario('login-during-http-'+status,async({file,manager})=>{const j=base();j.claudeAiOauth.accessToken='new-login-access';j.claudeAiOauth.refreshToken='new-login-refresh';j.claudeAiOauth.expiresAt=epoch+7200000;const m=manager(async()=>{await fs.writeFile(file,JSON.stringify(j));return status===200?refreshed():response(400,{error:'invalid_grant'})});const s=await m.get();assert.equal(s.oauth.accessToken,'new-login-access');assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),j)})
  await scenario('optional-refresh-token-preserved',async({file,manager})=>{const m=manager(async()=>response(200,{access_token:'fixture-new-access',expires_in:3600}));await m.get();assert.equal(JSON.parse(await fs.readFile(file,'utf8')).claudeAiOauth.refreshToken,'fixture-refresh')})
  await scenario('transient-failure-backoff',async({manager})=>{let calls=0;let now=epoch;const m=manager(async()=>{calls++;return calls===1?response(503,{}):refreshed()},()=>now);await m.get();await m.get();assert.equal(calls,1);now+=61000;await m.get();assert.equal(calls,2)})
  console.log(JSON.stringify({passed,realCredentialsUsed:false,networkRequests:0}))
} finally { await fs.rm(dir,{recursive:true,force:true}) }
