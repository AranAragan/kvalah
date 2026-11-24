// Per-kind outcome statistics that persist across sessions (feeds the adaptive router and dashboard).
import {readFile,writeFile,rename,mkdir,unlink} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
export function createStats({file=null}={}){
  let data={kinds:{}};let loaded=false,dirty=false,timer=null;
  const k=name=>data.kinds[name]??={n:0,ok:0,fail:0,ms:0,verified:0,findings:0,saved:0};
  // CACHE-01: unique temp file + private permissions for the persisted stats
  async function load(){if(loaded||!file)return;loaded=true;try{const d=JSON.parse(await readFile(file,'utf8'));if(d&&typeof d.kinds==='object')data=d;}catch{}}
  async function flush(){if(!file||!dirty)return;dirty=false;const tmp=`${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;try{await mkdir(path.dirname(file),{recursive:true,mode:0o700});await writeFile(tmp,JSON.stringify(data),{mode:0o600,flag:'wx'});await rename(tmp,file);}catch{await unlink(tmp).catch(()=>{});}}
  return {load,flush,
    record(kind,{ok,ms=0,verified=0,findings=0,saved=0}){const s=k(kind);s.n++;ok?s.ok++:s.fail++;s.ms+=ms;s.verified+=verified;s.findings+=findings;s.saved+=saved;dirty=true;
      if(file&&!timer){timer=setTimeout(()=>{timer=null;flush();},2000);timer.unref?.();}},
    get(kind){const s=data.kinds[kind];if(!s||!s.n)return null;return {n:s.n,successRate:s.ok/s.n,avgMs:s.ok?s.ms/s.n:null,verifiedRatio:s.findings?s.verified/s.findings:null,avgSavedUsd:s.saved/s.n};},
    all(){return Object.fromEntries(Object.keys(data.kinds).map(x=>[x,this.get(x)]));}};
}
