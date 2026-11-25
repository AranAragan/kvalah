// Python compute sidecar supervisor. The sidecar has no network code: it reads app-owned files, trains on
// pre-tokenized rows and talks JSONL over stdio. Node starts it directly with argv (no shell), sanitises the
// environment (no API keys or tokens), lowers its priority, caps CPU threads and kills the whole process
// tree after a grace period on stop.
import {spawn} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const PY_ROOT=path.join(path.dirname(fileURLToPath(import.meta.url)),'..','python');
const PASS=['PATH','SYSTEMROOT','SystemRoot','WINDIR','TEMP','TMP','TMPDIR','HOME','USERPROFILE','LOCALAPPDATA','APPDATA','CUDA_PATH','CUDA_VISIBLE_DEVICES','LANG','LC_ALL','KVALAH_COMPUTE_TEST'];
export function sidecarEnv(threads,extra={}){
  const env={};
  for(const k of PASS)if(process.env[k]!=null)env[k]=process.env[k];
  Object.assign(env,{PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1',PYTHONUNBUFFERED:'1',PYTHONPATH:PY_ROOT,
    HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',HF_HUB_DISABLE_TELEMETRY:'1',TOKENIZERS_PARALLELISM:'false',
    OMP_NUM_THREADS:String(threads),MKL_NUM_THREADS:String(threads),OPENBLAS_NUM_THREADS:String(threads),VECLIB_MAXIMUM_THREADS:String(threads),
    PYTORCH_CUDA_ALLOC_CONF:'expandable_segments:True',KVALAH_SIDECAR_THREADS:String(threads)},extra);
  return env;
}
export function startSidecar({python,threads=1,onEvent=()=>{},onLog=()=>{},extraEnv}={}){
  if(!python)throw Object.assign(Error('no compute runtime configured (Python 3.12 with the CUDA or MLX packages)'),{code:'SETUP_REQUIRED'});
  const child=spawn(python,['-u','-m','kvalah_compute.sidecar'],{cwd:PY_ROOT,env:sidecarEnv(threads,extraEnv),stdio:['pipe','pipe','pipe'],windowsHide:true});
  try{os.setPriority(child.pid,os.constants.priority.PRIORITY_BELOW_NORMAL);}catch{}
  const waiters=new Map();let buf='',exited=null,seq=0;
  const exitP=new Promise(r=>child.on('exit',(code,signal)=>{exited={code,signal};for(const [,w] of waiters)w.reject(Object.assign(Error('compute sidecar exited ('+(code??signal)+')'),{code:'SIDECAR_EXIT'}));waiters.clear();r(exited);}));
  child.on('error',e=>{for(const [,w] of waiters)w.reject(e);waiters.clear();});
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);if(!line.trim())continue;let m;try{m=JSON.parse(line);}catch{onLog('non-JSON sidecar output dropped');continue;}
    if(m.id&&waiters.has(m.id)&&(m.type==='result'||m.type==='error')){const w=waiters.get(m.id);waiters.delete(m.id);m.type==='result'?w.resolve(m.data):w.reject(Object.assign(Error(m.message||'sidecar error'),{code:m.code||'SIDECAR_ERROR'}));}
    else onEvent(m);}});
  child.stderr.setEncoding('utf8');
  child.stderr.on('data',d=>{for(const l of String(d).split('\n'))if(l.trim())onLog(redact(l).slice(0,500));});
  const send=m=>{if(exited)throw Object.assign(Error('compute sidecar is not running'),{code:'SIDECAR_EXIT'});child.stdin.write(JSON.stringify(m)+'\n');};
  return {
    pid:child.pid,send,
    call(cmd,args={}){const id='c'+(++seq);const p=new Promise((resolve,reject)=>waiters.set(id,{resolve,reject}));send({cmd,id,...args});return {id,promise:p};},
    get running(){return !exited;},exit:exitP,
    async stop(graceMs=10000){
      if(exited)return exited;
      try{send({cmd:'shutdown'});}catch{}
      const t=setTimeout(()=>killTree(child),graceMs);const r=await exitP;clearTimeout(t);return r;
    },
    kill(){killTree(child);}
  };
}
export function killTree(child){
  if(!child.pid)return;
  if(process.platform==='win32'){try{spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}).on('error',()=>{});}catch{}}
  else try{child.kill('SIGKILL');}catch{}
}
export const redact=s=>String(s).replace(/(bearer\s+)[\w.-]+/ig,'$1[redacted]').replace(/\b(sk|hf|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{8,}/g,'[redacted]')
  .replace(/[A-Za-z]:\\Users\\[^\\\s]+/g,'%USERPROFILE%').replace(/\/(Users|home)\/[^/\s]+/g,'~');
