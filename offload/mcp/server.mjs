#!/usr/bin/env node
// Kvalah Compute Offload — MCP server (official @modelcontextprotocol/sdk, stdio transport).
// stdout is reserved for MCP; diagnostics go to stderr.
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import {createKvalahOffload,KINDS,STRATEGIES,OPS,VERSION} from '../compute/index.mjs';
import {servicePaths,connectService,createServiceApp,electService} from '../compute/service.mjs';
import crypto from 'node:crypto';
import {defaultDataDir} from '../compute/lan.mjs';
import {createPolicy,policyFromEnv} from '../compute/policy.mjs';
import {heuristicTokens} from '../compute/tokens.mjs';
import {applyOverhead} from '../compute/cost.mjs';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// v0.4 COMPUTE-01: a hash of everything that changes how the engine behaves (all KVALAH_* settings except the
// client-side MCP/service options, plus the resolved workspace). Only the hash leaves the process.
export function configFingerprint(env){
  const keys=Object.keys(env).filter(k=>k.startsWith('KVALAH_')&&!/^KVALAH_(SERVICE|MCP_)/.test(k)).sort();
  return crypto.createHash('sha256').update(JSON.stringify(keys.map(k=>[k,env[k]]))).digest('hex').slice(0,32);
}
export async function buildServer({env=process.env,provider=null,log:rawLog=m=>process.stderr.write('[kvalah-offload] '+m+'\n')}={}){
  let app=null,configError=null;
  // v0.4 SEC-04: a policy exists even when configuration fails, so config errors and logs are filtered too
  const basePolicy=(()=>{try{return createPolicy(policyFromEnv(env));}catch{return createPolicy();}})();
  const log=m=>rawLog(basePolicy.text(String(m)));
  // RUN-02: use the shared Kvalah Compute Service. KVALAH_SERVICE=auto (default): v0.4 COMPUTE-01 — connect to a
  // running service or, if none answers, win the election and host it in this process (others then connect), so
  // N MCP clients never build N engines. required = connect only (no hosting); off = in-process engine only.
  // connect = the v0.3 'auto' behaviour (use a running service, otherwise and on failover the in-process engine).
  // If election/connect fails in auto mode (e.g. different config or workspace), the in-process engine is used.
  const svcMode=['auto','connect','required','off'].includes(env.KVALAH_SERVICE)?env.KVALAH_SERVICE:'auto';
  const local=()=>createKvalahOffload({env,provider,log});
  if(svcMode!=='off'&&(!provider||env.KVALAH_SERVICE)){   // an injected provider (tests) uses the service only when asked
    const p=servicePaths(env,defaultDataDir(env));
    const ws=env.KVALAH_WORKSPACE||null;
    const int=(v,d)=>{const n=Number.parseInt(v??'',10);return Number.isFinite(n)&&n>0?n:d;};
    const fingerprint=configFingerprint(env);
    const connect=svcMode==='required'||svcMode==='connect'
      ?()=>connectService({socketPath:p.socket,tokenFile:p.tokenFile,workspace:ws,client:'mcp',priority:'interactive'})
      :async()=>{const r=await electService({socketPath:p.socket,tokenFile:p.tokenFile,workspace:ws,client:'mcp',priority:'interactive',fingerprint,log,
          createApp:()=>createKvalahOffload({env,provider,log}),
          serviceOptions:{maxActive:env.KVALAH_SERVICE_MAX_ACTIVE?int(env.KVALAH_SERVICE_MAX_ACTIVE,1):null,maxQueue:int(env.KVALAH_SERVICE_MAX_QUEUE,64),maxQueuePerClient:int(env.KVALAH_SERVICE_MAX_QUEUE_PER_CLIENT,16)}});
        if(r.host){r.conn.role='host';r.conn.closeHost=()=>r.host.close();}else r.conn.role='service';return r.conn;};
    try{const conn=await connect();app=createServiceApp({conn,connect,fallback:local,required:svcMode==='required',policy:createPolicy(policyFromEnv(env)),log});log('using compute service at '+p.socket+' as '+(conn.role||'client'));}
    catch(e){if(svcMode==='required'){configError='compute service unavailable: '+e.message;log(configError);}else log('compute service not used: '+e.message);}
  }
  if(!app&&!configError){try{app=await local();}catch(e){configError=e.message;log('config error: '+e.message);}}
  const files=!!env.KVALAH_WORKSPACE;
  const server=new McpServer({name:'kvalah-offload',title:'Kvalah Compute Offload',version:VERSION},{
    instructions:'Read-only offload to the user\'s machine. kvalah_compute: deterministic search/symbols/deps (no LLM). kvalah_delegate: local-model drafts over workspace paths. kvalah_auto: router picks. Local-model output is an unverified draft.'});
  // last line of defence (SEC-01): every result and error leaves through the policy
  const sanitize=v=>app?app.policy.output(v):v;
  // MCP-01: payload mode (KVALAH_MCP_PAYLOAD): both = JSON in text AND structuredContent (default, most compatible;
  // a client that shows both to the model pays twice — counted in duplicatedChars), structured = structuredContent
  // plus a one-line text pointer, text = text only. Results are capped at KVALAH_MCP_MAX_CHARS with flags.
  const mode=['both','structured','text'].includes(env.KVALAH_MCP_PAYLOAD)?env.KVALAH_MCP_PAYLOAD:'both';
  const maxChars=Math.max(2000,Math.min(1_000_000,Number.parseInt(env.KVALAH_MCP_MAX_CHARS??'',10)||60000));
  const mcp={mode,maxChars,responses:0,textChars:0,structuredChars:0,duplicatedChars:0,modelDuplicatedChars:0,truncatedResponses:0,errors:0,client:null,modelChannel:'unknown'};
  // v0.4 MCP-01: which channel the CLIENT forwards to its model (documented in docs/mcp-clients.md, with sources).
  // duplicatedChars = bytes sent twice on the local stdio pipe (free); modelDuplicatedChars = what the model may see
  // twice: 0 for clients known to forward one channel, worst case (all of it) for unknown clients.
  const classify=()=>{const ci=server.server.getClientVersion?.();if(!ci)return;const name=String(ci.name||'').slice(0,80);if(mcp.client===name)return;mcp.client=name;
    mcp.modelChannel=clientChannel(name);};
  const ok=raw=>{
    let v=sanitize(raw);v=Array.isArray(v)?{results:v}:v;
    const capped=capPayload(v,maxChars);if(capped!==v){mcp.truncatedResponses++;v=capped;}
    const json=JSON.stringify(v);mcp.responses++;
    if(mode==='text'){mcp.textChars+=json.length;return {content:[{type:'text',text:json}]};}
    if(mode==='structured'){const pointer=`structuredContent: ${Object.keys(v).slice(0,8).join(', ')}${v.truncated?' (truncated)':''}`.slice(0,190);mcp.textChars+=pointer.length;mcp.structuredChars+=json.length;return {content:[{type:'text',text:pointer}],structuredContent:v};}
    mcp.textChars+=json.length;mcp.structuredChars+=json.length;mcp.duplicatedChars+=json.length;classify();if(mcp.modelChannel==='unknown')mcp.modelDuplicatedChars+=json.length;
    return {content:[{type:'text',text:json}],structuredContent:v};
  };
  // errors: message only (no stack), sanitized, ≤800 chars
  const fail=e=>{mcp.errors++;return {isError:true,content:[{type:'text',text:String((app?.policy||basePolicy).text(String(e?.message||e))).split('\n    at ')[0].slice(0,800)}]};};
  const guard=fn=>async(args,extra)=>{if(configError)return fail('Kvalah offload not configured: '+configError);try{return ok(await fn(args,extra));}catch(e){return fail(e);}};
  const ro={readOnlyHint:true,destructiveHint:false,openWorldHint:false};
  const taskShape={
    kind:z.enum(KINDS),
    instruction:z.string().min(1).max(4000).describe('What to produce and in which format'),
    context:z.string().max(24000).optional().describe('Short excerpt; prefer paths'),
    ...(files?{paths:z.array(z.string()).min(1).max(32).optional().describe('Workspace-relative files read locally'),
      tailBytes:z.number().int().positive().optional().describe('Last N bytes only (logs)')}:{}),
    query:z.string().max(500).optional().describe('Focus terms (relevance retrieval)'),
    strategy:z.enum(STRATEGIES).optional(),
  };
  const task=z.object(taskShape).strict();
  // v0.4 BENCH-05: record what the agent has to carry for this server (tool descriptions + schemas) and the Skill
  const toolDefs=[];{const reg=server.registerTool.bind(server);server.registerTool=(name,c,cb)=>{
    let schema=null;try{schema=z.toJSONSchema(c.inputSchema);}catch{}toolDefs.push({name,title:c.title,description:c.description,inputSchema:schema,annotations:c.annotations});return reg(name,c,cb);};}
  server.registerTool('kvalah_status',{title:'Kvalah: status',description:'Local model health, context window, enabled features, limits, prices. Once per session at most.',inputSchema:z.object({}).strict(),annotations:{...ro,idempotentHint:true}},
    guard(()=>app.status()));
  server.registerTool('kvalah_compute',{title:'Kvalah: deterministic compute (no LLM)',
    description:`Deterministic workspace ops, no LLM: ${OPS.join(', ')}. search{pattern,regex?,glob?}, symbols{name?}, references{name} (textual), outline{path}, deps{path?}. Check precision/complete/truncated.`,
    inputSchema:z.object({op:z.enum(OPS),pattern:z.string().max(300).optional(),regex:z.boolean().optional(),caseSensitive:z.boolean().optional(),glob:z.string().max(200).optional(),contextLines:z.number().int().min(0).max(5).optional(),
      name:z.string().max(200).optional(),fuzzy:z.boolean().optional(),path:z.string().max(1000).optional(),paths:z.array(z.string()).max(2000).optional(),maxResults:z.number().int().min(1).max(5000).optional(),full:z.boolean().optional()}).strict(),
    annotations:{...ro,idempotentHint:true}},guard((a,x)=>app.compute(a,{signal:x.signal})));
  server.registerTool('kvalah_delegate',{title:'Kvalah: delegate to local model',
    description:'Read-only draft by the LOCAL model (logs, summaries, doc/test drafts, pre-review, transforms) over workspace paths. Check coverage, quoteVerified (quote exists, not correctness) and warnings. Unverified draft.',
    inputSchema:task,annotations:{...ro,idempotentHint:false}},guard((a,x)=>app.engine.delegate(a,{signal:x.signal})));
  server.registerTool('kvalah_batch',{title:'Kvalah: delegate up to 4 tasks',description:'1–4 independent kvalah_delegate tasks; failures isolated.',
    inputSchema:z.object({tasks:z.array(task).min(1).max(4)}).strict(),annotations:{...ro,idempotentHint:false}},guard((a,x)=>app.engine.batch(a,{signal:x.signal})));
  server.registerTool('kvalah_auto',{title:'Kvalah: auto-route',
    description:'Router: L1 deterministic, L2 local model, or L3 (do it yourself) with route.reason. Security decisions and small or already-read inputs go to L3.',
    inputSchema:z.object({goal:z.string().min(1).max(4000),...(files?{paths:z.array(z.string()).min(1).max(32).optional()}:{}),context:z.string().max(24000).optional(),query:z.string().max(500).optional(),kind:z.enum(KINDS).optional(),prefer:z.enum(['auto','local']).optional(),contextAlreadyLoaded:z.boolean().optional(),alreadyRead:z.array(z.string().max(4096)).max(32).optional().describe('paths you already read')}).strict(),
    annotations:{...ro,idempotentHint:false}},guard((a,x)=>app.auto(a,{signal:x.signal})));
  server.registerTool('kvalah_metrics',{title:'Kvalah: metrics & savings',description:'Session metrics: calls, tokens, cache, outcomes, MCP payload size, estimated savings (USD only with configured prices).',inputSchema:z.object({}).strict(),annotations:{...ro,idempotentHint:true}},
    guard(async()=>({...await app.engine.metrics(),mcp:{...mcp}})));
  const overhead={toolSchemaTokens:heuristicTokens(JSON.stringify(toolDefs)),skillTokens:skillTokens(env),source:'MCP tools/list size + SKILL.md (heuristic tokens)'};
  if(app&&!app.remote)app.engine.setOverhead?.(overhead);
  if(app?.remote){const m0=app.engine.metrics;app.engine.metrics=async()=>{const m=await m0();return m?.savings?{...m,savings:applyOverhead(m.savings,overhead,m.pricing)}:m;};}
  return {server,app,configError,overhead};
}
// v0.4 MCP-01: known model-facing channel per client (see docs/mcp-clients.md for the sources).
//   Codex: structuredContent only when present (openai/codex PR #2594; issue #10334)
//   Claude Code: structuredContent preferred since v2.0.21 (anthropics/claude-code issue #9962)
//   Cursor: text content only; structured-only results reach the model empty (forum.cursor.com thread 167346)
export function clientChannel(name){
  const n=String(name||'').toLowerCase();
  if(/codex/.test(n))return 'structuredContent';
  if(/claude[- ]?code/.test(n))return 'structuredContent';
  if(/cursor/.test(n))return 'content';
  return 'unknown';
}
function skillTokens(env){
  const file=env.KVALAH_SKILL_FILE||path.join(path.dirname(fileURLToPath(import.meta.url)),'..','skill','SKILL.md');
  try{return heuristicTokens(readFileSync(file,'utf8'));}catch{return 0;}
}

import {realpathSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const isMain=(()=>{try{return !!process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href;}catch{return false;}})();
if(isMain){
  const {server,app}=await buildServer();
  const transport=new StdioServerTransport();
  await server.connect(transport);
  const shutdown=async()=>{try{await app?.close();}catch{}process.exit(0);};
  process.stdin.on('close',shutdown);process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
}

// MCP-01: bound a result to maxChars of JSON. Repeatedly halves the largest array (depth ≤ 2) and cuts long
// strings, recording what was dropped in payloadTruncated and setting truncated:true. Never silent.
export function capPayload(v,maxChars){
  if(JSON.stringify(v).length<=maxChars)return v;
  const out=structuredClone(v);const dropped={};
  const arrays=()=>{const list=[];const visit=(o,pathKey,d)=>{if(!o||typeof o!=='object'||d>2)return;for(const [k,x] of Object.entries(o)){if(Array.isArray(x)&&x.length>1)list.push({o,k,key:pathKey?pathKey+'.'+k:k,len:JSON.stringify(x).length});else if(x&&typeof x==='object'&&!Array.isArray(x))visit(x,pathKey?pathKey+'.'+k:k,d+1);}};visit(out,'',0);return list.sort((a,b)=>b.len-a.len);};
  for(let i=0;i<60&&JSON.stringify(out).length>maxChars;i++){
    const [big]=arrays();
    if(big){const arr=big.o[big.k];const keep=Math.floor(arr.length/2);dropped[big.key]=(dropped[big.key]||0)+arr.length-keep;big.o[big.k]=arr.slice(0,keep);continue;}
    let cut=false;for(const k of ['draft','output','summary','graph']){if(typeof out[k]==='string'&&out[k].length>500){const n=Math.floor(out[k].length/2);dropped[k]=(dropped[k]||0)+out[k].length-n;out[k]=out[k].slice(0,n);cut=true;break;}if(out[k]&&typeof out[k]==='object'){dropped[k]=1;delete out[k];cut=true;break;}}
    if(!cut)break;
  }
  out.truncated=true;out.payloadTruncated={...dropped,maxChars};
  if(JSON.stringify(out).length>maxChars)return {truncated:true,payloadTruncated:{all:true,maxChars},notice:'Result too large for KVALAH_MCP_MAX_CHARS; narrow the request (glob, maxResults, query).'};
  return out;
}
