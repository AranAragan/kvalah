// MCP-01 regression: compact, bounded, honest MCP contract via the official SDK client.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fileURLToPath} from 'node:url';
import {buildServer} from '../mcp/server.mjs';
import {workspace,smartMock} from './helpers.mjs';

async function connect(env){
  const {server,app}=await buildServer({env:{KVALAH_MODEL:'mock',KVALAH_CACHE:'off',...env},provider:smartMock(),log:()=>{}});
  const [a,b]=InMemoryTransport.createLinkedPair();const c=new Client({name:'t',version:'1'});
  await Promise.all([server.connect(a),c.connect(b)]);return {c,app,close:async()=>{await c.close();await app?.close();}};
}
const many=Array.from({length:6000},(_,i)=>`const value${i} = compute(${i}); // match here`).join('\n');

test('MCP-01: payload modes — both (default, compatible), structured (short text), text (no structuredContent); doubling is measured', async()=>{
  const root=await workspace({'a.js':'export const hello=1;\n'});
  for(const mode of ['both','structured','text']){
    const s=await connect({KVALAH_WORKSPACE:root,KVALAH_MCP_PAYLOAD:mode});
    try{
      const r=await s.c.callTool({name:'kvalah_compute',arguments:{op:'search',pattern:'hello'}});
      const text=r.content[0].text;
      if(mode==='both'){assert.deepEqual(JSON.parse(text),r.structuredContent);}
      if(mode==='structured'){assert.ok(r.structuredContent.matches.length===1);assert.ok(text.length<200,'structured mode must not duplicate the payload in text');}
      if(mode==='text'){assert.equal(r.structuredContent,undefined);assert.equal(JSON.parse(text).matches.length,1);}
      const m=(await s.c.callTool({name:'kvalah_metrics',arguments:{}})).structuredContent??JSON.parse((await s.c.callTool({name:'kvalah_metrics',arguments:{}})).content[0].text);
      assert.equal(m.mcp.mode,mode);assert.ok(m.mcp.responses>=1);assert.ok(m.mcp.textChars>0);
      if(mode==='both')assert.ok(m.mcp.duplicatedChars>0,'duplicated payload must be accounted');
    }finally{await s.close();}
  }
});

test('MCP-01: results are capped with explicit truncation flags', async()=>{
  const root=await workspace({'big.js':many});
  const s=await connect({KVALAH_WORKSPACE:root,KVALAH_MCP_MAX_CHARS:'20000'});
  try{
    const r=await s.c.callTool({name:'kvalah_compute',arguments:{op:'search',pattern:'match here',maxResults:2000}});
    assert.ok(r.content[0].text.length<=20000,'text payload over cap: '+r.content[0].text.length);
    assert.equal(r.structuredContent.truncated,true);assert.ok(r.structuredContent.payloadTruncated?.matches>0,'dropped items not reported');
  }finally{await s.close();}
});

test('MCP-01: compact tool descriptions; safe errors', async()=>{
  const root=await workspace({'a.js':'x'});const s=await connect({KVALAH_WORKSPACE:root});
  try{
    const t=await s.c.listTools();
    const descr=t.tools.reduce((n,x)=>n+x.description.length,0);
    assert.ok(descr<=1000,'tool descriptions too long: '+descr);assert.ok(JSON.stringify(t).length<=6000,'tools/list too large: '+JSON.stringify(t).length);
    const e=await s.c.callTool({name:'kvalah_compute',arguments:{op:'outline',path:'../../etc/passwd'}});
    assert.equal(e.isError,true);assert.ok(!/\n\s+at /.test(e.content[0].text),'stack trace leaked');assert.ok(e.content[0].text.length<=800);
  }finally{await s.close();}
});

test('MCP-01: stdout carries only MCP frames (logs go to stderr) over real stdio', async()=>{
  const root=await workspace({'a.js':'x'});
  const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../mcp/server.mjs',import.meta.url))],
    env:{...process.env,KVALAH_MODEL:'mock',KVALAH_WORKSPACE:root,KVALAH_CACHE:'off',KVALAH_LOCAL_URL:'http://127.0.0.1:9'},stderr:'pipe'});
  let err='';transport.stderr?.on('data',d=>err+=d);
  const c=new Client({name:'t',version:'1'});await c.connect(transport);   // any non-JSON on stdout would break the handshake
  try{const t=await c.listTools();assert.equal(t.tools.length,6);const r=await c.callTool({name:'kvalah_compute',arguments:{op:'stats'}});assert.ok(!r.isError);}
  finally{await c.close();}
});
