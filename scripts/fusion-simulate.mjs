import fs from 'node:fs';
import {scheduleExperts} from '../compute/fusion/scheduler.mjs';

const output=process.argv[2];
if(!output)throw Error('node scripts/fusion-simulate.mjs <results.jsonl> [max-virtual-devices]');
const limit=Number(process.argv[3]??10000);
if(![3,10,100,1000,10000,100000].includes(limit))throw Error('unsupported simulation size');
const seed=197;
const configurations=[3,10,100,1000,10000,100000].filter(n=>n<=limit);
let randomState=seed;
function random(){
  randomState=(Math.imul(1664525,randomState)+1013904223)>>>0;
  return randomState/2**32;
}
function quantile(values,p){return values.length?values[Math.floor(p*(values.length-1))]:null;}

const observations=[];
for(const count of configurations){
  const now=1000000;
  const start=performance.now();
  let ineligible=0,assigned=0,disconnects=0,badPayloads=0,replays=0,stale=0,recovered=0,transferBytes=0;
  const jobs=[];
  for(let offset=0;offset<count;offset+=40){
    const n=Math.min(40,count-offset),group=`group-${offset/40}`;
    const devices=Array.from({length:n},(_,i)=>({
      id:`virtual-${offset+i}`,group,state:'active',consent:true,governor:{allowed:random()>0.1,target_pct:10+40*random()},
      last_seen:now-(random()<0.03?120000:1000),runtime:random()<0.24?'mlx':'cuda-nf4',free_ram:1e9+12e9*random(),
      free_vram:0.5e9+7.5e9*random(),free_disk:1e9,remaining_traffic:200000+5e7*random(),
      temp_c:46+40*random(),max_temp_c:80,bytes_per_s:4e5+25e6*random(),rtt_ms:1+180*random(),
      tokens_per_s:45+550*random(),resident:random()<0.5?'base':null,cold_start_s:8+20*random(),cache:random()<0.45?['expert']:[]
    }));
    const tasks=Array.from({length:Math.max(1,Math.floor(n*0.5))},(_,i)=>({
      id:`${group}-task-${i}`,expert:['code','math','language'][i%3],priority:i%3,group,runtimes:['mlx','cuda-nf4'],
      ram:5e9,vram:2.5e9,tokens:1500,backbone:'base',artifacts:[{sha256:'expert',bytes:6e6}]
    }));
    const scheduled=scheduleExperts(tasks,devices,{now});
    ineligible+=scheduled.pending.length;
    assigned+=scheduled.assigned.length;
    for(const task of scheduled.assigned){
      const offline=random()<0.06;
      disconnects+=Number(offline);badPayloads+=Number(random()<0.01);replays+=Number(random()<0.04);stale+=Number(random()<0.03);
      if(offline){if(random()<0.70)recovered++;else continue;}
      const regionalFault=random()<0.015?25:0;
      jobs.push(task.seconds+(offline?8:0)+regionalFault);transferBytes+=task.bytes;
    }
  }
  const scheduler_wall_ms=performance.now()-start;
  jobs.sort((a,b)=>a-b);
  observations.push({classification:'SIMULATED',seed,virtual_devices:count,assigned,ineligible,modeled:{disconnects,badPayloads,replays,stale,recovered,
    payload_bytes:transferBytes,p50_job_s:quantile(jobs,0.5),p95_job_s:quantile(jobs,0.95)},
    measurement:{scheduler_and_simulation_wall_ms:scheduler_wall_ms,node_rss_bytes:process.memoryUsage().rss}});
}
fs.writeFileSync(output,observations.map(row=>JSON.stringify(row)).join('\n')+'\n',{flag:'wx'});
console.log(JSON.stringify(observations));
