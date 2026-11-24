// v0.4 UI-01/02/03 (offload dashboard side; the Kvalah Electron side is docs/kvalah-integration.patch).
// UI-02: the dashboard state and page must show active agents (service clients), the queue, device load and
// speed, errors and cancelled operations; UI-03: estimated and measured savings separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createKvalahOffload} from '../compute/index.mjs';
import {startService,connectService} from '../compute/service.mjs';
import {renderPage} from '../compute/dashboard.mjs';
import {smartMock,workspace} from './helpers.mjs';

test('v04 UI-02: state has agents, queue, device load/speed, errors and cancelled; page renders those sections', async()=>{
  const root=await workspace({'a.txt':'x\n'});const dir=await mkdtemp(path.join(tmpdir(),'kv4u-'));
  const app=await createKvalahOffload({env:{KVALAH_MODEL:'mock',KVALAH_WORKSPACE:root,KVALAH_CACHE:'off'},provider:smartMock({delay:30})});
  const svc=await startService({app,socketPath:path.join(dir,'s.sock'),tokenFile:path.join(dir,'t')});
  const c=await connectService({socketPath:path.join(dir,'s.sock'),tokenFile:path.join(dir,'t'),client:'codex',workspace:root});
  try{
    await c.call('delegate',{kind:'summarize',instruction:'sum',context:'some text here'});
    const ac=new AbortController();const p=c.call('delegate',{kind:'summarize',instruction:'sum2',context:'other text'},{signal:ac.signal});p.catch(()=>{});ac.abort();await p.catch(()=>{});
    const s=await app.state();
    assert.ok(Array.isArray(s.agents)&&s.agents.some(a=>a.client==='codex'),'active agents missing: '+JSON.stringify(s.agents));
    assert.ok(s.errors&&['failed','cancelled','queueTimeouts','execTimeouts','rejected'].every(k=>k in s.errors),'errors block missing: '+JSON.stringify(s.errors));
    assert.ok('service' in s.errors);
    const local=s.nodes.find(n=>n.name==='local');assert.ok('genTokensPerSec' in local&&'load' in local,'device speed/load missing: '+JSON.stringify(local));
    assert.ok(s.cost.estimated&&'measuredStatus' in s.cost,'UI-03 estimated/measured');
    const html=renderPage('tok','nonce');
    for(const id of ['agents','queue','nodes','errors'])assert.match(html,new RegExp(`id="${id}"`),id);
    assert.match(html,/tok\/s/);assert.match(html,/Saved \(estimated\)/);assert.match(html,/Saved \(measured\)/);
  }finally{await c.close();await svc.close();await app.close();}
});
