// In-process coordinator benchmark using an isolated SQLite database.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {createCoordinator} from '../../compute/coordinator/coordinator.mjs';

const output=process.argv[2];
if(!output)throw Error('Usage: node scripts/compute-v03/heartbeat.mjs output.jsonl');
fs.writeFileSync(output,'',{flag:'wx'});
const sizes=[10,50,100,500,1000,10000];
const samples=[];
for(const devices of sizes){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kvalah-v03-heartbeat-'));
  const coord=createCoordinator({dir});
  try{
    const ids=Array.from({length:devices},(_,i)=>'dev-'+i.toString(16).padStart(32,'0'));
    const create=coord.db.prepare(`insert into devices(id,public_key,alias,state,created_at,session_id)
      values(?, ?, ?, 'active', ?, 'isolated-synthetic-session')`);
    coord.db.exec('BEGIN');
    for(const id of ids)create.run(id,'fixture:'+id,id,Date.now());
    coord.db.exec('COMMIT');
    const times=[],begin=performance.now(),cpu=process.cpuUsage(),rss0=process.memoryUsage().rss;
    for(let repeat=0;repeat<3;repeat++)for(const id of ids){
      const start=performance.now();
      coord.heartbeat(id,{session_id:'isolated-synthetic-session',status:{state:'IDLE',eligible:true},metrics:{tasks_accepted:repeat}});
      times.push(performance.now()-start);
    }
    const elapsed=performance.now()-begin,usage=process.cpuUsage(cpu);
    times.sort((a,b)=>a-b);
    const pct=p=>times[Math.ceil(p*times.length)-1];
    const row={classification:'MEASURED',workload:'synthetic in-process heartbeats',devices,requests:times.length,
      wall_ms:elapsed,cpu_ms:(usage.user+usage.system)/1000,heartbeats_s:times.length*1000/elapsed,
      p50_ms:pct(.5),p95_ms:pct(.95),p99_ms:pct(.99),rss_before_bytes:rss0,rss_after_bytes:process.memoryUsage().rss,
      sqlite_bytes:fs.statSync(path.join(dir,'db','coordinator.sqlite')).size,sqlite_errors:0};
    fs.appendFileSync(output,JSON.stringify(row)+'\n');
    samples.push(row);
  }finally{coord.close();}
}
const keys=Object.keys(samples[0]);
fs.writeFileSync(output.replace(/\.jsonl$/,'.csv'),keys.join(',')+'\n'+samples.map(r=>keys.map(k=>JSON.stringify(r[k])).join(',')).join('\n')+'\n',{flag:'wx'});
console.log(JSON.stringify(samples.map(r=>({devices:r.devices,heartbeats_s:Math.round(r.heartbeats_s),p95_ms:r.p95_ms}))));
