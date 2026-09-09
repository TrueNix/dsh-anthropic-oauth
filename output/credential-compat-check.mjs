import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import {createRequire} from 'node:module';
const req=createRequire('/home/truenix/.local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js');
const {Context}=await import(req.resolve('@deepseek-ai/cordis'));
const {LocalCredentialProvider,parseCredentialsDocument}=await import(req.resolve('@deepseek-ai/dsh-credentials-local'));
const {apply}=await import('../lib/index.js');
const {BraveSearchProvider}=await import('/home/truenix/.dsh/profiles/web/node_modules/dsh-web-search-brave/lib/index.js');
const home=await fs.mkdtemp(os.tmpdir()+'/dsh-plugin-check-');process.env.HOME=home;delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.ANTHROPIC_OAUTH_TOKEN;delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
await fs.mkdir(home+'/.claude');await fs.mkdir(home+'/.dsh');
await fs.writeFile(home+'/.claude/.credentials.json',JSON.stringify({claudeAiOauth:{accessToken:'fixture-token',refreshToken:'fixture-refresh',expiresAt:Date.now()+86400000}}),{mode:0o600});
const file=home+'/.dsh/.credentials.yaml';
await fs.writeFile(file,'version: 1\nrefs:\n  PRESERVED_KEY: fixture-existing\nrecords:\n  test/session:\n    kind: grant\n    payload:\n      secret: fixture-secret\n',{mode:0o600});
await fs.writeFile(home+'/.dsh/settings.yaml','unchanged-settings-fixture\n');
globalThis.fetch=async url=>new Response(JSON.stringify(String(url).includes('/models')?{data:[{id:'fixture-model',display_name:'Fixture'}]}:{}),{status:200});
const root=new Context();await root.plugin(LocalCredentialProvider,{path:file,watch:false});
const credentials=root.get('credentials');
let passed=0;
async function scenario(kind){
 const handlers=new Map(),disposers=[],ops=[];
 let reject=false;
 const ctx={get(name){if(name==='credentials')return {set:async(...args)=>{if(reject||kind==='credential-failure')throw new Error('fixture failure');return credentials.set(...args);}};
 if(name==='settings')return {get:()=>({}),...(kind==='mutate'?{mutate:async(ns,p)=>{assert.equal(ns,'llm-pi-ai');assert.equal(p[0].op,'set');ops.push(p);}}:kind==='missing-settings'?{}:{update:async(ns,p)=>{assert.equal(ns,'llm-pi-ai');ops.push(p);}})};
 if(name==='webServer')return {register(route){handlers.set(route.path,route.handler);return()=>handlers.delete(route.path);}};},effect(fn){const dispose=fn();if(dispose)disposers.push(dispose);}};
 const call=async(path,method='GET')=>{let result;await handlers.get(path)({method,url:path},{setHeader(){},end(x){result=JSON.parse(x);}});return result;};
 apply(ctx);
 try{
 let status;const deadline=Date.now()+15000;
 do{await new Promise(r=>setTimeout(r,25));status=await call('/api/anthropic-oauth/status');}while(status.message==='initializing'&&Date.now()<deadline);
 assert.notEqual(status.message,'initializing');
 if(kind==='missing-settings'||kind==='credential-failure'){assert.equal(status.ok,false);}else{assert.equal(status.ok,true);assert.equal(ops.length,1);}
 if(kind==='credential-failure')assert.equal(status.synced,false);
 if(kind==='success-then-failure'){reject=true;await call('/api/anthropic-oauth/sync','POST');assert.equal((await call('/api/anthropic-oauth/status')).synced,false);}
 assert.equal(await fs.readFile(home+'/.dsh/settings.yaml','utf8'),'unchanged-settings-fixture\n');
 const parsed=parseCredentialsDocument(await fs.readFile(file,'utf8'),file);
 assert.equal(parsed.refs.get('PRESERVED_KEY'),'fixture-existing');assert.equal(parsed.records.get('test/session').payload.secret,'fixture-secret');
 passed++;console.log('PASS '+kind);
 }finally{for(const dispose of disposers.reverse())dispose();}
}
try{
 for(const kind of ['update','mutate','missing-settings','credential-failure','success-then-failure'])await scenario(kind);
 const intact=await fs.readFile(file,'utf8');const invalid='version: 1\nUNEXPECTED_ROOT: fixture-value\n';await fs.writeFile(file,invalid);
 await assert.rejects(credentials.set('ANTHROPIC_OAUTH_TOKEN','fixture-new'));
 assert.equal(await fs.readFile(file,'utf8'),invalid);await fs.writeFile(file,intact);passed++;console.log('PASS malformed store rejected without rewrite');
 const brave=new BraveSearchProvider(()=>({}));await assert.rejects(brave.apiKey({}),e=>e.message.includes('BRAVE_API_KEY')&&!(e instanceof ReferenceError));passed++;console.log('PASS Brave missing credential diagnostic');
 console.log(JSON.stringify({passed,externalRequests:0,realCredentialsUsed:false}));
}finally{await root.fiber.dispose();await fs.rm(home,{recursive:true,force:true});}
