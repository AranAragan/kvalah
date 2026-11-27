// Discrete scenarios. This does not change interfaces or emulate TCP.
import fs from 'node:fs';
import {sha256} from '../../compute/protocol/hash.mjs';

const out=process.argv[2];
if(!out?.endsWith('.jsonl'))throw Error('Usage: node scenarios.mjs output.jsonl');
const distribution={
  msi:{tokens_s:360,startup_s:15.0,rate:1e8,rtt:.003,error:.01,memory_gib:5,available:true,budget:11000},
  rog:{tokens_s:220,startup_s:15.0,rate:1e7,rtt:.030,error:.08,memory_gib:4,available:true,budget:11000},
  mac:{tokens_s:130,startup_s:1.34,rate:5e7,rtt:.007,error:.02,memory_gib:9,available:true,budget:11000}
};

// All methods use precisely the same ordered examples and supervised-token total.
// Variable contiguous splits are experimental and are not used by the production scheduler.
function durations(rows,limits,names){
  let cursor=0;
  return limits.map((count,i)=>{
    const worker=distribution[names[i]],tokens=rows.slice(cursor,cursor+=count).reduce((a,b)=>a+b,0);
    const transmission=4264848*8/worker.rate+worker.rtt;
    const seconds=(worker.startup_s+tokens/worker.tokens_s+transmission)/(1-worker.error);
    return {worker:names[i],examples:count,tokens,seconds};
  });
}
function allocations(rows){
  const names=Object.keys(distribution).filter(n=>{
    const w=distribution[n];
    return w.available&&w.memory_gib>=3&&w.budget>=rows.reduce((a,b)=>a+b,0);
  });
  if(names.length!==3)throw Error('Fixture requires three eligible independent participants');
  const equal=durations(rows,[10,10,10],names);
  let best=equal;
  for(let i=4;i<=16;i++)for(let j=4;j<=16;j++){
    const k=30-i-j;
    if(k<4||k>16)continue;
    const candidate=durations(rows,[i,j,k],names);
    if(Math.max(...candidate.map(x=>x.seconds))<Math.max(...best.map(x=>x.seconds)))best=candidate;
  }
  return [equal,best];
}
const data=[];
const payload=4264848,chunk=262144;
for(const loss of [.001,.01,.03,.05])for(const rt of [5,20,50,100,200])for(const mbps of [10,50,100]){
  for(const mode of ['monolithic','chunked']){
    const units=mode==='monolithic'?1:Math.ceil(payload/chunk),first=mode==='monolithic'?payload:Math.min(chunk,payload);
    // Independent per-attempt failure probability, not a conversion from measured packet loss.
    const expectedBytes=payload/(1-loss),afterDisconnect=mode==='monolithic'?payload:payload-14*chunk;
    data.push({class:'SIMULATED',type:'transfer',mode,attempt_drop_probability:loss,rtt_ms:rt,mbps,
      base_payload:payload,expected_bytes:expectedBytes,expected_body_and_ack_s:expectedBytes*8/(mbps*1e6)+units*rt/1000/(1-loss),
      max_retry_unit_bytes:first,bytes_after_fixed_interrupt:afterDisconnect});
  }
}
const rows=Array.from({length:30},(_,i)=>40+(parseInt(sha256('slot:'+i).slice(0,4),16)%121));
for(const [i,slots] of allocations(rows).entries())
  data.push({class:'SIMULATED',type:'scheduler',mode:i?'variable-contiguous':'equal',slots,
    total:rows.reduce((a,b)=>a+b,0),critical_path_s:Math.max(...slots.map(x=>x.seconds))});
fs.writeFileSync(out,data.map(row=>JSON.stringify(row)).join('\n')+'\n',{flag:'wx'});
console.log(JSON.stringify(data.slice(-2)));
