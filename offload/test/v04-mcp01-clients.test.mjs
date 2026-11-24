// v0.4 MCP-01: the default payload (content + structuredContent) is the only one every documented client handles;
// the model sees ONE copy in Codex / Claude Code (structuredContent) and Cursor (content). Only unknown clients may
// see it twice — counted as modelDuplicatedChars (worst case). Wire duplication (local stdio) is reported apart.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {buildServer,clientChannel} from '../mcp/server.mjs';
import {workspace,smartMock} from './helpers.mjs';

async function run(clientName,env={}){
  const root=await workspace({'a.js':'export const x=1;\n'});
  const {server,app}=await buildServer({env:{KVALAH_MODEL:'mock',KVALAH_WORKSPACE:root,KVALAH_CACHE:'off',...env},provider:smartMock(),log:()=>{}});
  const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);
  const c=new Client({name:clientName,version:'1'});await c.connect(ct);
  const r=await c.callTool({name:'kvalah_compute',arguments:{op:'stats'}});
  const m=(await c.callTool({name:'kvalah_metrics',arguments:{}})).structuredContent;
  await c.close();await app.close();return {r,m};
}
test('v04 MCP-01: client channel table', ()=>{
  assert.equal(clientChannel('codex-mcp-client'),'structuredContent');assert.equal(clientChannel('claude-code'),'structuredContent');
  assert.equal(clientChannel('cursor-vscode'),'content');assert.equal(clientChannel('some-ide'),'unknown');
});
test('v04 MCP-01: default "both" → no model-side duplication for known clients, worst case counted for unknown', async()=>{
  for(const [name,channel] of [['claude-code','structuredContent'],['codex-mcp-client','structuredContent'],['cursor-vscode','content']]){
    const {r,m}=await run(name);
    assert.ok(r.structuredContent&&r.content[0].text.startsWith('{'),'both channels carry the full result');
    assert.equal(m.mcp.client,name);assert.equal(m.mcp.modelChannel,channel);assert.equal(m.mcp.modelDuplicatedChars,0,name);assert.ok(m.mcp.duplicatedChars>0,'wire duplication still reported');
  }
  const {m}=await run('unknown-client');assert.equal(m.mcp.modelChannel,'unknown');assert.equal(m.mcp.modelDuplicatedChars,m.mcp.duplicatedChars);
});
