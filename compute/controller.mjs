// Compute Controller (spec §4, §8): the single owner of local Compute state on this computer — consent,
// policy, identity, runtime/model setup, coordinator link, the worker agent and (optionally) the local
// coordinator of the Training Lab. Every UI control maps to exactly one method here. The controller never
// enables itself: participation starts only after explicit, versioned consent for a specific project.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createGovernor} from './governor/governor.mjs';
import {DEFAULT_POLICY,nominalMonthlyHours} from './governor/policy.mjs';
import {startNvidia,startWindowsGameSensor,memorySample} from './governor/sensors.mjs';
import {createWorker} from './worker/worker.mjs';
import {startSidecar as rawSidecar} from './worker/sidecar.mjs';
import {loadIdentity,createIdentity,fileSecretBox} from './worker/identity.mjs';
import {pairWithCoordinator} from './worker/pair.mjs';
import {createCoordinatorService,lanAddresses,DEFAULT_PORT} from './coordinator/service.mjs';
import {getProfile,listProfiles,testMode} from './protocol/schema.mjs';
import {fail,ComputeError} from './protocol/errors.mjs';
import {PINNED} from './registry.mjs';
import {importLegacy} from './legacy.mjs';
import {verifyReport} from './report.mjs';
export const CONSENT_REVISION='kc2-consent-2026-11-1';
export const VERSION='0.2.0';
const PROD_PROFILE='ministral3b-ffa-r8-v1';
const DEFAULT_STATE={schema:1,participation:false,consents:[],policy:{...DEFAULT_POLICY},manual_pause:false,profile_id:PROD_PROFILE,
  runtime:null,model:null,preflight:null,link:null,lab:{bind_ip:null,port:DEFAULT_PORT,was_running:false}};
const isPrivate=h=>/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.)/.test(h)||h==='localhost';
// One GPU job at a time on this computer (worker training, preflight, evaluation, tokenization).
function createLock(){let tail=Promise.resolve();return ()=>{let release;const p=new Promise(r=>{release=r;});const ready=tail.then(()=>release);tail=tail.then(()=>p);return ready;};}
export function createController({dir,secretBox=fileSecretBox,startSidecar=rawSidecar,now=Date.now,log=()=>{},platform=process.platform,sensorsEnabled=true}){
  fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'state.json');
  let st=structuredClone(DEFAULT_STATE);
  try{st={...st,...JSON.parse(fs.readFileSync(file,'utf8'))};}catch{}
  const save=()=>{const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(st,null,1),{mode:0o600});fs.renameSync(tmp,file);};
  const events=[];let seq=0;const listeners=new Set();
  function ev(severity,code,details={}){const e={seq:++seq,ts:now(),severity,code,details};events.push(e);if(events.length>500)events.shift();for(const l of listeners)try{l(e);}catch{}log(`[${severity}] ${code} ${JSON.stringify(details).slice(0,200)}`);return e;}
  const gov=createGovernor({stateDir:path.join(dir,'governor'),now,policy:st.policy});
  gov.restorePolicy(st.policy);gov.setManualPause(st.manual_pause);
  const lock=createLock();
  // Sidecar wrapper: waits for the GPU lock before the first command; releases on stop/exit.
  function lockedSidecar(opts){
    const inner=startSidecar(opts);let releaseP=null,released=false;
    const release=()=>{if(released)return;released=true;releaseP?.then(r=>r());};
    inner.exit?.then(release);
    return {...inner,
      call(cmd,args){releaseP??=lock();const p=releaseP.then(()=>inner.call(cmd,args).promise);return {promise:p};},
      async stop(ms){try{return await inner.stop(ms);}finally{release();}},
      kill(){inner.kill();release();},send:m=>inner.send(m),get running(){return inner.running;}};
  }
  let identity=null,worker=null,workerState=null,stopping=false,service=null,lastError=null;
  let stopSensors=[];
  const profile=()=>getProfile(st.profile_id);
  // ---------- sensors ----------
  function sensorsOn(){
    if(stopSensors.length||!sensorsEnabled)return;
    stopSensors.push(startNvidia(s=>gov.setSensors({gpu:s})));
    stopSensors.push(startWindowsGameSensor(s=>gov.setSensors(s)));
    const t=setInterval(()=>gov.setSensors(memorySample()),5000);t.unref?.();gov.setSensors(memorySample());
    stopSensors.push(()=>clearInterval(t));
  }
  function sensorsOff(){for(const f of stopSensors)try{f();}catch{}stopSensors=[];}
  // ---------- consent ----------
  const consentFor=link=>link&&st.consents.find(c=>c.project_id===link.project_id&&c.endpoint===link.endpoint&&c.fingerprint===link.fingerprint&&!c.revoked_at&&c.text_revision===CONSENT_REVISION);
  function consentText(){
    const l=st.link;
    return {text_revision:CONSENT_REVISION,project_id:l?.project_id||null,endpoint:l?.endpoint||null,fingerprint:l?.fingerprint||null,
      remote:l?!isPrivate(new URL(l.endpoint).hostname):false,
      facts:{downloads:'Kvalah does not download model weights by itself: you choose a local model folder. Task rows and adapter checkpoints come from the coordinator.',
        uploads:'Only LoRA B-matrix updates (about 4 MB per task), task metrics and device capabilities are sent. No files, chats, prompts or code from this computer.',
        resources:'GPU/CPU time within your limits, about 3 GB of GPU memory while training, disk cache within the limit.',
        control:'Pause and Stop work at any time; closing Kvalah stops Compute. A coordinator cannot change your limits or enable Compute.'}};
  }
  function acceptConsent({text_revision,project_id,allow_remote}){
    const l=st.link;if(!l)fail('SETUP_REQUIRED','connect to a coordinator first');
    if(text_revision!==CONSENT_REVISION)fail('CONFLICT','consent text changed; read it again');
    if(project_id!==l.project_id)fail('CONFLICT','project changed; read the consent again');
    const remote=!isPrivate(new URL(l.endpoint).hostname);
    if(remote&&allow_remote!==true)fail('CONSENT_REQUIRED','this coordinator is outside your local network: confirm it explicitly');
    st.consents.push({project_id:l.project_id,endpoint:l.endpoint,fingerprint:l.fingerprint,text_revision,accepted_at:now(),scopes:{remote_coordinator:remote}});
    st.participation=true;save();ev('info','consent.accepted',{project_id:l.project_id,text_revision});
    return reconcile();
  }
  function revokeConsent(){
    for(const c of st.consents)if(!c.revoked_at)c.revoked_at=now();
    st.participation=false;save();ev('warn','consent.revoked',{});return reconcile();
  }
  // ---------- derived state machine ----------
  function setup(){
    const missing=[];
    if(!st.link)missing.push('link');else if(st.link.device_state==='revoked')missing.push('revoked');
    if(!st.runtime?.probe?.backend_ok)missing.push('runtime');
    if(!st.model?.files_digest)missing.push('model');
    else if(!st.model.architecture_ok)missing.push('model_architecture');
    if(!st.preflight?.ok||st.preflight.files_digest!==st.model?.files_digest)missing.push('preflight');
    return missing;
  }
  function derived(){
    if(stopping)return {state:'STOPPING',reason:'safe_boundary'};
    if(!st.participation)return {state:'DISABLED',reason:null};
    if(!st.link)return {state:'SETUP_REQUIRED',reason:'link'};
    if(!consentFor(st.link))return {state:'CONSENT_PENDING',reason:null};
    const m=setup();if(m.length)return {state:'SETUP_REQUIRED',reason:m[0],missing:m};
    if(!worker)return {state:lastError?'ERROR_RECOVERABLE':'READY',reason:lastError?.code||null};
    return {state:workerState?.state||'CONNECTING',reason:workerState?.reason||null};
  }
  async function getIdentity(){identity??=await loadIdentity(path.join(dir,'identity'),secretBox);return identity;}
  async function ensureIdentity(){identity=(await getIdentity())||await createIdentity(path.join(dir,'identity'),secretBox);return identity;}
  function capabilities(){
    const p=st.runtime?.probe||{};
    return {backend:st.runtime?.backend,device_name:p.gpu||(platform==='darwin'?'Apple '+(p.machine||''):p.machine||''),precision:p.precision||null,
      memory_total_bytes:p.memory_total_bytes??(platform==='darwin'?os.totalmem():null),memory_free_bytes:p.memory_free_bytes??null,unified_memory:platform==='darwin',
      preflight_ok:!!st.preflight?.ok,variants:st.model?[{profile_id:st.profile_id,variant_id:st.model.variant_id,files_digest:st.model.files_digest}]:[],
      runtime_version:`kvalah-compute/${VERSION} python/${p.python||'?'} ${p.torch?'torch/'+p.torch:''}${p.mlx?'mlx/'+p.mlx:''}`.trim()};
  }
  async function startWorker(){
    if(worker)return;
    const id=await ensureIdentity();
    gov.setEnabled(true);sensorsOn();
    const extraEnv=testMode()?{KVALAH_COMPUTE_TEST:'1'}:{};
    worker=createWorker({stateDir:path.join(dir,'worker'),identity:id,link:st.link,governor:gov,
      runtime:{python:st.runtime.python,backend:st.runtime.backend,model_dir:st.model.model_dir,profile_id:st.profile_id,variant_id:st.model.variant_id,extraEnv},
      capabilities,startSidecar:lockedSidecar,
      onState:s=>{workerState=s;const ds=worker?.state?.session?.state;if(ds&&st.link&&ds!==st.link.device_state){st.link={...st.link,device_state:ds};save();ev('info','link.state',{state:ds});}},
      onEvent:e=>{if(e.code==='sidecar.log')return;ev(/error|failed|rejected|lost/.test(e.code)?'warn':'info',e.code,e.details||{});
        if(e.code==='session.revoked'){st.link={...st.link,device_state:'revoked'};save();}}});
    ev('info','worker.started',{endpoint:st.link.endpoint});
    worker.start().catch(e=>{lastError={code:e.code||'ERROR',message:e.message};ev('error','worker.crashed',lastError);}).finally(()=>{worker=null;workerState=null;});
  }
  async function stopWorker(){
    const w=worker;if(!w)return;
    stopping=true;ev('info','worker.stopping',{});
    try{await w.stop();}finally{stopping=false;worker=null;workerState=null;gov.save();ev('info','worker.stopped',{});}
  }
  // Brings the running worker in line with the desired state (idempotent).
  async function reconcile(){
    const want=st.participation&&st.link&&consentFor(st.link)&&setup().length===0;
    gov.setEnabled(!!want);
    if(want&&!worker){lastError=null;await startWorker();}
    if(!want&&worker)await stopWorker();
    if(!want&&!service?.info().running)sensorsOff();
    return snapshot();
  }
  // ---------- setup steps ----------
  async function setRuntime({python,backend}){
    if(typeof python!=='string'||!path.isAbsolute(python))fail('INVALID_SCHEMA','choose the Python executable of the compute runtime (absolute path)');
    if(!fs.existsSync(python))fail('NOT_FOUND','file not found: '+python);
    const allowed=testMode()?['cuda','mlx','torch-cpu-test','mock']:['cuda','mlx'];
    const b=backend||(platform==='darwin'?'mlx':'cuda');if(!allowed.includes(b))fail('INVALID_SCHEMA','backend must be '+allowed.join(' or '));
    if(worker)await stopWorker();
    const sc=startSidecar({python,threads:1,extraEnv:testMode()?{KVALAH_COMPUTE_TEST:'1'}:{}});
    let probe;try{probe=await sc.call('probe',{backend:b}).promise;}catch(e){probe={backend_ok:false,backend_error:{code:e.code||'SIDECAR_ERROR',message:e.message}};}finally{await sc.stop(5000).catch(()=>sc.kill());}
    st.runtime={python,backend:b,probe,checked_at:now()};st.preflight=null;save();
    ev(probe.backend_ok?'info':'warn','runtime.checked',{backend:b,ok:!!probe.backend_ok,error:probe.backend_error?.message});
    return reconcile();
  }
  function archCheck(a){
    const p=profile(),q=p.targets.q_proj,v=p.targets.v_proj;
    if(p.test_only)return {ok:a.num_hidden_layers===p.layers&&a.hidden_size===q[0],expected:{layers:p.layers,hidden:q[0]}};
    const ok=a.model_type==='ministral3'&&a.num_hidden_layers===p.layers&&a.hidden_size===q[0]&&a.num_attention_heads*a.head_dim===q[1]&&a.num_key_value_heads*a.head_dim===v[1];
    return {ok,expected:{model_type:'ministral3',layers:p.layers,hidden:q[0],q_out:q[1],v_out:v[1]}};
  }
  async function setModel({model_dir,variant_id}){
    if(!st.runtime?.python)fail('RUNTIME_REQUIRED','check the compute runtime first');
    if(typeof model_dir!=='string'||!path.isAbsolute(model_dir)||!fs.existsSync(path.join(model_dir,'config.json')))fail('NOT_FOUND','choose a model folder that contains config.json');
    const p=profile();const vid=variant_id||(st.runtime.backend==='mlx'?'mlx-4bit':st.runtime.backend==='cuda'?'cuda-nf4':Object.keys(p.variants)[0]);
    if(!p.variants[vid])fail('INVALID_SCHEMA','unknown model variant '+vid);
    if(worker)await stopWorker();
    ev('info','model.verifying',{model_dir:path.basename(model_dir)});
    const sc=lockedSidecar({python:st.runtime.python,threads:1,extraEnv:testMode()?{KVALAH_COMPUTE_TEST:'1'}:{}});
    let v;try{v=await sc.call('verify_model',{model_dir}).promise;}finally{await sc.stop(5000).catch(()=>sc.kill());}
    const arch=archCheck(v.architecture);
    st.model={model_dir,variant_id:vid,file_list:v.files,files_digest:v.files_digest,total_bytes:v.total_bytes,files:v.files.length,architecture:v.architecture,architecture_ok:arch.ok,expected:arch.expected,
      quantization:v.quantization?{bits:v.quantization.bits??null,quant_method:v.quantization.quant_method??null}:null,pinned:PINNED[st.profile_id]?.[vid]||null,provenance:'unverified',verified_at:now()};
    st.preflight=null;save();
    ev(arch.ok?'info':'error','model.verified',{files_digest:v.files_digest.slice(0,16),architecture_ok:arch.ok});
    return reconcile();
  }
  async function checkProvenance(){
    if(!st.model?.file_list)fail('MODEL_REQUIRED','verify the model folder first');
    const pin=PINNED[st.profile_id]?.[st.model.variant_id];if(!pin)fail('NOT_FOUND','no pinned revision for this variant');
    const {verifyAgainstHub}=await import('./registry.mjs');
    const r=await verifyAgainstHub({repo:pin.source_repo,revision:pin.source_revision,files:st.model.file_list,modelDir:st.model.model_dir});
    st.model.provenance=r.verified&&st.model.variant_id!=='mlx-4bit'?'verified':'unverified';st.model.provenance_check={verified:r.verified,repo:r.repo,revision:r.revision,mismatches:r.results.filter(x=>x.status!=='match').slice(0,20),at:now()};
    save();
    ev(r.verified?'info':'warn','model.provenance',{verified:r.verified});return snapshot();
  }
  async function runPreflight(){
    if(!st.model?.files_digest||!st.model.architecture_ok)fail('MODEL_REQUIRED','verify a compatible model first');
    if(worker)await stopWorker();
    const p=profile(),d=gov.decide({phase:'preflight'});
    if(!gov.manualPause&&d.reason!=='disabled'&&!d.run)fail('PAUSED','the resource policy does not allow work now: '+d.reason);
    ev('info','preflight.started',{});
    const sc=lockedSidecar({python:st.runtime.python,threads:Math.max(1,gov.cpuThreads(os.availableParallelism?.()||2)),extraEnv:testMode()?{KVALAH_COMPUTE_TEST:'1'}:{},
      onEvent:e=>{if(e.type==='permit_request')sc.send({cmd:'permit',id:e.id});}});
    let r;
    try{r=await sc.call('preflight',{model_dir:st.model.model_dir,backend:st.runtime.backend,vocab_hint:st.model.architecture?.vocab_size,task:{layers:p.layers,targets:p.targets,rank:p.rank,alpha:p.alpha,max_length:256}}).promise;}
    catch(e){st.preflight={ok:false,error:{code:e.code,message:e.message},files_digest:st.model.files_digest,at:now()};save();ev('error','preflight.failed',st.preflight.error);return reconcile();}
    finally{await sc.stop(10000).catch(()=>sc.kill());}
    st.preflight={...r,files_digest:st.model.files_digest,at:now()};save();ev(r.ok?'info':'error','preflight.done',{ok:r.ok,step_s:r.step_s,model_load_s:r.model_load_s});
    return reconcile();
  }
  async function pair({pairing,alias}){
    if(worker)await stopWorker();
    const id=await ensureIdentity();
    const link=await pairWithCoordinator({pairing,identity:id,alias:String(alias||os.hostname()).slice(0,40),capabilities:capabilities(),runtime_version:VERSION});
    st.link=link;save();ev('info','link.paired',{endpoint:link.endpoint,project_id:link.project_id,state:link.device_state});
    return reconcile();
  }
  async function refreshLink(){
    if(!st.link)return snapshot();
    const {createClient}=await import('./worker/client.mjs');
    const c=createClient({endpoint:st.link.endpoint,fingerprint:st.link.fingerprint,identity:await getIdentity()});
    try{await c.syncTime();const s=await c.post('/v2/devices/session',{});st.link={...st.link,device_state:s.state};save();}
    catch(e){if(e.code==='REVOKED'){st.link={...st.link,device_state:'revoked'};save();}else throw e;}
    return reconcile();
  }
  async function forgetLink(){if(worker)await stopWorker();st.link=null;st.participation=false;save();ev('info','link.forgotten',{});return reconcile();}
  async function setParticipation(on){
    if(on){
      if(!st.link)fail('SETUP_REQUIRED','connect to a coordinator first (Devices)');
      if(!consentFor(st.link))fail('CONSENT_REQUIRED','read and accept the consent for this project first');
      st.participation=true;
    }else st.participation=false;
    save();ev('info',on?'participation.on':'participation.off',{});return reconcile();
  }
  function setPause(v){st.manual_pause=!!v;gov.setManualPause(!!v);save();ev('info',v?'participation.paused':'participation.resumed',{});return snapshot();}
  function setPolicy(policy,revision){const p=gov.setPolicy(policy,revision);st.policy=p;save();ev('info','policy.changed',{revision:p.revision});return snapshot();}
  // ---------- Training Lab (local coordinator) ----------
  function svc(){
    service??=createCoordinatorService({dir:path.join(dir,'coordinator'),startSidecar:lockedSidecar,log:m=>log('[coordinator] '+m),
      evaluator:()=>st.runtime?.probe?.backend_ok&&st.model?.architecture_ok?{python:st.runtime.python,backend:st.runtime.backend,model_dir:st.model.model_dir,variant_id:st.model.variant_id,extraEnv:testMode()?{KVALAH_COMPUTE_TEST:'1'}:{}}:null,
      canRunHeavy:()=>gov.manualPause?{run:false,reason:'manual_pause'}:gov.brokerBusy.length?{run:false,reason:'local_ai'}:{run:true}});
    return service;
  }
  const hasLab=()=>!!service||fs.existsSync(path.join(dir,'coordinator','db','coordinator.sqlite'));
  async function labStart({bind_ip,port}){
    const r=await svc().start({bindIp:bind_ip,port:Number(port)||DEFAULT_PORT});st.lab={bind_ip,port:r.port,was_running:true};save();sensorsOn();ev('info','lab.started',{endpoint:r.endpoint});return snapshot();
  }
  async function labStop(){if(service){await service.stop();}st.lab={...st.lab,was_running:false};save();ev('info','lab.stopped',{});return snapshot();}
  // This computer joins its own coordinator as a worker (local admin approves it directly; audited).
  async function labJoinSelf({alias}){
    const s=svc();if(!s.info().running)fail('UNAVAILABLE','start the coordinator first');
    const p=s.createPairing({aliasHint:alias});
    await pair({pairing:p.pairing,alias:alias||os.hostname()});
    s.coord.approveDevice(identity.device_id);
    s.coord.db.prepare('insert into audit_log(ts,actor,action,details) values(?,?,?,?)').run(now(),'local-admin','device.self_join',JSON.stringify({id:identity.device_id}));
    st.link={...st.link,device_state:'active'};save();return reconcile();
  }
  function labView(){
    if(!hasLab())return null;
    const s=svc(),c=s.coord;
    return {info:s.info(),devices:c.listDevices(),experiments:c.listExperiments().slice(0,20),datasets:c.listDatasets(),variants:c.variants().map(v=>({profile_id:v.profile_id,variant_id:v.variant_id,files_digest:v.files_digest,provenance:v.provenance,pinned:v.manifest?.pinned||null})),
      self_device:identity?.device_id||null};
  }
  async function labAction(action,b={}){
    const s=svc(),c=s.coord;
    switch(action){
      case 'pairing':return s.createPairing({aliasHint:b.alias});
      case 'approve':return c.approveDevice(String(b.id));
      case 'revoke':return c.revokeDevice(String(b.id),'admin');
      case 'drain':return c.drainDevice(String(b.id),b.on!==false);
      case 'rename':return c.renameDevice(String(b.id),b.alias);
      case 'register-model':{
        if(!st.model?.files_digest)fail('MODEL_REQUIRED','verify the local model folder first (Models & data)');
        return s.registerModel({profile_id:st.profile_id,variant_id:b.variant_id||st.model.variant_id,model:{files_digest:b.variant_id&&b.variant_id!==st.model.variant_id?null:st.model.files_digest,architecture:st.model.architecture,total_bytes:st.model.total_bytes,quantization:st.model.quantization},provenance_check:st.model.provenance_check});
      }
      case 'import-dataset':return s.importDataset({file:b.file,fixture:b.fixture===true,dataset_id:b.dataset_id,revision:b.revision||'1',profile_id:st.profile_id,max_length:Number(b.max_length)||256,source:b.source,provenance:b.provenance});
      case 'dry-run':return c.dryRun({...b.config,profile_id:st.profile_id});
      case 'create':return c.createExperiment({...b.config,profile_id:st.profile_id});
      case 'experiment/start':return c.startExperiment(String(b.id));
      case 'experiment/pause':return c.pauseExperiment(String(b.id));
      case 'experiment/resume':return c.resumeExperiment(String(b.id));
      case 'experiment/cancel':return c.cancelExperiment(String(b.id));
      case 'experiment/finish':return c.finishAfterRound(String(b.id));
      case 'experiment/status':return {status:c.status(String(b.id)),rounds:c.rounds(String(b.id))};
      case 'events':return c.events(Number(b.after)||0,200);
      case 'report':{
        if(!b.dir||!path.isAbsolute(b.dir)||!fs.statSync(b.dir).isDirectory())fail('INVALID_SCHEMA','choose an existing folder for the report');
        const e=c.status(String(b.experiment_id));
        return s.exportReport({experiment_id:e.id,out:path.join(b.dir,`kvalah-compute-report-${e.run_id}.zip`),include_weights:b.include_weights===true,include_aliases:b.include_aliases===true,app_version:VERSION});
      }
      case 'export-peft':{
        if(!b.dir||!path.isAbsolute(b.dir)||!fs.statSync(b.dir).isDirectory())fail('INVALID_SCHEMA','choose an existing folder for the adapter');
        if(!st.runtime?.python)fail('RUNTIME_REQUIRED','the PEFT export runs in the compute runtime (configure it first)');
        const e=c.status(String(b.experiment_id)),ck=c.latestCheckpoint(e.id);if(!ck||ck.round_idx===0)fail('NOT_FOUND','no committed round to export');
        const tmp=fs.mkdtempSync(path.join(dir,'export-'));
        try{
          fs.writeFileSync(path.join(tmp,'adapter.safetensors'),c.checkpoint(ck.hash));
          const out=path.join(b.dir,`kvalah-peft-${e.run_id}-r${ck.round_idx}`);
          const sc=startSidecar({python:st.runtime.python,threads:1,extraEnv:testMode()?{KVALAH_COMPUTE_TEST:'1'}:{}});
          try{
            const v=c.variants().find(x=>x.profile_id===e.config.profile_id)||{};
            return await sc.call('export_peft',{adapter_path:path.join(tmp,'adapter.safetensors'),out_dir:out,profile:getProfile(e.config.profile_id),
              meta:{checkpoint_sha256:ck.hash,experiment_id:e.id,round:ck.round_idx,schema_hash:e.config.schema_hash||null,source_revision:v.manifest?.pinned?.source_revision||null}}).promise;
          }finally{await sc.stop(5000).catch(()=>sc.kill());}
        }finally{fs.rmSync(tmp,{recursive:true,force:true});}
      }
      default:fail('NOT_FOUND','unknown lab action');
    }
  }
  function legacyImport({file}){
    if(!file||!path.isAbsolute(file))fail('INVALID_SCHEMA','choose experiment-v01.zip');
    const r=importLegacy(file);fs.mkdirSync(path.join(dir,'legacy'),{recursive:true});fs.writeFileSync(path.join(dir,'legacy','v01-import.json'),JSON.stringify(r,null,1));
    ev(r.verified_all?'info':'warn','legacy.imported',{verified:r.verified_all});return r;
  }
  const legacyView=()=>{try{return JSON.parse(fs.readFileSync(path.join(dir,'legacy','v01-import.json'),'utf8'));}catch{return null;}};
  // ---------- snapshot for the UI ----------
  function snapshot(){
    const d=derived(),w=worker?.state;
    const decision=gov.decide();
    return {version:VERSION,test_mode:testMode(),platform,state:d.state,reason:d.reason,missing:d.missing||setup(),participation:st.participation,manual_pause:st.manual_pause,
      consent:{required:!!st.link&&!consentFor(st.link),current:consentFor(st.link)||null,text:consentText(),history:st.consents.slice(-10)},
      policy:gov.policy,nominal_monthly_hours:nominalMonthlyHours(gov.policy),budget:gov.budget(),month:gov.month(),measured:gov.measured(),
      governor:{decision,broker:gov.brokerBusy,sensors:redactSensors(gov.sensors)},
      profile:{id:st.profile_id,available:listProfiles().map(p=>p.id),variants:Object.keys(profile().variants)},runtime:st.runtime,model:st.model?(({file_list,...m})=>m)(st.model):null,preflight:st.preflight,
      link:st.link,identity:identity?{device_id:identity.device_id,key_fingerprint:identity.key_fingerprint,secret_store:identity.secret_store}:null,
      worker:w?{state:w.state,reason:w.reason,task:w.task,metrics:w.metrics,last_accepted:w.last_accepted,outbox:w.outbox,session:w.session}:null,
      last_error:lastError,lab:labView(),lab_addresses:lanAddresses(),legacy:legacyView(),events:events.slice(-80)};
  }
  const redactSensors=s=>({on_battery:s.on_battery??null,idle_s:s.idle_s??null,thermal_state:s.thermal_state??null,game:s.game??null,fullscreen:s.fullscreen??null,
    gpu:s.gpu?{name:s.gpu.name,utilization_pct:s.gpu.utilization_pct,memory_used_bytes:s.gpu.memory_used_bytes,memory_total_bytes:s.gpu.memory_total_bytes,temperature_c:s.gpu.temperature_c,power_w:s.gpu.power_w}:null,
    ram_free_bytes:s.ram_free_bytes??null,ram_total_bytes:s.ram_total_bytes??null,at:s.at??null});
  async function boot(){
    await getIdentity().catch(e=>ev('error','identity.unreadable',{message:e.message}));
    if(st.lab?.was_running&&st.lab.bind_ip)await labStart({bind_ip:st.lab.bind_ip,port:st.lab.port}).catch(e=>ev('warn','lab.autostart_failed',{message:e.message}));
    // Participation never auto-starts across app restarts without the consent record; with it, it resumes.
    await reconcile().catch(e=>{lastError={code:e.code,message:e.message};});
    return snapshot();
  }
  async function shutdown(){await stopWorker().catch(()=>{});if(service)await service.close().catch(()=>{});sensorsOff();gov.save();}
  // ---------- request router (used by host IPC and tests) ----------
  async function handle(method,route,b={}){
    const r=route.replace(/^\/+/,'');
    if(method==='GET'&&r==='state')return snapshot();
    if(method==='GET'&&r==='events')return events.filter(e=>e.seq>(Number(b.after)||0));
    if(method!=='POST')fail('NOT_FOUND','not found');
    switch(r){
      case 'consent/accept':return acceptConsent(b);
      case 'consent/revoke':return revokeConsent();
      case 'participation':return setParticipation(b.enabled===true);
      case 'pause':return setPause(true);
      case 'resume':return setPause(false);
      case 'policy':return setPolicy(b.policy,b.revision);
      case 'runtime':return setRuntime(b);
      case 'model':return setModel(b);
      case 'model/provenance':return checkProvenance();
      case 'preflight':return runPreflight();
      case 'link/pair':return pair(b);
      case 'link/refresh':return refreshLink();
      case 'link/forget':return forgetLink();
      case 'profile':{if(worker)await stopWorker();getProfile(b.profile_id);st.profile_id=b.profile_id;st.model=null;st.preflight=null;save();return reconcile();}
      case 'lab/start':return labStart(b);
      case 'lab/stop':return labStop();
      case 'lab/join-self':return labJoinSelf(b);
      case 'legacy/import':return legacyImport(b);
      case 'verify-report':return verifyReport(String(b.file||''));
      default:
        if(r.startsWith('lab/'))return labAction(r.slice(4),b);
        fail('NOT_FOUND','not found');
    }
  }
  return {handle,boot,shutdown,snapshot,governor:gov,setSensors:s=>gov.setSensors(s),setBroker:(id,busy)=>gov.setBroker(id,busy),onEvent:f=>{listeners.add(f);return ()=>listeners.delete(f);},
    get worker(){return worker;},get service(){return service;},reconcile};
}
export {ComputeError};
