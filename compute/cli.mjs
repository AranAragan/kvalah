#!/usr/bin/env node
// Kvalah Compute v0.2 command line (headless lab / worker / diagnostics). Uses the same Controller as the
// desktop app, so every command runs the real coordinator, worker, governor and sidecar. Run with Node 24+
// (or the Kvalah executable with ELECTRON_RUN_AS_NODE=1). Nothing here enables Compute in the desktop app.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createController} from './controller.mjs';
const HELP=`kvalah-compute <command> [options]

  doctor        --python P [--backend cuda|mlx] [--model-dir D --variant V] [--preflight]
  coordinator   --bind IP [--port 8765] --python P --model-dir D [--variant V] [--pairings N]
                Starts a Training Lab coordinator in the foreground and prints N one-time pairing strings.
  run           --bind IP --python P --model-dir D --config exp.json [--dataset file.jsonl|--fixture]
                [--join-self] [--expect-devices N] [--report-dir DIR] [--weights]
                Coordinator + dataset + experiment; waits until COMPLETED/BLOCKED and exports the report.
  worker        --pairing STR --python P --model-dir D [--variant V] [--alias NAME] --i-consent
                [--gpu 10] [--cpu 10] [--hours 4] [--no-idle] [--no-ac] [--no-games]
  export        --experiment ID --out DIR [--weights] [--peft]
  verify-report --file report.zip
  legacy-import --file experiment-v01.zip
  status

  Common: --dir DIR (state directory, default ~/.kvalah-compute-cli), --json`;
const argv=process.argv.slice(2),cmd=argv[0];
const opt=(k,d)=>{const i=argv.indexOf('--'+k);return i>0&&i+1<argv.length&&!argv[i+1].startsWith('--')?argv[i+1]:d;};
const flag=k=>argv.includes('--'+k);
if(!cmd||flag('help')||cmd==='help'){console.log(HELP);process.exit(0);}
const dir=path.resolve(opt('dir',path.join(os.homedir(),'.kvalah-compute-cli')));
fs.mkdirSync(dir,{recursive:true});
const ctl=createController({dir,secretBox:{available:false},log:m=>{if(flag('verbose'))console.error(m);}});
const out=v=>console.log(flag('json')?JSON.stringify(v,null,1):typeof v==='string'?v:JSON.stringify(v,null,1));
const h=(r,b={},m='POST')=>ctl.handle(m,r,b);
const need=k=>{const v=opt(k);if(!v){console.error('missing --'+k+'\n\n'+HELP);process.exit(2);}return v;};
const abs=p=>path.resolve(p);
let stopping=false;
async function stop(code=0){if(stopping)return;stopping=true;await ctl.shutdown().catch(()=>{});process.exit(code);}
for(const s of ['SIGINT','SIGTERM'])process.on(s,()=>{console.error('\nstopping at a safe boundary…');stop(0);});
ctl.onEvent(e=>{if(!flag('json')&&e.code!=='sidecar.log')console.error(new Date(e.ts).toISOString().slice(11,19),e.severity.padEnd(5),e.code,JSON.stringify(e.details||{}).slice(0,200));});
async function setup({preflight=true}={}){
  if(opt('profile'))await h('profile',{profile_id:opt('profile')});
  const s=await h('runtime',{python:abs(need('python')),backend:opt('backend')});
  if(!s.runtime.probe.backend_ok)throw Object.assign(Error('runtime not usable: '+(s.runtime.probe.backend_error?.message||'?')),{code:'RUNTIME'});
  if(opt('model-dir')){const m=await h('model',{model_dir:abs(opt('model-dir')),variant_id:opt('variant')});if(!m.model.architecture_ok)throw Error('model folder does not match the profile');}
  if(preflight&&opt('model-dir')){const p=await h('preflight');if(!p.preflight?.ok)throw Error('preflight failed: '+(p.preflight?.error?.message||'?'));}
  return h('state',{},'GET');
}
async function policyFromFlags(){
  const s=await h('state',{},'GET'),p={...s.policy};
  if(opt('gpu'))p.gpu_target_pct=Number(opt('gpu'));if(opt('cpu'))p.cpu_target_pct=Number(opt('cpu'));if(opt('hours'))p.daily_hours=Number(opt('hours'));
  if(flag('no-idle'))p.only_idle=false;if(flag('no-ac'))p.only_ac=false;if(flag('no-games'))p.pause_on_games=false;if(flag('full'))p.profile='full';
  return h('policy',{policy:p,revision:s.policy.revision});
}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
try{
  await ctl.boot();
  switch(cmd){
    case 'doctor':{
      if(flag('preflight'))await policyFromFlags();
      const s=await setup({preflight:flag('preflight')});
      out({runtime:s.runtime.probe,model:s.model&&{files_digest:s.model.files_digest,architecture_ok:s.model.architecture_ok,pinned:s.model.pinned,provenance:s.model.provenance},preflight:s.preflight,sensors:s.governor.sensors,decision:s.governor.decision});
      break;
    }
    case 'coordinator':case 'run':{
      await setup({preflight:false});
      await policyFromFlags();
      let s=await h('lab/start',{bind_ip:need('bind'),port:Number(opt('port',8765))});
      out({endpoint:s.lab.info.endpoint,fingerprint:s.lab.info.fingerprint,project_id:s.lab.info.project_id});
      await h('lab/register-model',{});
      for(let i=0;i<Number(opt('pairings',cmd==='run'?opt('expect-devices',0):1));i++){const p=await h('lab/pairing',{});console.log('PAIRING '+p.pairing);}
      if(cmd==='coordinator'){
        // Foreground: auto-print new pending devices; approve them with --approve-all (explicit), else print ids.
        const seen=new Set();
        for(;;){await wait(3000);s=await h('state',{},'GET');
          for(const d of s.lab.devices)if(d.state==='pending'&&!seen.has(d.id)){seen.add(d.id);
            if(flag('approve-all')){await h('lab/approve',{id:d.id});console.log('approved',d.id,d.alias);}else console.log('pending device',d.id,d.alias,d.key_fingerprint,'(re-run with --approve-all or approve in the app)');}}
      }
      const cfg=JSON.parse(fs.readFileSync(need('config'),'utf8'));
      if(flag('join-self')){await h('lab/join-self',{alias:opt('alias',os.hostname())});const st=await h('state',{},'GET');
        if(!flag('i-consent')){console.log(JSON.stringify(st.consent.text,null,1));throw Error('--join-self also runs a worker here: read the consent text above and add --i-consent');}
        await h('consent/accept',{text_revision:st.consent.text.text_revision,project_id:st.consent.text.project_id});
        if(opt('model-dir')){const p=await h('preflight',{max_length:cfg.max_length??256});if(!p.preflight?.ok)throw Error('preflight failed');}}
      const dataset=flag('fixture')||!opt('dataset')?{fixture:true}:{file:abs(opt('dataset')),dataset_id:opt('dataset-id'),revision:opt('dataset-rev','1')};
      const ds=await h('lab/import-dataset',{...dataset,max_length:cfg.max_length??256});
      cfg.dataset_id=ds.id;
      const plan=await h('lab/dry-run',{config:cfg});
      out({tasks:plan.tasks,rows_per_task:plan.rows_per_task,supervised_tokens:plan.supervised_tokens_total,config_hash:plan.config_hash,frozen_a_hash:plan.frozen_a_hash,research_pass_possible:plan.research_pass_possible});
      const want=Number(opt('expect-devices',cfg.quorum?.target||1));
      for(;;){s=await h('state',{},'GET');const act=s.lab.devices.filter(d=>d.state==='active');
        for(const d of s.lab.devices)if(d.state==='pending'&&flag('approve-all')){await h('lab/approve',{id:d.id});console.log('approved',d.id,d.alias);}
        if(act.length>=want)break;console.error(`waiting for devices: ${act.length}/${want} active`);await wait(5000);}
      const e=await h('lab/create',{config:cfg});await h('lab/experiment/start',{id:e.id});console.log('EXPERIMENT '+e.id);
      let st;
      for(;;){await wait(5000);st=await h('lab/experiment/status',{id:e.id});const r=st.status.round;
        console.error(`${st.status.state} committed ${st.status.committed_rounds}/${st.status.target_rounds}`+(r?` round ${r.idx}.${r.attempt} ${r.state} accepted ${r.accepted}/${r.target}`:''));
        if(['COMPLETED','CANCELLED'].includes(st.status.state)||st.status.state==='BLOCKED')break;}
      // Final evaluation is asynchronous: give it time (it waits for the governor).
      for(let i=0;i<120&&st.status.state==='COMPLETED'&&st.status.eval?.rounds&&!st.status.eval.rounds[st.status.target_rounds];i++){await wait(5000);st=await h('lab/experiment/status',{id:e.id});}
      out({state:st.status.state,eval:st.status.eval,rounds:st.rounds.map(r=>({idx:r.idx,attempt:r.attempt,state:r.state,checkpoint:r.checkpoint_hash,accepted:(r.accepted||[]).length,duration_ms:r.duration_ms,aggregation_ms:r.aggregation_ms}))});
      if(opt('report-dir')){const rep=await h('lab/report',{experiment_id:e.id,dir:abs(opt('report-dir')),include_weights:flag('weights')});out({report:rep});}
      break;
    }
    case 'worker':{
      await setup({preflight:false});
      const s0=await h('link/pair',{pairing:need('pairing'),alias:opt('alias',os.hostname())});
      out({endpoint:s0.link.endpoint,fingerprint:s0.link.fingerprint,project_id:s0.link.project_id,device_state:s0.link.device_state});
      const st=await h('state',{},'GET');
      if(!flag('i-consent')){console.log(JSON.stringify(st.consent.text,null,1));throw Error('read the consent text above and add --i-consent to participate');}
      await policyFromFlags();
      const p=await h('preflight');if(!p.preflight?.ok)throw Error('preflight failed: '+(p.preflight?.error?.message||'?'));
      await h('consent/accept',{text_revision:st.consent.text.text_revision,project_id:st.consent.text.project_id,allow_remote:flag('allow-remote')||undefined});
      let last='';
      for(;;){await wait(3000);
        let s=await h('state',{},'GET');
        if(s.link?.device_state==='pending'){await h('link/refresh').catch(()=>{});s=await h('state',{},'GET');}
        const line=`${s.state}${s.reason?' ('+s.reason+')':''}${s.worker?.task?` round ${s.worker.task.round} step ${s.worker.task.step}/${s.worker.task.steps}`:''} accepted ${s.worker?.metrics?.tasks_accepted??0}`;
        if(line!==last){console.log(new Date().toISOString().slice(11,19),line);last=line;}}
    }
    case 'export':{
      const ex=need('experiment'),o=abs(need('out'));fs.mkdirSync(o,{recursive:true});
      out(await h('lab/report',{experiment_id:ex,dir:o,include_weights:flag('weights')}));
      if(flag('peft')){if(opt('python'))await h('runtime',{python:abs(opt('python')),backend:opt('backend')});out(await h('lab/export-peft',{experiment_id:ex,dir:o}));}
      break;
    }
    case 'verify-report':{const r=await h('verify-report',{file:abs(need('file'))});out(r);await stop(r.ok?0:1);break;}
    case 'legacy-import':{const r=await h('legacy/import',{file:abs(need('file'))});out(r);await stop(r.verified_all?0:1);break;}
    case 'status':out(await h('state',{},'GET'));break;
    default:console.error('unknown command '+cmd+'\n\n'+HELP);await stop(2);
  }
  await stop(0);
}catch(e){console.error('error:',e.code?e.code+': ':'',e.message);await stop(1);}
