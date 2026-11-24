// Compute Dashboard: tiny loopback-only HTTP page (opt-in). Defenses: binds 127.0.0.1, random token
// required on every request, Host header must be the loopback origin (DNS-rebinding), strict CSP with nonce.
// UI-01: mutations (cancel a task, clear the workspace cache) are POST-only and additionally require the token
// in the X-Kvalah-Token header (never a URL), an Origin equal to the dashboard origin, no cross-site
// Sec-Fetch-Site, a JSON content type and a body ≤ 4 KB. Sources and paths are not shown by default.
import http from 'node:http';
import {createPolicy} from './policy.mjs';
import {randomBytes,timingSafeEqual,createHash} from 'node:crypto';
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const same=(a,b)=>typeof a==='string'&&timingSafeEqual(createHash('sha256').update(a).digest(),createHash('sha256').update(b).digest());
export function startDashboard({getState,port=0,host='127.0.0.1',actions={},policy=createPolicy()}){
  const token=randomBytes(16).toString('hex');
  const server=http.createServer(async (req,res)=>{
    const addr=server.address();const okHosts=[`127.0.0.1:${addr.port}`,`localhost:${addr.port}`];
    const u=new URL(req.url,'http://x');
    const sec={'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cache-Control':'no-store','X-Frame-Options':'DENY'};
    const deny=(code,msg)=>{res.writeHead(code,{...sec,'Content-Type':'text/plain'});res.end(msg);};
    const json=(code,v)=>{res.writeHead(code,{...sec,'Content-Type':'application/json'});res.end(JSON.stringify(v));};
    if(!okHosts.includes(req.headers.host))return deny(421,'bad host');
    const routes={'/api/cancel':'cancel','/api/cache/clear':'clearCache'};
    if(Object.hasOwn(routes,u.pathname)){
      if(req.method!=='POST')return deny(405,'method');
      if(!same(req.headers['x-kvalah-token'],token))return deny(401,'token required');
      if(!okHosts.map(h=>'http://'+h).includes(req.headers.origin))return deny(403,'bad origin');
      const site=req.headers['sec-fetch-site'];if(site&&site!=='same-origin')return deny(403,'cross-site');
      if(!/^application\/json\b/i.test(req.headers['content-type']||''))return deny(415,'json required');
      let body='';let size=0;
      for await(const ch of req){size+=ch.length;if(size>4096)return deny(413,'too large');body+=ch;}
      let data;try{data=body?JSON.parse(body):{};}catch{return deny(400,'bad json');}
      const fn=actions[routes[u.pathname]];if(!fn)return deny(404,'action unavailable');
      try{
        if(routes[u.pathname]==='cancel'){if(typeof data.id!=='string'||data.id.length>64)return deny(400,'id');return (await fn(data.id))?json(200,{cancelled:true}):json(404,{cancelled:false,error:'no running task with this id'});}
        return json(200,await fn());
      }catch(e){return json(500,{error:String(e?.message||e).slice(0,200)});}
    }
    if(req.method!=='GET')return deny(405,'method');
    if(!same(u.searchParams.get('t'),token))return deny(401,'token required');
    if(u.pathname==='/api/state'){
      let state;try{state=await getState();}catch(e){state={error:e.message};}
      return json(200,policy.output(state));   // v0.4 SEC-01: filtered here as well
    }
    if(u.pathname==='/'){
      const nonce=randomBytes(12).toString('base64');
      res.writeHead(200,{...sec,'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'`});
      return res.end(page(nonce,token));
    }
    deny(404,'not found');
  });
  return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>{const p=server.address().port;resolve({url:`http://127.0.0.1:${p}/?t=${token}`,port:p,token,close:()=>new Promise(r=>{server.closeAllConnections?.();server.close(()=>r());})});});});
}
function page(nonce,token){return `<!doctype html><html><head><meta charset="utf-8"><title>Kvalah Compute</title><style nonce="${nonce}">
body{font:14px system-ui,sans-serif;margin:24px;background:#0f1115;color:#e6e6e6}h1{font-size:18px}h2{font-size:15px;margin-top:24px}
.cards{display:flex;gap:12px;flex-wrap:wrap}.card{background:#1a1d24;border-radius:8px;padding:12px 16px;min-width:150px}.v{font-size:22px;font-weight:600}
table{border-collapse:collapse;width:100%;margin-top:8px}td,th{padding:4px 8px;border-bottom:1px solid #2a2e37;text-align:left;font-variant-numeric:tabular-nums}
button{background:#2a2e37;color:#e6e6e6;border:1px solid #444;border-radius:4px;padding:2px 8px;cursor:pointer}
.ok{color:#5fd38d}.bad{color:#ff6b6b}.muted{color:#8a8f98}</style></head><body>
<h1>Kvalah Compute Offload</h1><div class="muted" id="sub"></div>
<div class="cards" id="cards"></div>
<p class="muted">Estimated = token heuristics per task (incl. session overhead). Measured = only from a bench/ paired analysis with measured usage (KVALAH_BENCH_RESULTS); never derived from estimates.</p>
<h2>Agents</h2><table id="agents"></table>
<h2>Queue</h2><table id="queue"></table>
<h2>Errors &amp; cancelled</h2><table id="errors"></table>
<h2>Limits</h2><table id="limits"></table>
<h2>Devices</h2><table id="nodes"></table>
<h2>Recent tasks</h2><button id="clear">Clear cache (this workspace)</button><table id="tasks"></table>
<script nonce="${nonce}">
const T=${JSON.stringify(token)};const e=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const post=(p,b)=>fetch(p,{method:'POST',headers:{'Content-Type':'application/json','X-Kvalah-Token':T},body:JSON.stringify(b||{})});
document.getElementById('clear').addEventListener('click',async()=>{if(confirm('Clear the result cache of this workspace?')){await post('/api/cache/clear');tick();}});
document.getElementById('tasks').addEventListener('click',async ev=>{const id=ev.target?.dataset?.cancel;if(id){await post('/api/cancel',{id});tick();}});
const rows=o=>Object.entries(o||{}).filter(([,v])=>v!==null&&typeof v!=='object').map(([k,v])=>'<tr><td>'+e(k)+'</td><td>'+e(v)+'</td></tr>').join('');
async function tick(){try{const s=await (await fetch('/api/state?t='+T)).json();
document.getElementById('sub').textContent=s.model+' · '+s.provider+' · ctx '+s.ctxTokens+' · '+s.mode+(s.pricing&&!s.pricing.configured?' · prices not configured: USD unknown':'');
const m=s.metrics||{},sv=m.savings||{};const c=[['Saved (estimated)',sv.savedUsd==null?'unknown':'$'+sv.savedUsd.toFixed(4)],['Cloud tokens saved (estimated)',sv.netCloudTokensSaved||0],['Saved (measured)',m.measured&&m.measured.available?m.measured.savingsPct+'% · '+m.measured.verdict+' · '+m.measured.pairs+' pairs':'n/a ('+((m.measured&&m.measured.reason)||'no paired benchmark')+')'],['Cloud tokens saved after overhead (estimated)',sv.netCloudTokensSavedAfterOverhead==null?'-':sv.netCloudTokensSavedAfterOverhead],['Tasks',sv.tasks||0],['Pending',m.pending||0],['LLM calls',m.llmCalls||0],['Cache hits',m.cacheHits||0],['Errors',m.failed||0],['Local tokens',(m.localInputTokens||0)+(m.localOutputTokens||0)],['Quote-verified findings',(m.findingsVerified||0)+'/'+(m.findingsTotal||0)]];
document.getElementById('cards').innerHTML=c.map(([k,v])=>'<div class="card"><div class="muted">'+e(k)+'</div><div class="v">'+e(v)+'</div></div>').join('');
const q={...(s.queue||{}),...(s.service?{serviceQueued:s.service.queued,serviceActiveLlm:s.service.active?.llm,serviceClients:s.service.connections,serviceRejected:s.service.rejected}:{})};
document.getElementById('queue').innerHTML=rows(q);
document.getElementById('agents').innerHTML='<tr><th>agent</th><th>priority</th><th>scope</th><th>pending</th><th>leases</th></tr>'+((s.agents||[]).map(a=>'<tr><td>'+e(a.client)+'</td><td>'+e(a.priority??'-')+'</td><td>'+e(a.scope??'-')+'</td><td>'+e(a.pending??'-')+'</td><td>'+e(a.leases??'-')+'</td></tr>').join('')||'<tr><td colspan="5" class="muted">no service clients (in-process only)</td></tr>');
const er=s.errors||{};document.getElementById('errors').innerHTML=rows({failed:er.failed,cancelled:er.cancelled,queueTimeouts:er.queueTimeouts,execTimeouts:er.execTimeouts,rejected:er.rejected,...(er.service?{serviceFailed:er.service.failed,serviceCancelled:er.service.cancelled,serviceRejected:er.service.rejected,serviceQueueTimeouts:er.service.queueTimeouts,serviceProtocolErrors:er.service.protocolErrors}:{})});document.getElementById('limits').innerHTML=rows(s.limits);
document.getElementById('nodes').innerHTML='<tr><th>device</th><th>status</th><th>load</th><th>tok/s (measured)</th><th>TTFT</th><th>sched. ms</th><th>ok/failed</th></tr>'+(s.nodes||[]).map(n=>'<tr><td>'+e(n.name)+'</td><td class="'+(n.online?'ok':'bad')+'">'+(n.online?'online':'offline')+'</td><td>'+e(n.inflight)+'/'+e(n.maxParallel)+'</td><td>'+e(n.genTokensPerSec??'-')+'</td><td>'+e(n.ttftMs??'-')+' ms</td><td>'+e(n.ewmaMs??'-')+' ms</td><td>'+e(n.ok??'-')+'/'+e(n.failed??'-')+'</td></tr>').join('');
document.getElementById('tasks').innerHTML='<tr><th>time</th><th>tool</th><th>level</th><th>kind/op</th><th>strategy</th><th>Coverage</th><th>status</th><th>ms</th><th>saved $ (estimated)</th><th>error</th><th></th></tr>'+(s.tasks||[]).slice(0,50).map(t=>'<tr><td>'+new Date(t.at).toLocaleTimeString()+'</td><td>'+e(t.tool)+'</td><td>L'+e(t.level)+'</td><td>'+e(t.kind||t.op)+'</td><td>'+e(t.strategy||'-')+'</td><td>'+(t.coverage==null?'-':e(Math.round(t.coverage*100))+'%')+'</td><td class="'+(/fail|cancel|deadline/.test(t.status)?'bad':'ok')+'">'+e(t.status)+'</td><td>'+e(t.ms??'')+'</td><td>'+e(t.savedUsd??'')+'</td><td>'+e(t.error||'')+'</td><td>'+(t.cancellable&&t.status==='running'?'<button data-cancel="'+e(t.id)+'">Cancel</button>':'')+'</td></tr>').join('');
}catch(err){document.getElementById('sub').textContent='disconnected';}}
tick();setInterval(tick,2000);
</script></body></html>`;}
export {esc,page as renderPage};
