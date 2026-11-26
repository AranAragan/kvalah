// Compute Controller (spec §4, §8): the single owner of local Compute state on this computer — consent,
// policy, identity, runtime/model setup, coordinator link, the worker agent and (optionally) the local
// coordinator of the Training Lab. Every UI control maps to exactly one method here. The controller never
// enables itself: participation starts only after explicit, versioned consent for a specific project.
import fs from 'node:fs';
import os from 'node:os';
import dgram from 'node:dgram';
import {isIPv4} from 'node:net';
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
import {createSetup,describeHardware,localCandidates,participationProfiles} from './onboarding.mjs';
import {createManagedRuntime,downloadAssets,modelAssets,runtimeAssets} from './setup-assets.mjs';
import {parsePairing} from './worker/client.mjs';
export const CONSENT_REVISION='kc2-consent-2026-11-1';
export const VERSION='0.2.0';
const PROD_PROFILE='ministral3b-ffa-r8-v1';
const DEFAULT_STATE={schema:1,participation:false,consents:[],policy:{...DEFAULT_POLICY},manual_pause:false,profile_id:PROD_PROFILE,
  runtime:null,model:null,preflight:null,link:null,lab:{bind_ip:null,port:DEFAULT_PORT,was_running:false}};
const isPrivate=h=>h==='localhost'||(isIPv4(h)&&/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.)/.test(h));
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
      call(cmd,args){
        releaseP??=lock();
        const p=releaseP.then(()=>{
          if(released)throw Object.assign(Error('sidecar operation cancelled while waiting for the resource lock'),{code:'STOPPED'});
          return inner.call(cmd,args).promise;
        });
        return {promise:p};
      },
      async stop(ms){try{return await inner.stop(ms);}finally{release();}},
      kill(){inner.kill();release();},send:m=>inner.send(m),get running(){return inner.running;}};
  }
  let identity=null,worker=null,workerState=null,stopping=false,service=null,lastError=null;
  let revision=0,downloadOffer=null;
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
  function acceptConsent({text_revision,project_id,allow_remote,prepare=false}){
    const l=st.link;if(!l)fail('SETUP_REQUIRED','connect to a coordinator first');
    if(text_revision!==CONSENT_REVISION)fail('CONFLICT','consent text changed; read it again');
    if(project_id!==l.project_id)fail('CONFLICT','project changed; read the consent again');
    const remote=!isPrivate(new URL(l.endpoint).hostname);
    if(remote&&allow_remote!==true)fail('CONSENT_REQUIRED','this coordinator is outside your local network: confirm it explicitly');
    if(prepare&&remote)fail('FORBIDDEN_SCOPE','automatic setup is available only on a local network');
    if(prepare){
      const previous=consentFor(l);
      if(previous)previous.revoked_at=now();
    }
    st.consents.push({project_id:l.project_id,endpoint:l.endpoint,fingerprint:l.fingerprint,text_revision,accepted_at:now(),
      scopes:{remote_coordinator:remote,automatic_setup:prepare===true},policy_at_acceptance:prepare?gov.policy:undefined});
    st.participation=!prepare;st.setup_requested=prepare===true;save();ev('info','consent.accepted',{project_id:l.project_id,text_revision});
    if(prepare){sensorsOn();preparation.start();}
    return reconcile();
  }
  async function revokeConsent(){
    for(const c of st.consents)if(!c.revoked_at)c.revoked_at=now();
    st.participation=false;st.setup_requested=false;save();await preparation.cancel();ev('warn','consent.revoked',{});return reconcile();
  }
  // ---------- derived state machine ----------
  function setup(){
    const missing=[];
    if(!st.link)missing.push('link');else if(st.link.device_state==='revoked')missing.push('revoked');
    if(!st.runtime?.probe?.backend_ok)missing.push('runtime');
    if(!st.model?.files_digest)missing.push('model');
    else if(!st.model.architecture_ok)missing.push('model_architecture');
    else if(profile().variants[st.model.variant_id]?.backend!==st.runtime?.backend)missing.push('model_variant');
    if(!st.preflight?.ok||st.preflight.files_digest!==st.model?.files_digest||st.preflight.backend!==st.runtime?.backend)missing.push('preflight');
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
      preflight_ok:!!st.preflight?.ok,preflight_max_length:st.preflight?.max_length,variants:st.model?[{profile_id:st.profile_id,variant_id:st.model.variant_id,files_digest:st.model.files_digest}]:[],
      runtime_version:`kvalah-compute/${VERSION} python/${p.python||'?'} ${p.torch?'torch/'+p.torch:''}${p.mlx?'mlx/'+p.mlx:''}`.trim()};
  }
  async function startWorker(){
    if(worker)return;
    const id=await ensureIdentity();
    gov.setEnabled(true);sensorsOn();
    const extraEnv=testMode()?{KVALAH_COMPUTE_TEST:'1'}:{};
    worker=createWorker({stateDir:path.join(dir,'worker'),identity:id,link:st.link,governor:gov,
      runtime:{python:st.runtime.python,backend:st.runtime.backend,model_dir:st.model.model_dir,files_digest:st.model.files_digest,profile_id:st.profile_id,variant_id:st.model.variant_id,extraEnv},
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
    const want=st.participation&&st.link&&consentFor(st.link)&&setup().length===0&&(!st.setup_requested||st.link.device_state==='active');
    gov.setEnabled(!!want);
    if(want&&!worker){lastError=null;await startWorker();}
    if(!want&&worker)await stopWorker();
    if(!want&&!st.setup_requested&&!service?.info().running)sensorsOff();
    return snapshot();
  }
  // ---------- setup steps ----------
  async function sidecarCall(sc,command,args,signal){
    const cancel=()=>sc.kill();
    try{
      signal?.throwIfAborted();
      signal?.addEventListener('abort',cancel,{once:true});
      return await sc.call(command,args).promise;
    }finally{signal?.removeEventListener('abort',cancel);}
  }
  async function setRuntime({python,backend},signal){
    if(typeof python!=='string'||!path.isAbsolute(python))fail('INVALID_SCHEMA','choose the Python executable of the compute runtime (absolute path)');
    if(!fs.existsSync(python))fail('NOT_FOUND','file not found: '+python);
    const allowed=testMode()?['cuda','mlx','torch-cpu-test','mock']:['cuda','mlx'];
    const b=backend||(platform==='darwin'?'mlx':'cuda');if(!allowed.includes(b))fail('INVALID_SCHEMA','backend must be '+allowed.join(' or '));
    if(worker)await stopWorker();
    const sc=startSidecar({python,threads:1,extraEnv:testMode()?{KVALAH_COMPUTE_TEST:'1'}:{}});
    let probe;try{probe=await sidecarCall(sc,'probe',{backend:b},signal);}catch(e){probe={backend_ok:false,backend_error:{code:e.code||'SIDECAR_ERROR',message:e.message}};}finally{await sc.stop(5000).catch(()=>sc.kill());}
    signal?.throwIfAborted();
    if(signal&&!probe.backend_ok)return false;
    if(st.runtime?.python===python&&st.runtime.backend===b){
      const keys=['python','sidecar','torch','transformers','mlx','mlx_vlm','precision'];
      if(keys.every(key=>st.runtime.probe?.[key]===probe[key])){
        st.runtime={python,backend:b,probe,checked_at:now()};save();return signal?true:reconcile();
      }
    }
    st.runtime={python,backend:b,probe,checked_at:now()};st.preflight=null;save();
    ev(probe.backend_ok?'info':'warn','runtime.checked',{backend:b,ok:!!probe.backend_ok,error:probe.backend_error?.message});
    return signal?true:reconcile();
  }
  function archCheck(a){
    const p=profile(),q=p.targets.q_proj,v=p.targets.v_proj;
    if(p.test_only)return {ok:a.num_hidden_layers===p.layers&&a.hidden_size===q[0],expected:{layers:p.layers,hidden:q[0]}};
    const ok=a.model_type==='ministral3'&&a.num_hidden_layers===p.layers&&a.hidden_size===q[0]&&a.num_attention_heads*a.head_dim===q[1]&&a.num_key_value_heads*a.head_dim===v[1];
    return {ok,expected:{model_type:'ministral3',layers:p.layers,hidden:q[0],q_out:q[1],v_out:v[1]}};
  }
  async function setModel({model_dir,variant_id},signal){
    if(!st.runtime?.python)fail('RUNTIME_REQUIRED','check the compute runtime first');
    if(typeof model_dir!=='string'||!path.isAbsolute(model_dir)||!fs.existsSync(path.join(model_dir,'config.json')))fail('NOT_FOUND','choose a model folder that contains config.json');
    const p=profile();const vid=variant_id||(st.runtime.backend==='mlx'?'mlx-4bit':st.runtime.backend==='cuda'?'cuda-nf4':Object.keys(p.variants)[0]);
    if(p.variants[vid]?.backend!==st.runtime.backend)fail('INVALID_SCHEMA','model variant is incompatible with the selected backend');
    if(worker)await stopWorker();
    ev('info','model.verifying',{model_dir:path.basename(model_dir)});
    const sc=lockedSidecar({python:st.runtime.python,threads:1,extraEnv:testMode()?{KVALAH_COMPUTE_TEST:'1'}:{}});
    let v;try{v=await sidecarCall(sc,'verify_model',{model_dir},signal);}
    catch(error){if(signal&&!signal.aborted)return false;throw error;}
    finally{await sc.stop(5000).catch(()=>sc.kill());}
    signal?.throwIfAborted();
    const arch=archCheck(v.architecture);
    if(signal&&!arch.ok)return false;
    if(signal&&st.model?.variant_id===vid&&st.model.files_digest===v.files_digest&&st.model.model_dir===model_dir)return true;
    st.model={model_dir,variant_id:vid,file_list:v.files,files_digest:v.files_digest,total_bytes:v.total_bytes,files:v.files.length,architecture:v.architecture,architecture_ok:arch.ok,expected:arch.expected,
      quantization:v.quantization?{bits:v.quantization.bits??null,quant_method:v.quantization.quant_method??null}:null,pinned:PINNED[st.profile_id]?.[vid]||null,provenance:'unverified',verified_at:now()};
    st.preflight=null;save();
    ev(arch.ok?'info':'error','model.verified',{files_digest:v.files_digest.slice(0,16),architecture_ok:arch.ok});
    return signal?true:reconcile();
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
  async function runPreflight({max_length=256}={},signal){
    if(!st.model?.files_digest||!st.model.architecture_ok)fail('MODEL_REQUIRED','verify a compatible model first');
    if(![256,512].includes(max_length))fail('INVALID_SCHEMA','preflight context must be 256 or 512');
    if(profile().variants[st.model.variant_id]?.backend!==st.runtime?.backend)fail('INVALID_SCHEMA','model variant is incompatible with the selected backend');
    if(st.link&&!consentFor(st.link))fail('CONSENT_REQUIRED','accept the active project consent before running preflight');
    sensorsOn();
    if(worker)await stopWorker();
    const decision=()=>gov.decide({phase:'preflight',localAction:true});
    const p=profile(),d=decision();
    if(!d.run){if(!signal)await reconcile();fail('PAUSED','the resource policy does not allow work now: '+d.reason,{reason:d.reason});}
    ev('info','preflight.started',{});
    const sc=lockedSidecar({python:st.runtime.python,threads:Math.max(1,gov.cpuThreads(os.availableParallelism?.()||2)),extraEnv:testMode()?{KVALAH_COMPUTE_TEST:'1'}:{},
      onEvent:e=>{if(e.type==='permit_request'){
        const g=decision();
        sc.send({cmd:g.run?'permit':'stop',id:e.id,reason:g.reason});
      }}});
    let r;
    try{r=await sidecarCall(sc,'preflight',{model_dir:st.model.model_dir,model_files_digest:st.model.files_digest,backend:st.runtime.backend,vocab_hint:st.model.architecture?.vocab_size,task:{layers:p.layers,targets:p.targets,rank:p.rank,alpha:p.alpha,max_length}},signal);}
    catch(e){
      signal?.throwIfAborted();
      if(signal&&e.code==='STOPPED')fail('PAUSED','preflight paused by resource policy',{reason:decision().reason});
      st.preflight={ok:false,error:{code:e.code,message:e.message},files_digest:st.model.files_digest,at:now()};
      save();ev('error','preflight.failed',st.preflight.error);return signal?false:reconcile();
    }
    finally{await sc.stop(10000).catch(()=>sc.kill());}
    st.preflight={...r,backend:st.runtime.backend,files_digest:st.model.files_digest,at:now()};save();ev(r.ok?'info':'error','preflight.done',{ok:r.ok,step_s:r.step_s,model_load_s:r.model_load_s});
    return signal?!!r.ok:reconcile();
  }
  async function pair({pairing,alias}){
    if(worker)await stopWorker();
    const id=await ensureIdentity();
    const link=await pairWithCoordinator({pairing,identity:id,alias:String(alias||os.hostname()).slice(0,40),capabilities:capabilities(),runtime_version:VERSION});
    st.link=link;save();ev('info','link.paired',{endpoint:link.endpoint,project_id:link.project_id,state:link.device_state});
    return reconcile();
  }
  async function refreshLink(signal){
    if(!st.link)return snapshot();
    const {createClient}=await import('./worker/client.mjs');
    const c=createClient({endpoint:st.link.endpoint,fingerprint:st.link.fingerprint,identity:await getIdentity()});
    try{await c.syncTime({signal});const s=await c.get('/v2/devices/state',{signal});signal?.throwIfAborted();st.link={...st.link,device_state:s.state};save();}
    catch(e){if(e.code==='REVOKED'){st.link={...st.link,device_state:'revoked'};save();}else throw e;}
    finally{c.close();}
    return reconcile();
  }
  async function forgetLink(){st.setup_requested=false;await preparation.cancel();if(worker)await stopWorker();st.link=null;st.participation=false;save();ev('info','link.forgotten',{});return reconcile();}
  async function setParticipation(on){
    if(on){
      if(!st.link)fail('SETUP_REQUIRED','connect to a coordinator first (Devices)');
      if(!consentFor(st.link))fail('CONSENT_REQUIRED','read and accept the consent for this project first');
      st.participation=true;
    }else{st.participation=false;st.setup_requested=false;await preparation.cancel();}
    save();ev('info',on?'participation.on':'participation.off',{});return reconcile();
  }
  function setPause(v){st.manual_pause=!!v;gov.setManualPause(!!v);save();ev('info',v?'participation.paused':'participation.resumed',{});return snapshot();}
  function setPolicy(policy,revision){const p=gov.setPolicy(policy,revision);st.policy=p;save();ev('info','policy.changed',{revision:p.revision});return snapshot();}
  const fixture=()=>testMode()&&process.env.KVALAH_UX_TEST_PYTHON&&process.env.KVALAH_UX_TEST_MODEL?{
    python:process.env.KVALAH_UX_TEST_PYTHON,model_dir:process.env.KVALAH_UX_TEST_MODEL,backend:'torch-cpu-test'
  }:null;
  const discover=()=>localCandidates({dir,platform,profile:profile(),runtime:st.runtime,model:st.model,fixture:fixture()});
  const currentConsent=()=>consentFor(st.link);
  const downloadOptions=(signal,progress)=>({governor:gov,signal,progress,approve(offer){
    const permission=currentConsent()?.downloads?.[offer.id];
    if(permission>=offer.bytes)return true;
    downloadOffer=offer;return false;
  }});
  const preparation=createSetup({
    now,readLink:()=>st.link,refreshLink,hasConsent:()=>st.setup_requested&&currentConsent()?.scopes?.automatic_setup,
    candidates:discover,useRuntime:setRuntime,useModel:setModel,
    runPreflight:signal=>{
      const pf=st.preflight;
      if(pf?.ok&&pf.max_length===256&&pf.backend===st.runtime.backend&&pf.files_digest===st.model.files_digest&&now()-pf.at<7*86400000)return true;
      return runPreflight({},signal);
    },
    async downloadModel({variant,signal,progress}){
      const assets=await modelAssets(st.profile_id,variant,signal);
      if(!assets)return null;
      return downloadAssets(assets,{...downloadOptions(signal,progress),root:path.join(dir,'models')});
    },
    async installRuntime({backend,signal,progress}){
      const plan=runtimeAssets(backend,platform,process.arch);
      const candidates=platform==='win32'?[process.env.LOCALAPPDATA&&path.join(process.env.LOCALAPPDATA,'Programs','Python','Python312','python.exe')]:
        ['/opt/homebrew/bin/python3.12','/Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12'];
      const bootstrap=candidates.find(p=>p&&fs.existsSync(p));
      if(!plan||!bootstrap)return null;
      const wheelDir=await downloadAssets(plan,{...downloadOptions(signal,progress),root:path.join(dir,'wheels')});
      return createManagedRuntime({bootstrap,wheelDir,environment:path.join(dir,'runtimes',backend),plan,signal});
    },
    async activate(){
      if(st.link.device_state!=='active'||!currentConsent()?.scopes?.automatic_setup)fail('CONSENT_REQUIRED','setup consent was withdrawn');
      st.setup_requested=false;st.participation=true;save();await reconcile();
    },
    onState(state){if(['waiting','ready','blocked','cancelled'].includes(state.status))ev('info','setup.'+state.status,{phase:state.phase,code:state.error_code||state.reason});}
  });
  async function onboardingJoin({invitation,replace=false}){
    const incoming=parsePairing(invitation);
    if(!isPrivate(new URL(incoming.endpoint).hostname))fail('FORBIDDEN_SCOPE','the invitation is outside the local network');
    if(st.link&&st.link.endpoint===incoming.endpoint&&st.link.fingerprint===incoming.fingerprint&&st.link.device_state!=='revoked')return snapshot();
    if(st.link&&replace!==true)fail('INVITE_REPLACE','confirm switching to a different network');
    const prior=st.participation;
    st.setup_requested=false;await preparation.cancel();downloadOffer=null;
    st.participation=false;
    try{await pair({pairing:invitation});}
    catch(error){st.participation=prior;await reconcile();throw error;}
    save();return reconcile();
  }
  function retrySetup(){
    if(!currentConsent()?.scopes?.automatic_setup||st.link?.device_state==='revoked')fail('CONSENT_REQUIRED','setup consent is required');
    st.setup_requested=true;save();sensorsOn();preparation.start();return snapshot();
  }
  // ---------- Training Lab (local coordinator) ----------
  function svc(){
    service??=createCoordinatorService({dir:path.join(dir,'coordinator'),startSidecar:lockedSidecar,log:m=>log('[coordinator] '+m),
      evaluator:()=>st.runtime?.probe?.backend_ok&&st.model?.architecture_ok?{python:st.runtime.python,backend:st.runtime.backend,model_dir:st.model.model_dir,variant_id:st.model.variant_id,files_digest:st.model.files_digest,
        threads:gov.cpuThreads(os.availableParallelism?.()||2),extraEnv:testMode()?{KVALAH_COMPUTE_TEST:'1'}:{}}:null,
      canRunHeavy:()=>gov.decide({phase:'preflight',localAction:true})});
    return service;
  }
  const hasLab=()=>!!service||fs.existsSync(path.join(dir,'coordinator','db','coordinator.sqlite'));
  async function labStart({bind_ip,port}){
    const r=await svc().start({bindIp:bind_ip,port:port===0||port==='0'?0:Number(port)||DEFAULT_PORT});st.lab={bind_ip,port:r.port,was_running:true};save();sensorsOn();ev('info','lab.started',{endpoint:r.endpoint});return snapshot();
  }
  async function autoLab(){
    if(service?.info().running)return snapshot();
    const addresses=lanAddresses().filter(a=>a.private&&!/vpn|virtual|wsl|docker|loopback|tunnel|tap-|tailscale|hyper-v|veth/i.test(a.interface));
    const routable=await new Promise(resolve=>{
      const sock=dgram.createSocket('udp4'),timer=setTimeout(()=>finish(null),500);
      function finish(value){clearTimeout(timer);try{sock.close();}catch{}resolve(value);}
      sock.once('error',()=>finish(null));
      try{sock.connect(9,'192.0.2.1',()=>finish(sock.address().address));}catch{finish(null);}
    });
    const bind_ip=addresses.find(a=>a.address===routable)?.address||addresses[0]?.address||'127.0.0.1';
    try{return await labStart({bind_ip,port:DEFAULT_PORT});}
    catch(error){if(error.code!=='UNAVAILABLE'||!error.message.includes('already in use'))throw error;return labStart({bind_ip,port:0});}
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
      self_device:identity?.device_id||null,smoke:smokeReadiness()};
  }
  const smokeRequests=new Map();
  function smokeReadiness(ids){
    const c=service?.coord,p=profile();
    if(!c||!service.info().running)return {ready:false,reason:'lab_inactive',devices:[],target:3};
    const registered=c.variants().filter(v=>v.profile_id===p.id);
    const all=c.listDevices().map(device=>{
      const caps=device.capabilities;
      const variant=caps?.variants?.find(v=>v.profile_id===p.id&&p.variants[v.variant_id]?.backend===caps.backend);
      const reg=registered.find(v=>v.variant_id===variant?.variant_id);
      let reason=null;
      if(device.state!=='active')reason=device.state==='pending'?'pending_approval':'revoked';
      else if(!device.online)reason='device_offline';
      else if(device.status?.drain)reason='drained';
      else if(!caps?.preflight_ok||caps.preflight_max_length!==256)reason='preflight_required';
      else if(!device.status?.eligible)reason=device.status?.blocking_reason||'waiting_heartbeat';
      else if(!variant?.files_digest||reg?.files_digest&&reg.files_digest!==variant.files_digest)reason='model_mismatch';
      return {id:device.id,alias:device.alias,online:device.online,authorization:device.state,reason,
        variant:variant?.variant_id,digest:variant?.files_digest,verified:reg?.provenance==='verified'};
    });
    const selected=Array.isArray(ids)?ids:all.filter(d=>!d.reason).slice(0,3).map(d=>d.id);
    const selectedDevices=selected.map(id=>all.find(d=>d.id===id)).filter(Boolean);
    const digests=new Map();
    for(const d of selectedDevices){
      if(digests.has(d.variant)&&digests.get(d.variant)!==d.digest)d.reason='model_mismatch';
      digests.set(d.variant,d.digest);
    }
    const localOk=st.preflight?.ok&&st.preflight.max_length===256&&selectedDevices.some(d=>d.digest===st.model?.files_digest&&d.variant===st.model?.variant_id);
    const policy=gov.decide({phase:'preflight',localAction:true});
    const enough=selected.length>=1&&selected.length<=32&&selected.length===(ids?new Set(ids).size:3)&&
      selectedDevices.length===selected.length&&selectedDevices.every(d=>!d.reason);
    return {ready:!!(enough&&localOk&&policy.run),target:ids?ids.length:3,ids:selected,devices:all,
      reason:!enough?'below_quorum':!localOk?'local_evaluator_required':!policy.run?policy.reason:null,
      unverified:selectedDevices.some(d=>!d.verified)};
  }
  function startSmoke({device_ids,accept_unverified,request_id}){
    if(typeof request_id!=='string'||!/^[-a-z0-9]{12,70}$/i.test(request_id))fail('INVALID_SCHEMA','Smoke request requires an idempotency key');
    if(st.last_smoke?.key===request_id)return Promise.resolve(st.last_smoke.result);
    if(smokeRequests.has(request_id))return smokeRequests.get(request_id);
    if(smokeRequests.size)fail('CONFLICT','a Smoke test is already being prepared');
    if(!Array.isArray(device_ids)||device_ids.length!==3||new Set(device_ids).size!==3)fail('INVALID_SCHEMA','standard Smoke requires three distinct workers');
    const s=svc(),c=s.coord;
    const assertReady=()=>{
      const ready=smokeReadiness(device_ids);
      if(!ready.ready)fail('SMOKE_BLOCKED','network is not ready',{reason:ready.reason});
      if(ready.unverified&&accept_unverified!==true)fail('MODEL_UNVERIFIED','accept the engineering-only model scope first');
      return ready;
    };
    const job=(async()=>{
      let ready=assertReady();
      const rev=st.model.files_digest.slice(0,12),id='smoke-sft-v1@'+rev;
      if(!c.listDatasets().some(d=>d.id===id)){
        await s.importDataset({fixture:true,dataset_id:'smoke-sft-v1',revision:rev,profile_id:st.profile_id});
      }
      ready=assertReady();
      const selected=ready.devices.filter(d=>device_ids.includes(d.id));
      for(const d of selected){
        if(c.variants().some(v=>v.profile_id===st.profile_id&&v.variant_id===d.variant&&v.files_digest===d.digest))continue;
        if(d.digest===st.model.files_digest&&d.variant===st.model.variant_id){
          await s.registerModel({profile_id:st.profile_id,variant_id:d.variant,model:st.model,provenance_check:st.model.provenance_check});
        }else await s.registerModel({profile_id:st.profile_id,variant_id:d.variant,model:{files_digest:d.digest}});
      }
      assertReady();
      const exp=c.createExperiment({name:'Smoke',preset:'smoke',profile_id:st.profile_id,dataset_id:id,
        variants:[...new Set(selected.map(d=>d.variant))],target_device_ids:device_ids});
      const result=c.startExperiment(exp.id);
      st.last_smoke={key:request_id,result};save();
      return result;
    })().finally(()=>smokeRequests.delete(request_id));
    smokeRequests.set(request_id,job);
    return job;
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
        if(b.device_id){
          // A variant this coordinator cannot verify locally (e.g. the Mac's MLX folder): register the files digest the
          // approved device reported. Provenance stays unverified unless it is byte-identical to the verified local folder.
          const d=c.listDevices().find(x=>x.id===String(b.device_id)&&x.state==='active');if(!d)fail('NOT_FOUND','approved device not found');
          const v=(d.capabilities?.variants||[]).find(x=>x.profile_id===st.profile_id&&x.variant_id===b.variant_id);
          if(!v?.files_digest)fail('NOT_FOUND','the device did not report a verified model for this variant');
          const same=st.model?.variant_id===v.variant_id&&st.model.files_digest===v.files_digest;
          c.db.prepare('insert into audit_log(ts,actor,action,details) values(?,?,?,?)').run(now(),'local-admin','model.register_from_device',JSON.stringify({device:d.id,variant:v.variant_id,files_digest:v.files_digest}));
          return s.registerModel({profile_id:st.profile_id,variant_id:v.variant_id,model:same?{files_digest:v.files_digest,architecture:st.model.architecture,total_bytes:st.model.total_bytes,quantization:st.model.quantization}:{files_digest:v.files_digest},provenance_check:same?st.model.provenance_check:null});
        }
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
      case 'events':return b.tail===true?c.latestEvents(200):c.events(Number(b.after)||0,200);
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
    return {version:VERSION,revision:++revision,test_mode:testMode(),platform,state:d.state,reason:d.reason,missing:d.missing||setup(),participation:st.participation,manual_pause:st.manual_pause,
      preparation:preparation.state,download_offer:preparation.state.reason==='DOWNLOAD_APPROVAL'?downloadOffer:null,
      consent:{required:!!st.link&&!consentFor(st.link),current:consentFor(st.link)||null,text:consentText(),history:st.consents.slice(-10)},
      policy:gov.policy,nominal_monthly_hours:nominalMonthlyHours(gov.policy),budget:gov.budget(),month:gov.month(),measured:gov.measured(),
      governor:{decision,broker:gov.brokerBusy,sensors:redactSensors(gov.sensors)},
      profile:{id:st.profile_id,available:listProfiles().map(p=>p.id),variants:Object.keys(profile().variants),
        runtime_variants:Object.entries(profile().variants).filter(([,v])=>v.backend===st.runtime?.backend).map(([id])=>id)},
      runtime:st.runtime,model:st.model?(({file_list,...m})=>m)(st.model):null,preflight:st.preflight,
      link:st.link,identity:identity?{device_id:identity.device_id,key_fingerprint:identity.key_fingerprint,secret_store:identity.secret_store}:null,
      worker:w?{state:w.state,reason:w.reason,task:w.task,metrics:w.metrics,last_accepted:w.last_accepted,outbox:w.outbox,last_rpc_error:w.last_rpc_error,session:w.session}:null,
      last_error:lastError,lab:labView(),lab_addresses:lanAddresses(),legacy:legacyView(),events:events.slice(-80)};
  }
  const redactSensors=s=>({on_battery:s.on_battery??null,idle_s:s.idle_s??null,thermal_state:s.thermal_state??null,game:s.game??null,fullscreen:s.fullscreen??null,
    gpu:s.gpu?{name:s.gpu.name,utilization_pct:s.gpu.utilization_pct,memory_used_bytes:s.gpu.memory_used_bytes,memory_total_bytes:s.gpu.memory_total_bytes,temperature_c:s.gpu.temperature_c,power_w:s.gpu.power_w}:null,
    ram_free_bytes:s.ram_free_bytes??null,ram_total_bytes:s.ram_total_bytes??null,at:s.at??null});
  function diagnostics(){
    const status=derived(),w=worker?.state,s=gov.sensors;
    const safeId=v=>typeof v==='string'&&/^[a-z0-9_.:-]{1,80}$/i.test(v)?v:null;
    const eventDetails=details=>Object.fromEntries(Object.entries(details||{}).flatMap(([key,value])=>{
      if(['duration_ms','status','attempt','bytes','next_retry_at','round'].includes(key)&&Number.isFinite(value))return [[key,value]];
      if(['code','method','stage','correlation_id','errno'].includes(key)&&safeId(value))return [[key,value]];
      if(key==='route'&&typeof value==='string'&&/^\/v2\/[a-z_/:]+$/.test(value))return [[key,value]];
      return [];
    }));
    return {schema_version:1,created_at:now(),version:VERSION,platform,state:status.state,reason:safeId(status.reason),missing:setup(),
      model:st.model?{variant_id:st.model.variant_id,files_digest:st.model.files_digest,provenance:st.model.provenance}:null,
      runtime:st.runtime?{backend:st.runtime.backend,python_version:st.runtime.probe?.python??null}:null,
      preflight:st.preflight?{ok:!!st.preflight.ok,max_length:st.preflight.max_length??null,step_s:st.preflight.step_s??null,model_load_s:st.preflight.model_load_s??null}:null,
      decision:{run:gov.decide().run,reason:gov.decide().reason},budget:gov.budget(),
      sensors:{ram_free_bytes:s.ram_free_bytes??null,ram_total_bytes:s.ram_total_bytes??null,memory_pressure:s.memory_pressure??null,at:s.at??null},
      worker:w?{state:w.state,reason:safeId(w.reason),outbox:w.outbox,task:w.task,metrics:w.metrics,last_rpc_error:w.last_rpc_error?eventDetails(w.last_rpc_error):null}:null,
      preparation:preparation.state,
      events:events.slice().reverse().map(e=>({seq:e.seq,ts:e.ts,severity:e.severity,code:e.code,details:eventDetails(e.details)}))};
  }
  async function boot(){
    await getIdentity().catch(e=>ev('error','identity.unreadable',{message:e.message}));
    if(st.lab?.was_running&&st.lab.bind_ip)await labStart({bind_ip:st.lab.bind_ip,port:st.lab.port}).catch(e=>ev('warn','lab.autostart_failed',{message:e.message}));
    // Participation never auto-starts across app restarts without the consent record; with it, it resumes.
    await reconcile().catch(e=>{lastError={code:e.code,message:e.message};});
    if(st.setup_requested&&currentConsent()?.scopes?.automatic_setup&&st.link.device_state!=='revoked'){
      sensorsOn();preparation.start();
    }
    return snapshot();
  }
  async function shutdown(){await preparation.cancel();await stopWorker().catch(()=>{});if(service)await service.close().catch(()=>{});sensorsOff();gov.save();}
  // ---------- request router (used by host IPC and tests) ----------
  async function handle(method,route,b={}){
    const r=route.replace(/^\/+/,'');
    if(method==='GET'&&r==='state')return snapshot();
    if(method==='GET'&&r==='events')return events.filter(e=>e.seq>(Number(b.after)||0));
    if(method==='GET'&&r==='diagnostics')return diagnostics();
    if(method==='GET'&&r==='onboarding/detect')return describeHardware({platform,dir,candidates:discover()});
    if(method!=='POST')fail('NOT_FOUND','not found');
    switch(r){
      case 'consent/accept':return acceptConsent(b);
      case 'consent/revoke':return revokeConsent();
      case 'participation':return setParticipation(b.enabled===true);
      case 'pause':return setPause(true);
      case 'resume':return setPause(false);
      case 'policy':return setPolicy(b.policy,b.revision);
      case 'policy/preset':{
        if(!Object.hasOwn(participationProfiles,b.id))fail('INVALID_SCHEMA','unknown participation profile');
        return setPolicy({...participationProfiles[b.id],profile:b.id==='gentle'?'gentle':'custom'},b.revision);
      }
      case 'onboarding/join':return onboardingJoin(b);
      case 'onboarding/retry':return retrySetup();
      case 'onboarding/cancel':st.setup_requested=false;save();await preparation.cancel();return reconcile();
      case 'onboarding/download':{
        const consent=currentConsent(),offer=downloadOffer;
        if(!consent?.scopes?.automatic_setup||preparation.state.reason!=='DOWNLOAD_APPROVAL'||!offer||
          b.id!==offer.id||b.bytes!==offer.bytes)fail('DOWNLOAD_APPROVAL','confirm the current download size');
        consent.downloads={...consent.downloads,[offer.id]:offer.bytes};save();
        return retrySetup();
      }
      case 'runtime':return setRuntime(b);
      case 'model':return setModel(b);
      case 'model/provenance':return checkProvenance();
      case 'preflight':return runPreflight(b);
      case 'link/pair':return pair(b);
      case 'link/refresh':return refreshLink();
      case 'link/forget':return forgetLink();
      case 'profile':{if(worker)await stopWorker();getProfile(b.profile_id);st.profile_id=b.profile_id;st.model=null;st.preflight=null;save();return reconcile();}
      case 'lab/start':return labStart(b);
      case 'lab/auto-start':return autoLab();
      case 'lab/smoke-readiness':return smokeReadiness(b.ids);
      case 'lab/smoke-start':return startSmoke(b);
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
