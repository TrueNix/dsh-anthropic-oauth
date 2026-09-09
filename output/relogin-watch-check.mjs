import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'
const home=await fs.mkdtemp(path.join(os.tmpdir(),'oauth-watch-'))
process.env.HOME=home;delete process.env.CLAUDE_CONFIG_DIR
const dir=path.join(home,'.claude');await fs.mkdir(dir)
const file=path.join(dir,'.credentials.json')
const payload=token=>JSON.stringify({claudeAiOauth:{accessToken:token,refreshToken:'fixture-refresh',expiresAt:Date.now()+3600000}})
await fs.writeFile(file,payload('fixture-first'),{mode:0o600})
let refreshCalls=0
const saved=[],disposers=[]
globalThis.fetch=async url=>{if(String(url).includes('/oauth/token'))refreshCalls++;return new Response(JSON.stringify(String(url).includes('/models')?{data:[{id:'fixture-model'}]}:{}),{status:200})}
const ctx={get(name){if(name==='credentials')return{set:async(key,value)=>saved.push(value)};if(name==='settings')return{get:()=>({}),update:async()=>{}};},effect(fn){const d=fn();if(d)disposers.push(d)}}
async function waitFor(token){const end=Date.now()+5000;while(!saved.includes(token)&&Date.now()<end)await new Promise(r=>setTimeout(r,25));assert.ok(saved.includes(token),'Automatic sync missing after login replacement')}
apply(ctx)
try{
await waitFor('fixture-first')
for(const token of ['fixture-second','fixture-third']){await fs.writeFile(file+'.replacement',payload(token),{mode:0o600});await fs.rename(file+'.replacement',file);await waitFor(token)}
assert.equal(refreshCalls,0)
console.log(JSON.stringify({atomicReloginsDetected:2,manualSyncs:0,refreshRequests:0,realCredentialsUsed:false}))
}finally{for(const d of disposers.reverse())await d();await new Promise(r=>setTimeout(r,20));await fs.rm(home,{recursive:true,force:true})}
