// Live resource use of this computer for the sidebar indicator and for /peer/activity:
// CPU %, RAM, GPU memory (cheap sources only), network rates of the pool/RPC/task traffic and
// tokens per second. Everything is sampled on demand (about once a second) and cached.
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';

const run=(file,args,timeout=3000)=>new Promise(resolve=>{execFile(file,args,{timeout,windowsHide:true,encoding:'utf8'},(e,out)=>resolve(e?null:String(out||'')));});

// "name, used MiB, total MiB, util %" lines of nvidia-smi --query-gpu.
export function parseNvidiaSmi(text){
  const out=[];
  for(const line of String(text||'').split(/\r?\n/)){
    const p=line.split(',').map(s=>s.trim());if(p.length<3||!p[0])continue;
    const used=Number(p[1]),total=Number(p[2]),util=Number(p[3]);
    if(Number.isFinite(used)&&Number.isFinite(total)&&total>0)out.push({name:p[0],usedMiB:used,totalMiB:total,util:Number.isFinite(util)?util:null});
  }
  return out;
}
async function amdSysfs(){
  const out=[];let cards=[];
  try{cards=(await fs.readdir('/sys/class/drm')).filter(n=>/^card\d+$/.test(n));}catch{return out;}
  for(const c of cards){
    const d=path.join('/sys/class/drm',c,'device');
    try{
      const [used,total]=await Promise.all(['mem_info_vram_used','mem_info_vram_total'].map(f=>fs.readFile(path.join(d,f),'utf8').then(Number)));
      let util=null;try{util=Number(await fs.readFile(path.join(d,'gpu_busy_percent'),'utf8'));}catch{}
      if(total>0)out.push({name:'AMD GPU ('+c+')',usedMiB:Math.round(used/2**20),totalMiB:Math.round(total/2**20),util});
    }catch{}
  }
  return out;
}
// Rate (per second) of a monotonically growing counter.
export function createRate(windowMs=3000){
  let samples=[];
  return {
    push(value,at=Date.now()){samples.push([at,value]);samples=samples.filter(([t])=>at-t<=windowMs);},
    get(at=Date.now()){
      const s=samples.filter(([t])=>at-t<=windowMs);if(s.length<2)return 0;
      const [t0,v0]=s[0],[t1,v1]=s[s.length-1];return t1>t0?Math.max(0,(v1-v0)*1000/(t1-t0)):0;
    }
  };
}
export function cpuTimes(cpus=os.cpus()){let idle=0,total=0;for(const c of cpus){for(const v of Object.values(c.times))total+=v;idle+=c.times.idle;}return {idle,total};}

export function createActivity({platform=process.platform,gpuEveryMs=3000}={}){
  let lastCpu=cpuTimes(),cpuPct=0,lastSample=0;
  let tokens=0;const tokRate=createRate(3000),upRate=createRate(3000),downRate=createRate(3000);
  let gpus=[],gpuAt=0,gpuPending=null,nvidia=undefined;
  async function readGpus(){
    if(nvidia!==false){
      const out=await run(platform==='win32'?'nvidia-smi.exe':'nvidia-smi',['--query-gpu=name,memory.used,memory.total,utilization.gpu','--format=csv,noheader,nounits']);
      if(out!==null){nvidia=true;return parseNvidiaSmi(out);}
      nvidia=false;
    }
    if(platform==='linux')return amdSysfs();
    return [];
  }
  function refreshGpus(){
    if(gpuPending||Date.now()-gpuAt<gpuEveryMs)return;
    gpuPending=readGpus().then(g=>{gpus=g;}).catch(()=>{}).finally(()=>{gpuAt=Date.now();gpuPending=null;});
  }
  return {
    // Generated tokens (a streamed chunk is about one token).
    addTokens(n=1){tokens+=n;},
    sample({bytesUp=0,bytesDown=0}={}){
      const now=Date.now();
      if(now-lastSample>=500){
        const c=cpuTimes(),dt=c.total-lastCpu.total;
        if(dt>0)cpuPct=Math.round(100*(1-(c.idle-lastCpu.idle)/dt));
        lastCpu=c;lastSample=now;
      }
      tokRate.push(tokens,now);upRate.push(bytesUp,now);downRate.push(bytesDown,now);
      refreshGpus();
      const total=os.totalmem(),free=os.freemem();
      // Apple GPUs share RAM: the RAM figure is the GPU memory too.
      const gpu=gpus.length?gpus:platform==='darwin'&&process.arch!=='ia32'?[{name:'Apple GPU',shared:true,usedMiB:Math.round((total-free)/2**20),totalMiB:Math.round(total/2**20),util:null}]:[];
      return {cpu:Math.max(0,Math.min(100,cpuPct)),cpus:os.cpus().length,ram:{used:total-free,total},gpus:gpu,
        net:{up:Math.round(upRate.get(now)),down:Math.round(downRate.get(now))},tps:Math.round(tokRate.get(now)*10)/10,at:now};
    }
  };
}
