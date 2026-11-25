// Resource Governor (spec §10): priority-ordered policy decisions, cooperative GPU duty cycle at microstep
// boundaries, daily wall-time budget that survives restarts, and measured (not promised) utilisation.
import fs from 'node:fs';
import path from 'node:path';
import {validatePolicy,DEFAULT_POLICY} from './policy.mjs';
const MIN=60e3;
const localDay=ts=>{const d=new Date(ts);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');};
const minutesOf=s=>{const [h,m]=s.split(':').map(Number);return h*60+m;};
export function inQuiet(q,ts){if(!q.enabled)return false;const d=new Date(ts),m=d.getHours()*60+d.getMinutes(),a=minutesOf(q.from),b=minutesOf(q.to);return a<=b?m>=a&&m<b:m>=a||m<b;}
export function createGovernor({stateDir,now=Date.now,mono=()=>performance.now(),policy=DEFAULT_POLICY,dayKey=localDay}={}){
  let pol=validatePolicy(policy,{...DEFAULT_POLICY,revision:policy.revision||0});
  let manualPause=false,disabled=true,sensors={},broker=new Map(),thermalTrip=null,thermalCoolSince=null;
  const window=[];                     // {start,end,active} in monotonic ms, last 5 min
  const ledgerFile=stateDir?path.join(stateDir,'budget.json'):null;
  let ledger={version:1,days:{},max_day:null};
  if(ledgerFile){try{ledger={...ledger,...JSON.parse(fs.readFileSync(ledgerFile,'utf8'))};}catch{}}
  let dirty=false,lastSave=0,serverOffset=null;
  function today(){
    // Coordinator time is authoritative when known; a clock moved backwards cannot return to an earlier
    // day with unused budget (the ledger only moves forward).
    let k=dayKey(now()+(serverOffset||0));
    if(ledger.max_day&&k<ledger.max_day)k=ledger.max_day;
    return k;
  }
  function day(){const k=today();ledger.days[k]??={wall_ms:0,gpu_ms:0,cpu_ms:0,bytes:0};if(!ledger.max_day||k>ledger.max_day)ledger.max_day=k;return ledger.days[k];}
  function save(force){
    if(!ledgerFile||(!dirty&&!force))return;
    if(!force&&now()-lastSave<10e3)return;
    const keys=Object.keys(ledger.days).sort();for(const k of keys.slice(0,-40))delete ledger.days[k];
    const tmp=ledgerFile+'.tmp';fs.mkdirSync(path.dirname(ledgerFile),{recursive:true});fs.writeFileSync(tmp,JSON.stringify(ledger));fs.renameSync(tmp,ledgerFile);dirty=false;lastSave=now();
  }
  const budgetMs=()=>pol.daily_hours*3600e3;
  // Decision in the spec's priority order. Returns {run, reason, resume}.
  function decide({phase='compute'}={}){
    const s=sensors,t=now();
    if(disabled)return {run:false,reason:'disabled',resume:'enable participation'};
    if(manualPause)return {run:false,reason:'manual_pause',resume:'press Resume'};
    // Safety: temperature (with hysteresis + sustained cool-down), thermal state, power, memory.
    const temp=s.gpu?.temperature_c;
    if(Number.isFinite(temp)){
      if(temp>=pol.temp_limit_c){thermalTrip=t;thermalCoolSince=null;}
      else if(thermalTrip){if(temp<=pol.temp_limit_c-pol.temp_hysteresis_c){thermalCoolSince??=t;if(t-thermalCoolSince>=30e3)thermalTrip=null;}else thermalCoolSince=null;}
    }
    if(thermalTrip)return {run:false,reason:'temperature',resume:`GPU below ${pol.temp_limit_c-pol.temp_hysteresis_c} °C for 30 s`};
    if(['serious','critical'].includes(s.thermal_state))return {run:false,reason:'thermal_state',resume:'system thermal state back to nominal/fair'};
    if(pol.only_ac){
      if(s.on_battery===true)return {run:false,reason:'on_battery',resume:'connect to mains power'};
      if(s.on_battery==null)return {run:false,reason:'sensor_unavailable_power',resume:'power state unknown; untick "only on mains power" to allow'};
    }else if(s.on_battery===true&&Number.isFinite(s.battery_pct)&&s.battery_pct<pol.battery_floor_pct)return {run:false,reason:'battery_floor',resume:`battery above ${pol.battery_floor_pct}%`};
    if(Number.isFinite(s.ram_free_bytes)&&s.ram_free_bytes<pol.min_free_ram_gib*2**30&&phase==='preflight')return {run:false,reason:'low_memory',resume:`at least ${pol.min_free_ram_gib} GiB free RAM`};
    if(s.memory_pressure==='critical')return {run:false,reason:'memory_pressure',resume:'memory pressure back to normal'};
    // Resource broker: Kvalah's own agent/chat and the Offload service have priority.
    if(pol.pause_on_local_ai&&[...broker.values()].some(Boolean))return {run:false,reason:'local_ai',resume:'local AI request finished'};
    // Budget, schedule, idle, games.
    if(day().wall_ms>=budgetMs())return {run:false,reason:'daily_budget',resume:'next day (local time)'};
    if(inQuiet(pol.quiet_hours,t))return {run:false,reason:'quiet_hours',resume:'end of quiet hours '+pol.quiet_hours.to};
    if(pol.only_idle){
      if(!Number.isFinite(s.idle_s))return {run:false,reason:'sensor_unavailable_idle',resume:'idle time unknown; untick "only when idle" to allow'};
      if(s.idle_s<pol.idle_minutes*60)return {run:false,reason:'user_active',resume:`no input for ${pol.idle_minutes} min`};
    }
    if(pol.pause_on_games){
      if(s.game===true)return {run:false,reason:'game',resume:'game or full-screen 3D app closed'};
      if(s.game==null)return {run:false,reason:'sensor_unavailable_game',resume:'game detection is not available here; untick "pause for games" to allow'};
    }
    if(pol.pause_on_fullscreen&&s.fullscreen===true)return {run:false,reason:'fullscreen',resume:'full-screen app or call ended'};
    if(!pol.allow_metered&&s.metered===true&&phase==='network')return {run:false,reason:'metered_network',resume:'unmetered network'};
    if(day().bytes>=pol.daily_traffic_mb*1e6&&phase==='network')return {run:false,reason:'traffic_cap',resume:'next day'};
    if(pol.gpu_target_pct===0)return {run:false,reason:'gpu_zero',resume:'raise the GPU time share above 0%'};
    return {run:true,reason:null};
  }
  function prune(m){while(window.length&&window[0].end<m-5*MIN)window.shift();}
  // Measured active share: each microstep counts as busy during [end-active, end]; span starts at the first sample.
  function fraction(spanMs){
    const m=mono();prune(m);if(!window.length)return null;
    const from=m-spanMs;let a=0;
    for(const w of window)a+=Math.max(0,w.end-Math.max(w.end-w.active,from));
    const span=m-Math.max(from,window[0].start);return span>0?Math.min(1,a/span):null;
  }
  // Cooperative duty cycle: after a synchronized microstep that kept the GPU busy for `activeMs`, return how
  // long to sleep so the active share over the sliding 60 s window approaches the target (no hard cap).
  function afterStep(activeMs,{startedMono,endedMono=mono()}={}){
    window.push({start:startedMono??endedMono-activeMs,end:endedMono,active:activeMs});
    const f=pol.gpu_target_pct/100;if(f>=1)return 0;if(f<=0)return Infinity;
    const base=activeMs*(1-f)/f;
    const m=mono(),from=m-MIN;let A=0,W0=m;for(const w of window)if(w.end>=from){A+=w.active;W0=Math.min(W0,w.start);}
    const W=m-Math.max(W0,from);const corr=A/f-W;
    return Math.max(0,Math.min(Math.max(base,corr),activeMs*(1-f)/f*3+1000));
  }
  function account({wallMs=0,gpuMs=0,cpuMs=0,bytes=0}){const d=day();d.wall_ms+=wallMs;d.gpu_ms+=gpuMs;d.cpu_ms+=cpuMs;d.bytes+=bytes;dirty=true;save(false);}
  return {
    decide,afterStep,account,save:()=>save(true),
    get policy(){return pol;},
    setPolicy(input,expectedRevision){
      if(expectedRevision!==undefined&&expectedRevision!==pol.revision){const e=Error('policy changed elsewhere; reload');e.code='CONFLICT';throw e;}
      const next=validatePolicy(input,pol);next.revision=pol.revision+1;pol=next;return pol;
    },
    restorePolicy(p){pol=validatePolicy(p,{...DEFAULT_POLICY,revision:p.revision||0});pol.revision=p.revision||0;},
    setSensors(s){sensors={...sensors,...s,at:now()};},get sensors(){return sensors;},
    setBroker(id,busy){if(busy)broker.set(id,true);else broker.delete(id);},
    get brokerBusy(){return [...broker.keys()];},
    setManualPause(v){manualPause=!!v;},get manualPause(){return manualPause;},
    setEnabled(v){disabled=!v;},
    setServerOffset(ms){if(Number.isFinite(ms))serverOffset=ms;},
    budget(){const d=day();return {day:today(),used_wall_ms:d.wall_ms,used_gpu_ms:d.gpu_ms,used_cpu_ms:d.cpu_ms,bytes:d.bytes,limit_ms:budgetMs(),remaining_ms:Math.max(0,budgetMs()-d.wall_ms)};},
    month(){const k=today().slice(0,7);let wall=0,gpu=0,bytes=0;for(const [d,v] of Object.entries(ledger.days))if(d.startsWith(k)){wall+=v.wall_ms;gpu+=v.gpu_ms;bytes+=v.bytes;}return {month:k,wall_ms:wall,gpu_ms:gpu,bytes};},
    measured(){return {active_fraction_60s:fraction(MIN),active_fraction_5m:fraction(5*MIN)};},
    cpuThreads(logical){return Math.max(1,Math.floor(pol.cpu_target_pct/100*logical));}
  };
}
