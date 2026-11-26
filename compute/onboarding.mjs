import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {ComputeError} from './protocol/errors.mjs';

const exec=promisify(execFile);
export const setupStages=['approval','runtime','model','integrity','preflight'];
export const participationProfiles=Object.freeze({
  gentle:{gpu_target_pct:10,cpu_target_pct:10,daily_hours:4},
  balanced:{gpu_target_pct:25,cpu_target_pct:25,daily_hours:4},
  productive:{gpu_target_pct:50,cpu_target_pct:50,daily_hours:4}
});

export function localCandidates({dir,platform,profile,runtime,model,fixture}){
  const home=path.join(os.homedir(),'kvalah-compute');
  const backend=profile.test_only&&fixture?.backend?fixture.backend:platform==='darwin'?'mlx':'cuda';
  const variant=Object.keys(profile.variants).find(id=>profile.variants[id].backend===backend);
  const python=folder=>path.join(folder,...(platform==='win32'?['Scripts','python.exe']:['bin','python']));
  const roots=[path.join(dir,'models'),path.join(home,'models')];
  const known=roots.flatMap(root=>fs.existsSync(root)?fs.readdirSync(root,{withFileTypes:true})
    .filter(x=>x.isDirectory()&&!x.name.endsWith('.partial')).map(x=>path.join(root,x.name)):[]);
  const runtimes=[runtime?.backend===backend?runtime.python:null,fixture?.python,
    python(path.join(dir,'runtimes',backend)),python(path.join(home,'.venv'))];
  const models=[model?.variant_id===variant?model.model_dir:null,fixture?.model_dir,...known];
  return {backend,variant,runtimes:[...new Set(runtimes.filter(p=>p&&fs.existsSync(p)))],
    models:[...new Set(models.filter(p=>p&&fs.existsSync(path.join(p,'config.json'))))]};
}

export async function describeHardware({platform,dir,candidates}){
  let gpu=null;
  if(platform==='darwin'&&process.arch==='arm64')gpu=os.cpus()[0]?.model||null;
  if(platform==='win32'||platform==='linux'){
    try{
      const {stdout}=await exec('nvidia-smi',['--query-gpu=name,driver_version,memory.total','--format=csv,noheader,nounits'],{timeout:2500,windowsHide:true,maxBuffer:8192});
      const [name,driver,memory]=stdout.split('\n')[0].split(',').map(x=>x.trim());
      if(name)gpu={name,driver,memory_bytes:Number.isFinite(Number(memory))?Number(memory)*2**20:null};
    }catch{}
  }
  const disk=fs.statfsSync(dir);
  return {platform,arch:process.arch,ram_bytes:os.totalmem(),disk_bytes:disk.bavail*disk.bsize,
    gpu:typeof gpu==='string'?{name:gpu}:gpu,existing_runtime:candidates.runtimes.length>0,existing_model:candidates.models.length>0};
}

export function createSetup({now,readLink,refreshLink,hasConsent,candidates,useRuntime,useModel,runPreflight,downloadModel,installRuntime,activate,onState}){
  let abort,job;
  let state={phase:null,status:'idle'};
  const set=(phase,status,extra={})=>{
    state={phase,status,at:now(),...extra};
    onState?.(state);
  };

  async function prepare(signal){
    const check=()=>{
      signal.throwIfAborted();
      if(!hasConsent())throw new ComputeError('CONSENT_REQUIRED','preparation consent is required');
      if(readLink()?.device_state==='revoked')throw new ComputeError('REVOKED','participation was revoked');
    };
    try{
      check();
      for(;;){
        set('approval','running');
        try{await refreshLink(signal);}
        catch(error){
          if(error.code!=='UNAVAILABLE')throw error;
          set('approval','waiting',{reason:error.code,retry_at:now()+5000});
          await delay(5000,undefined,{signal});
          continue;
        }
        check();
        if(readLink()?.device_state==='active')break;
        set('approval','waiting',{reason:'pending_approval',retry_at:now()+5000});
        await delay(5000,undefined,{signal});
      }
      const {backend,variant,runtimes,models}=candidates();
      if(!variant)throw new ComputeError('RUNTIME_REQUIRED','this platform has no compatible compute backend');
      set('runtime','running');
      let runtimeReady=false;
      for(const python of runtimes){
        check();
        if(await useRuntime({python,backend},signal)){runtimeReady=true;break;}
      }
      if(!runtimeReady&&installRuntime){
        const python=await installRuntime({backend,signal,progress:value=>set('runtime','running',value)});
        if(python){check();runtimeReady=await useRuntime({python,backend},signal);}
      }
      if(!runtimeReady)throw new ComputeError('RUNTIME_REQUIRED','no compatible local runtime was found');
      set('model','running');
      let modelReady=false;
      for(const model_dir of models){
        check();
        set('integrity','running');
        if(await useModel({model_dir,variant_id:variant},signal)){modelReady=true;break;}
      }
      if(!modelReady&&downloadModel){
        const model_dir=await downloadModel({variant,signal,progress:value=>set('model','running',value)});
        if(model_dir){check();set('integrity','running');modelReady=await useModel({model_dir,variant_id:variant},signal);}
      }
      if(!modelReady)throw new ComputeError('MODEL_REQUIRED','no compatible local model was found');
      for(;;){
        check();
        set('preflight','running');
        try{
          if(!await runPreflight(signal))throw new ComputeError('PREFLIGHT_FAILED','preflight did not pass');
          break;
        }catch(error){
          if(error.code!=='PAUSED'||!['user_active','game','low_memory','temperature','thermal_state','on_battery','local_ai','manual_pause','fullscreen','quiet_hours','sensor_unavailable_idle','sensor_unavailable_power','sensor_unavailable_memory'].includes(error.details?.reason))throw error;
          set('preflight','waiting',{reason:error.details.reason,retry_at:now()+5000});
          await delay(5000,undefined,{signal});
        }
      }
      check();
      await activate();
      set('preflight','ready');
    }catch(error){
      set(state.phase,signal.aborted?'cancelled':'blocked',{reason:signal.aborted?null:error.details?.reason||error.code||'SETUP_FAILED',error_code:error.code||'SETUP_FAILED'});
    }
  }
  return {
    get state(){return state;},
    start(){
      if(!job){
        abort=new AbortController();
        job=prepare(abort.signal).finally(()=>{job=null;});
      }
      return state;
    },
    async cancel(){if(job){abort.abort();await job;}}
  };
}
