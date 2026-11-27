// Kvalah Compute v0.2 view. Every control calls /api/compute/v2/* (served by the compute host child
// process); nothing here is simulated. When the feature flag is off only the enable card is shown.
(()=>{
  const D=window.KC_I18N;
  const lang=()=>window.kvI18n?.lang==='ru'?'ru':'en';
  const ct=(k,p)=>{let v=D[lang()][k]??D.en[k]??k;if(p)for(const [a,b] of Object.entries(p))v=v.split('{'+a+'}').join(String(b));return v;};
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const X=window.KC_EXPERIENCE;
  const tx=(key,values={})=>{
    let value=X[key]?.[lang()==='ru'?0:1]||ct(key);
    for(const [name, replacement] of Object.entries(values))value=value.replaceAll('{'+name+'}',String(replacement));
    return value;
  };
  const friendly=code=>X[code]?tx(code):code&&D[lang()]['r.'+code]?ct('r.'+code):tx('errorDefault');
  const trust=p=>tx(p==='locally_attested'?'trustLocal':p==='verified'?'trustReady':'trustUnknown');
  const reason=r=>r?(X[r]?tx(r):D[lang()]['r.'+r]?ct('r.'+r):String(r)):'';
  const short=h=>h?String(h).slice(0,12):ct('none');
  const fmtMs=ms=>{if(ms==null)return ct('none');const s=Math.round(ms/1000);return s<60?s+' s':s<3600?Math.floor(s/60)+' min '+(s%60)+' s':Math.floor(s/3600)+' h '+Math.floor(s%3600/60)+' min';};
  const fmtB=b=>b==null?ct('none'):b<1024?b+' B':b<1048576?(b/1024).toFixed(1)+' KB':b<1073741824?(b/1048576).toFixed(1)+' MB':(b/1073741824).toFixed(2)+' GB';
  const when=ts=>ts?new Date(ts).toLocaleString(lang()):ct('none');
  const desktop=()=>window.kvalahDesktop;
  const call=(route,body)=>api('/api/compute/v2/'+route,body);
  const fusionCall=(route,body)=>api('/api/compute/fusion/'+route,body);
  const fx=(ru,en)=>lang()==='ru'?ru:en;
  let form={},planInput=null;
  let S=null,tab='overview',open=false,busy=false,timer=null,selExp=null,expData=null,coordEvents=[],plan=null,pairing=null,lastResult={};
  let fusionState=null,fusionTab='summary',fusionEstimate=null,fusionError=null;
  let fusionLayers=new Set([0]);
  let mode=localStorage.getItem('kvalah-compute-mode')==='laboratory'?'laboratory':'contribution';
  let refreshId=0,stale=false,hardware=null,smoke=null,requestId=null,smokeIds=[],expanded=new Set(),invitationEpoch=0;
  const presets={gentle:10,balanced:25,productive:50};
  const root=()=>document.getElementById('computeView');
  const body=()=>document.getElementById('computeContent');
  const scroll=()=>document.getElementById('computeBody');
  const dialog=()=>document.getElementById('computeConsent');
  // ---------- shell ----------
  function show(on){
    open=on;document.body.classList.toggle('compute-open',on);root().hidden=!on;
    if(on){refresh(true);clearInterval(timer);timer=setInterval(()=>{if(!document.hidden)refresh(false);},2000);}else clearInterval(timer);
  }
  async function refresh(full){
    const id=++refreshId;
    let next;
    try{next=await call('state');}catch{
      if(id!==refreshId)return;
      stale=true;render(full);return;
    }
    if(id!==refreshId)return;
    S=next;stale=false;
    if(S.expert_fusion_enabled&&mode==='laboratory'&&tab==='fusion'){
      try{
        const current=await fusionCall('state');
        if(id!==refreshId)return;
        if(fusionState?.builder?.model?.id!==current.builder?.model?.id){fusionEstimate=null;fusionLayers=new Set([0]);}
        fusionState=current;fusionError=null;
      }catch(error){if(id!==refreshId)return;fusionError=error.message;}
    }
    if(S.feature_enabled&&S.lab&&mode==='laboratory'&&tab==='monitor'){
      const exps=S.lab.experiments||[];
      if(!selExp||!exps.some(e=>e.id===selExp))selExp=exps[0]?.id||null;
      try{
        const [exp,events]=await Promise.all([selExp?call('lab/experiment/status',{id:selExp}):null,call('lab/events',{tail:true})]);
        if(id!==refreshId)return;
        expData=exp;coordEvents=Array.isArray(events)?events.slice(-60):[];
      }catch{if(id!==refreshId)return;expData=null;}
    }
    render(full);
    if(dialog().open&&dialog().dataset.kind==='smoke'&&!busy)void refreshSmoke();
  }
  const editing=()=>{const a=document.activeElement;return a&&root()?.contains(a)&&/^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName);};
  const L=(id,fn)=>'<div data-live="'+id+'">'+fn()+'</div>';
  function setMode(next){
    mode=next;localStorage.setItem('kvalah-compute-mode',mode);lastResult={};scroll().scrollTop=0;render(true);void refresh(true);
  }
  function render(full){
    if(!open)return;
    const modes=document.getElementById('computeModes');
    modes.setAttribute('aria-label',tx('mode'));
    for(const b of modes.querySelectorAll('[data-mode]')){
      b.textContent=tx(b.dataset.mode);b.setAttribute('aria-pressed',String(b.dataset.mode===mode));
    }
    document.getElementById('computeTitle').textContent=ct('title');
    document.getElementById('computeSub').textContent=tx('volunteer');
    document.getElementById('computeBack').title=ct('back');
    document.getElementById('computeBack').setAttribute('aria-label',ct('back'));
    document.getElementById('computeBadge').innerHTML=stale?pill(tx('stale'),'warn'):
      mode==='laboratory'&&S?.participation?btn('stop',tx('stop')):'';
    if(!full&&editing())return;
    const focus=body().contains(document.activeElement)?document.activeElement:null;
    const act=focus?.getAttribute('data-act'),arg=focus?.getAttribute('data-arg');
    const y=scroll().scrollTop;
    body().innerHTML=S?(mode==='contribution'?participate():laboratory()):'<p class="kc-subtle" role="status">'+esc(stale?tx('stale'):tx('checking'))+'</p>';
    for(const d of body().querySelectorAll('details[data-expand]'))d.open=expanded.has(d.dataset.expand);
    for(const [id,value] of Object.entries(form)){
      const el=body().querySelector('#'+CSS.escape(id));if(!el)continue;
      if(el.type==='checkbox')el.checked=value;else el.value=value;
    }
    if(busy)body().querySelectorAll('button,input,select,textarea').forEach(el=>el.disabled=true);
    scroll().scrollTop=y;
    if(act){
      const replacement=[...body().querySelectorAll('[data-act]')].find(b=>b.dataset.act===act&&b.getAttribute('data-arg')===arg);
      replacement?.focus({preventScroll:true});
    }
  }
  const card=(title,inner,extra='')=>'<section class="kc-card'+extra+'">'+(title?'<h3>'+esc(title)+'</h3>':'')+inner+'</section>';
  const btn=(act,label,o={})=>'<button type="button" class="'+(o.primary?'primary kc-btn':'secondary')+'" data-act="'+act+'"'+(o.arg!=null?' data-arg="'+esc(o.arg)+'"':'')+(o.disabled?' disabled':'')+'>'+esc(label)+'</button>';
  const field=(id,label,value,o={})=>'<label class="kc-field'+(o.wide?' wide':'')+'"><span>'+esc(label)+'</span><span class="kc-inline"><input id="'+id+'" value="'+esc(value??'')+'"'+(o.placeholder?' placeholder="'+esc(o.placeholder)+'"':'')+(o.type?' type="'+o.type+'"':'')+'>'+(o.browse?'<button type="button" class="secondary" data-act="browse" data-arg="'+id+'|'+o.browse+'">'+esc(ct('browse'))+'</button>':'')+'</span></label>';
  const msg=k=>lastResult[k]?'<p class="kc-msg'+(lastResult[k].bad?' bad':'')+'">'+esc(lastResult[k].text)+'</p>':'';
  const kv=rows=>'<dl class="kc-kv">'+rows.filter(Boolean).map(([k,v])=>'<dt>'+esc(k)+'</dt><dd>'+v+'</dd>').join('')+'</dl>';
  const panel=(title,inside,style='')=>'<section class="kc-panel '+style+'">'+(title?'<h2>'+esc(title)+'</h2>':'')+inside+'</section>';
  const row=inside=>'<div class="kc-row-actions">'+inside+'</div>';
  const pill=(title,tone='')=>'<span class="kc-pill '+tone+'">'+esc(title)+'</span>';
  const h2=label=>'<h2>'+esc(label)+'</h2>';
  const plain=(value,classes='')=>'<p class="'+classes+'">'+esc(value)+'</p>';
  const title=(label,tagline,action='')=>'<div class="kc-experience-title"><div><h1>'+esc(label)+'</h1>'+plain(tagline)+'</div>'+action+'</div>';
  const scores=entries=>'<dl class="kc-score-grid">'+entries.map(([label,value])=>'<div><dt>'+esc(label)+'</dt><dd'+
    (value==='—'?' title="'+esc(tx('noMeasure'))+'"':'')+'>'+esc(value)+'</dd></div>').join('')+'</dl>';
  const notice=(message,tone='')=>'<p class="kc-notice" data-tone="'+tone+'">'+esc(message)+'</p>';
  const meter=ms=>ms==null?'—':Math.floor(ms/60000)+' '+(lang()==='ru'?'мин':'min');
  const activeProfile=()=>Object.keys(presets).find(key=>{
    const p=S.policy;return p?p.gpu_target_pct===presets[key]&&p.cpu_target_pct===presets[key]&&p.daily_hours===4:key==='gentle';
  });
  const stateText=state=>({
    CREATED:tx('draft'),RUNNING:tx('inProgress'),PAUSED:tx('paused'),BLOCKED:tx('blocked'),
    COMPLETED:tx('completion'),CANCELLED:tx('cancelled'),COMMITTED:tx('completion'),
    OPEN:tx('ready'),COLLECTING:tx('inProgress'),FAILED:tx('blocked'),SEALING:tx('inProgress'),AGGREGATING:tx('inProgress')
  })[state]||tx('checking');
  const preparationSteps=['approval','runtime','model','integrity','preflight'];
  const stepLabels=['stageApproval','stageRuntime','stageModel','stageIntegrity','stagePreflight'];
  function progressList(p){
    const index=preparationSteps.indexOf(p.phase);
    return '<ol class="kc-steps">'+stepLabels.map((key,i)=>{
      const done=i<index||p.status==='ready',current=i===index&&!done;
      return '<li'+(done?' class="done"':current?' aria-current="step"':'')+'><span class="kc-step-icon" aria-hidden="true">'+(done?'✓':i+1)+'</span>'+esc(tx(key))+'</li>';
    }).join('')+'</ol>'+
      (p.total_bytes?'<progress class="kc-bytes-progress" aria-label="'+esc(tx('stageModel'))+'" max="'+p.total_bytes+'" value="'+(p.bytes||0)+'"></progress>'+plain(fmtB(p.bytes||0)+' / '+fmtB(p.total_bytes),'kc-caption'):'');
  }
  function participationStatus(){
    const p=S.preparation||{},active=['running','waiting'].includes(p.status);
    if(!S.link)return pill(tx('offline'))+h2(tx('joinTitle'))+plain(tx('joinText'))+
      row(btn('join-wizard',tx('join'),{primary:true})+btn('switch-lab',tx('ownLab')));
    if(S.link.device_state==='revoked')return pill(tx('revoked'),'bad')+h2(tx('actionNeeded'))+plain(friendly('REVOKED'))+row(btn('join-wizard',tx('join'),{primary:true}));
    if(S.consent?.required)return pill(tx('checking'))+h2(tx('consentTitle'))+plain(tx('consentText'))+row(btn('review-consent',tx('next'),{primary:true}));
    if(active||p.status==='blocked'||p.status==='cancelled'){
      const offer=S.download_offer;
      const head=active?tx('preparing'):tx('actionNeeded');
      let action='';
      if(offer)action=notice(tx('downloadText',{bytes:fmtB(offer.bytes),disk:fmtB(offer.disk_bytes)}),'warn')+
        row(btn('approve-download',tx('download'),{primary:true})+btn('setup-cancel',tx('cancel')));
      else if(active)action=(p.reason?notice(friendly(p.reason),'warn'):'')+row(btn('setup-cancel',tx('cancel')));
      else action=(p.reason?notice(friendly(p.reason),'warn'):'')+
        row(btn('setup-retry',tx('retry'),{primary:true})+btn('expert-open',tx('expert')));
      return pill(head,active?'warn':'bad')+h2(head)+plain(tx('preparingText'))+progressList(p)+action;
    }
    if(S.missing?.size||S.missing?.length)return pill(tx('temporary'),'warn')+h2(tx('actionNeeded'))+
      row(btn('review-consent',tx('finishSetup'),{primary:true})+btn('expert-open',tx('expert')));
    if(!S.participation)return pill(tx('stopped'))+h2(tx('stopped'))+plain(tx('readyText'))+row(btn('start-participation',tx('resume'),{primary:true}));
    const blocked=stale||['PAUSED','BLOCKED_BY_TRAFFIC_POLICY','ERROR_RECOVERABLE'].includes(S.state);
    const moving={TRAINING:'busyTraining',UPLOADING:'busyUpload',PREPARING:'preparing',CONNECTING:'checking',STOPPING:'stopped'}[S.state];
    const head=blocked?(S.state==='ERROR_RECOVERABLE'||stale?tx('reconnecting'):tx('paused')):tx(moving||'ready');
    const reasonCode=S.worker?.last_rpc_error?.code&&S.state==='ERROR_RECOVERABLE'?S.worker.last_rpc_error.code:S.reason;
    return pill(blocked?tx('temporary'):moving?head:tx('connected'),blocked?'warn':'good')+h2(head)+
      plain(blocked?(stale?tx('stale'):friendly(reasonCode)):tx('readyText'))+
      (S.worker?.task?plain(ct('task',{round:(S.worker.task.round??0)+1,step:S.worker.task.step,steps:S.worker.task.steps,tokens:S.worker.task.expected_tokens}),'kc-caption'):'')+
      row((S.manual_pause?btn('resume',tx('resume'),{primary:true}):btn('pause',tx(blocked?'pauseManual':'pause')))+btn('stop',tx('stop')));
  }
  function advancedPolicy(){
    const p=S.policy;
    if(!p)return '<details class="kc-extra" data-expand="policy"><summary>'+esc(tx('advanced'))+'</summary>'+row(btn('feature-on',ct('feature.enable')))+
      plain(tx('powerNote'),'kc-caption')+'</details>';
    const slider=(key,label,max,unit='%')=>'<label class="kc-slider"><span>'+esc(label)+' <b id="v_'+key+'">'+p[key]+esc(unit)+'</b></span><input type="range" min="'+(key==='daily_hours'?1:0)+'" max="'+max+'" step="'+(key==='daily_hours'?1:5)+'" value="'+p[key]+'" data-pol="'+key+'" data-unit="'+esc(unit)+'"></label>';
    const checkbox=key=>'<label class="kc-check"><input type="checkbox" data-pol="'+key+'"'+(p[key]?' checked':'')+'> '+esc(ct(key))+'</label>';
    const input=(key,min,max,step=1,label=ct(key))=>'<label class="kc-field"><span>'+esc(label)+'</span><input type="number" data-pol="'+key+'" min="'+min+'" max="'+max+'" step="'+step+'" value="'+esc(p[key])+'"></label>';
    const select=(key,label,choices)=>'<label class="kc-field"><span>'+esc(label)+'</span><select data-pol="'+key+'">'+
      choices.map(([value,name])=>'<option value="'+esc(value)+'"'+(p[key]===value?' selected':'')+'>'+esc(name)+'</option>').join('')+'</select></label>';
    const quiet='<div class="kc-quiet"><label class="kc-check"><input type="checkbox" data-pol="quiet_hours.enabled"'+(p.quiet_hours.enabled?' checked':'')+'> '+esc(ct('quiet'))+'</label>'+
      ['from','to'].map(k=>'<label>'+esc(ct('quiet.'+k))+' <input type="time" data-pol="quiet_hours.'+k+'" value="'+esc(p.quiet_hours[k])+'"></label>').join('')+'</div>';
    return '<details class="kc-extra" data-expand="policy"><summary>'+esc(tx('advanced'))+'</summary>'+
      slider('gpu_target_pct',ct('gpu'),p.profile==='full'?100:50)+slider('cpu_target_pct',ct('cpu'),100)+slider('daily_hours',ct('hours'),p.extended_hours?24:12,lang()==='ru'?' ч':' h')+
      '<div class="kc-detail-grid">'+['only_idle','only_ac','pause_on_games','pause_on_local_ai','pause_on_fullscreen','allow_metered','extended_hours'].map(checkbox).join('')+'</div>'+
      '<div class="kc-detail-grid">'+input('idle_minutes',1,120)+input('min_free_ram_gib',0,256,.5)+input('temp_limit_c',50,95)+input('daily_traffic_mb',10,1000000,10)+
      input('lan_traffic_mb',10,1000000,1,tx('lanTraffic'))+input('wan_traffic_mb',10,1000000,1,tx('wanTraffic'))+
      select('runtime_mode',tx('residentPolicy'),[['cold',tx('residentCold')],['warm',tx('residentWarm')],['adaptive',tx('residentAdaptive')]])+
      input('runtime_idle_s',5,3600,1,tx('idleTimeout'))+
      select('activity_mode',tx('resourceMode'),[['cooperative',tx('cooperativeMode')],['strict',tx('strictMode')]])+
      select('update_chunk_bytes',tx('chunkSize'),[256,512,1024,2048,4096].map(k=>[k*1024,k+' KiB']))+'</div>'+quiet+
      plain(tx('powerNote'),'kc-caption')+(S.platform==='darwin'?plain(ct('pause_on_games')+' · '+tx('unsupported'),'kc-caption'):'')+
      row(btn('full-profile',ct('profile.full'))+btn('diag',tx('diag'))+btn('expert-open',tx('expert'))+(S.link?btn('link-forget',tx('leave'))+btn('consent-revoke',ct('consent.revoke')):''))+
      '<details data-expand="sensors"><summary>'+esc(tx('technicalDetails'))+'</summary>'+sensorsBlock()+measuredBlock()+'</details>'+msg('policy')+msg('diag')+'</details>';
  }
  function measuredBlock(){
    const w=S.worker?.metrics,b=S.budget;
    return kv([[ct('measured.tasks'),esc(w?.tasks_accepted??'—')],[ct('measured.tokens'),esc(w?.supervised_tokens??'—')],
      [ct('measured.acceptedTokens'),esc(w?.accepted_tokens??'—')],[ct('measured.bytes'),esc(fmtB(b?.bytes))],
      [tx('trafficRemaining'),esc(fmtB(b?.traffic_remaining))]]);
  }
  function sensorsBlock(){
    const s=S.governor?.sensors;
    return s?kv([[ct('ram.info'),esc(fmtB(s.ram_free_bytes)+' / '+fmtB(s.ram_total_bytes))],[ct('gpu.info'),esc(s.gpu?.name||tx('unsupported'))]]):'';
  }
  function participate(){
    const p=S.policy,w=S.worker?.metrics,l=S.link;
    const profiles='<div class="kc-profiles">'+Object.entries(presets).map(([id,percent])=>
      '<button type="button" class="kc-profile" data-act="policy-preset" data-arg="'+id+'" aria-pressed="'+(activeProfile()===id)+'"><strong>'+esc(tx(id))+'</strong>'+
      esc(percent+'% GPU · '+percent+'% CPU')+'<small>'+esc(tx(id+'Note'))+'</small></button>').join('')+'</div>';
    const network=l?(S.lab?.info?.project_id===l.project_id?tx('laboratory'):tx('network')):tx('offline');
    const linkState=l?(stale?tx('stale'):tx(l.device_state==='active'?'authorised':l.device_state==='revoked'?'revoked':'approval')):tx('offlineInfo');
    return title(tx('contribution'),tx('contributionIntro'))+
      '<div class="kc-experience-grid"><div class="kc-stack">'+panel('',participationStatus()+msg('join'),'kc-hero')+
      panel(tx('resources'),plain(tx('resourcesNote'))+profiles+advancedPolicy())+'</div><div class="kc-stack">'+
      panel(tx('stats'),scores([[tx('accepted'),w?.tasks_accepted??'—'],[tx('included'),'—'],[tx('time'),meter(S.budget?.used_gpu_ms)],[tx('energy'),'—']])+
      plain(tx('estimate',{h:S.nominal_monthly_hours??12}),'kc-caption'))+
      panel(tx('network'),'<div class="kc-network-line"><span class="kc-device-icon" aria-hidden="true">◈</span><div><strong>'+esc(network)+'</strong><small>'+esc(linkState)+'</small></div></div>')+
      '</div></div>';
  }
  function collectPolicy(){
    const p=JSON.parse(JSON.stringify(S.policy));
    body().querySelectorAll('[data-pol]').forEach(el=>{
      const k=el.dataset.pol;let v=el.type==='checkbox'?el.checked:el.type==='range'||el.type==='number'||k==='update_chunk_bytes'?Number(el.value):el.value;
      if((k==='lan_traffic_mb'||k==='wan_traffic_mb')&&!el.value)v=null;
      if(k.startsWith('quiet_hours.'))p.quiet_hours[k.slice(12)]=v;else p[k]=v;
    });
    if(p.daily_hours>(p.extended_hours?24:12))p.daily_hours=p.extended_hours?24:12;
    return p;
  }
  // ---------- consent ----------
  function openDialog(kind,heading,markup,actions=''){
    const el=dialog();
    el.dataset.kind=kind;
    el.setAttribute('aria-labelledby','kcDialogTitle');
    el.innerHTML='<div class="dialog-heading"><h2 id="kcDialogTitle">'+esc(heading)+'</h2>'+
      '<button type="button" class="icon" data-act="close-dialog" aria-label="'+esc(tx('close'))+'">×</button></div>'+
      '<div data-dialog-content>'+markup+'</div>'+(actions?row(actions):'');
    if(!el.open)el.showModal();
  }
  function clearDialog(){
    const d=dialog();
    if(d.open)d.close();
    d.replaceChildren();d.dataset.kind='';
    invitationEpoch++;
    pairing=null;
  }
  function consentDialog(){
    const c=S?.consent?.text;
    if(!c||!S.link)return;
    const name=S.lab?.info?.project_id===S.link.project_id?tx('laboratory'):tx('network');
    const percent=S.policy.gpu_target_pct+'% GPU · '+S.policy.cpu_target_pct+'% CPU · '+ct('hours.unit',{n:S.policy.daily_hours});
    openDialog('consent',tx('consentTitle'),notice(name)+plain(tx('consentText'))+
      '<div data-hardware-preview>'+hardwarePreview()+'</div>'+notice(percent)+plain(tx('consentTransfer'))+
      '<details><summary>'+esc(tx('technicalDetails'))+'</summary>'+kv([[ct('consent.endpoint'),esc(c.endpoint)],[ct('consent.fingerprint'),esc(c.fingerprint)]])+'</details>'+
      '<label class="kc-check"><input type="checkbox" id="kcAgree" autocomplete="off"> '+esc(tx('consentApprove'))+'</label>',
      btn('close-dialog',tx('cancel'))+'<button type="button" class="primary" id="kcAccept" data-act="accept-preparation" disabled>'+esc(tx('consentGo'))+'</button>');
    const agreed=dialog().querySelector('#kcAgree');
    agreed.onchange=()=>{dialog().querySelector('#kcAccept').disabled=!agreed.checked;};
    void detectHardware();
  }
  function hardwarePreview(){
    if(!hardware)return plain(tx('hardwareUnknown'),'kc-subtle');
    const gpu=hardware.gpu?.name||tx('unsupported');
    return kv([[gpu,esc(tx('ram')+' · '+fmtB(hardware.ram_bytes))],
      [tx('stageRuntime'),esc(tx(hardware.existing_runtime?'foundRuntime':'missingRuntime'))],
      [tx('stageModel'),esc(tx(hardware.existing_model?'foundModel':'missingModel'))]]);
  }
  async function detectHardware(){
    try{hardware=await call('onboarding/detect');}
    catch{return;}
    const target=dialog().querySelector('[data-hardware-preview]');
    if(target)target.innerHTML=hardwarePreview();
  }
  function inviteDialog(initial=''){
    openDialog('invitation',tx('invitationTitle'),plain(tx('invitationInfo'))+
      '<label class="kc-field">'+esc(tx('invitationLabel'))+'<textarea id="kcInvitation" rows="3" autocomplete="off" spellcheck="false" placeholder="kvalah-compute://pair?…">'+esc(initial)+'</textarea></label>'+
      (S.link?'<label class="kc-check"><input type="checkbox" id="kcReplace"> '+esc(tx('replace'))+'</label>':'')+
      '<p data-dialog-error role="alert"></p>',btn('close-dialog',tx('cancel'))+btn('submit-invitation',tx('next'),{primary:true}));
    dialog().querySelector('#kcInvitation').focus();
  }
  const dialogError=message=>{
    const error=dialog().querySelector('[data-dialog-error]');
    if(error)error.textContent=message;
  };
  // ---------- Devices ----------
  function linkBlock(){
    const l=S.link;
    if(!l)return '<p class="kc-note">'+esc(ct('devices.noLink'))+'</p>';
    return kv([[ct('consent.project'),esc(l.project_id)],[ct('consent.endpoint'),esc(l.endpoint)],[ct('consent.fingerprint'),'<code>'+esc(l.fingerprint)+'</code>'],[ct('devices.state'),'<span class="badge'+(l.device_state==='active'?' ok':'')+'">'+esc(l.device_state)+'</span>']]);
  }
  function deviceRows(){
    const lab=S.lab;if(!lab?.devices?.length)return '<p class="kc-note">'+esc(ct('lab.noDevices'))+'</p>';
    return '<ul class="dev-list">'+lab.devices.map(d=>{
      const c=d.capabilities||{},m=d.metrics||{},s=d.status||{};
      const acts=(d.state==='pending'?btn('dev-approve',ct('dev.approve'),{arg:d.id}):'')+(d.state!=='revoked'?btn('dev-drain',ct(d.state==='draining'?'dev.undrain':'dev.drain'),{arg:d.id+'|'+(d.state!=='draining')})+btn('dev-rename',ct('dev.rename'),{arg:d.id})+btn('dev-revoke',ct('dev.revoke'),{arg:d.id}):'');
      return '<li><span><strong>'+esc(d.alias)+'</strong>'+(d.id===lab.self_device?' <span class="badge">'+esc(ct('dev.self'))+'</span>':'')+' <span class="badge'+(d.state==='active'?' ok':'')+'">'+esc(d.state)+'</span> <span class="badge'+(d.online?' ok':'')+'">'+esc(ct(d.online?'dev.online':'dev.offline'))+'</span>'
        +'<small>'+esc(d.id)+' · '+esc(d.key_fingerprint)+(d.duplicate_alias?' · '+ct('dev.dup'):'')+'</small>'
        +'<small>'+esc([c.backend,c.device_name,c.memory_total_bytes?fmtB(c.memory_total_bytes):null,c.runtime_version].filter(Boolean).join(' · '))+'</small>'
        +'<small>'+esc([d.heartbeat_age_ms!=null?ct('dev.hb',{s:Math.round(d.heartbeat_age_ms/1000)}):null,s.state?s.state+(s.pause_reason?' ('+reason(s.pause_reason)+')':''):null,ct('measured.tasks')+': '+(d.accepted_count||0),m.tokens_per_s?m.tokens_per_s.toFixed(1)+' tok/s':null,m.step_s?m.step_s.toFixed(2)+' s/step':null].filter(Boolean).join(' · '))+'</small>'
        +'<small>'+esc([m.resident_model?tx('modelResident'):null,m.total_chunks?tx('sentChunks')+' '+m.uploaded_chunks+'/'+m.total_chunks:null,
          m.traffic_remaining!=null?tx('trafficRemaining')+' '+fmtB(m.traffic_remaining):null].filter(Boolean).join(' · '))+'</small></span><span class="kc-actions">'+acts+'</span></li>';
    }).join('')+'</ul>';
  }
  function labInfo(){
    const i=S.lab?.info;
    if(!i?.running)return '<p class="kc-note">'+esc(ct('lab.stopped'))+'</p>';
    return '<p><span class="badge ok">'+esc(ct('lab.running',{e:i.endpoint}))+'</span></p>'+kv([[ct('consent.fingerprint'),'<code>'+esc(i.fingerprint)+'</code>'],[ct('consent.project'),esc(i.project_id||'')]]);
  }
  function expertDevices(){
    const addrs=(S.lab_addresses||[]).map(a=>a.address||a).concat(['127.0.0.1']),bind=S.lab?.info?.bind_ip||addrs[0];
    const id=S.identity;
    let h='<div class="kc-grid">'+card(ct('devices.connect'),L('link',linkBlock)+(S.link?'<div class="kc-actions">'+btn('link-refresh',ct('devices.refresh'))+btn('link-forget',ct('devices.forget'))+'</div>':
      '<label class="kc-field wide"><span>'+esc(ct('devices.pairing'))+'</span><textarea id="kcPairing" rows="3" spellcheck="false"></textarea></label>'+field('kcAlias',ct('devices.alias'),'')+btn('pair',ct('devices.connectBtn'),{primary:true}))+msg('pair'))
      +card(ct('devices.identity'),id?kv([[ct('devices.id'),'<code>'+esc(id.device_id)+'</code>'],[ct('devices.key'),'<code>'+esc(id.key_fingerprint)+'</code>'],[ct('devices.store'),esc(id.secret_store)]]):'<p class="kc-note">'+esc(ct('devices.noIdentity'))+'</p>')+'</div>';
    const running=S.lab?.info?.running;
    h+=card(ct('lab.local'),'<p class="kc-note">'+esc(ct('lab.local.note'))+'</p>'+L('labinfo',labInfo)
      +(running?'<div class="kc-actions">'+btn('lab-stop',ct('lab.stop'))+btn('lab-pairing',ct('lab.newCode'),{primary:true})+(S.link?'':btn('lab-join',ct('lab.joinSelf')))+'</div>'
        +(pairing?'<p class="kc-note">'+esc(ct('lab.code'))+'</p><div class="kc-code"><code id="kcCode">'+esc(pairing.pairing)+'</code>'+btn('copy-code',ct('copy'))+'</div>':'')
      :'<div class="kc-row"><label class="kc-field"><span>'+esc(ct('lab.bind'))+'</span><select id="kcBind">'+addrs.map(a=>'<option'+(a===bind?' selected':'')+'>'+esc(a)+'</option>').join('')+'</select></label><label class="kc-field narrow"><span>'+esc(ct('lab.port'))+'</span><input id="kcPort" type="number" min="1024" max="65535" value="'+esc(S.lab?.info?.port||8765)+'"></label>'+btn('lab-start',ct('lab.start'),{primary:true})+'</div>')
      +msg('lab')+(S.lab?'<h4>'+esc(ct('lab.devices'))+'</h4>'+L('devrows',deviceRows):''));
    return h;
  }
  // ---------- Lab ----------
  function expertExperiment(source){
    if(!S.lab?.info?.running&&!S.lab?.experiments?.length)return card('','<p>'+esc(ct('lab.need'))+'</p>'+btn('goto',ct('tab.devices'),{arg:'devices'}));
    const l=S.lab,prof=S.profile.id,prior=source?.config;
    const variants=l.variants.filter(v=>v.profile_id===prof);
    let h='<div class="kc-grid">'+card(ct('lab.models'),(variants.length?'<ul class="dev-list">'+variants.map(v=>'<li><span><strong>'+esc(v.variant_id)+'</strong><small>'+esc(short(v.files_digest))+'</small></span><span class="badge'+(v.provenance!=='unverified'?' ok':'')+'">'+esc(trust(v.provenance))+'</span></li>').join('')+'</ul>':'<p class="kc-note">'+esc(ct('lab.noModels'))+'</p>')
      +btn('register-model',ct('lab.registerModel'),{disabled:!S.model?.architecture_ok})+reportedVariants(variants)+msg('model'))
      +card(ct('lab.datasets'),(l.datasets.length?'<ul class="dev-list">'+l.datasets.map(d=>'<li><span><strong>'+esc(d.id)+'</strong><small>'+esc(Object.entries(d.split_counts||{}).map(([k,v])=>k+': '+v).join(' · '))+' · '+esc(d.license||'')+' · max '+esc(d.max_length)+'</small></span>'+(d.synthetic?'<span class="badge">'+esc(ct('lab.synthetic'))+'</span>':'')+'</li>').join('')+'</ul>':'<p class="kc-note">'+esc(ct('lab.noDatasets'))+'</p>')
        +'<details><summary>'+esc(ct('lab.import'))+'</summary>'+field('kcDsFile',ct('lab.file'),'',{browse:'file',wide:true})+'<div class="kc-row">'+field('kcDsId',ct('lab.dsid'),'')+field('kcDsRev',ct('lab.rev'),'1')+'</div>'+btn('import-dataset',ct('lab.import'))+'</details>'
        +btn('import-fixture',ct('lab.importFixture'))+msg('dataset'))+'</div>';
    const pv=S.profile.variants||[];
    const vlist=pv.length?pv:variants.map(v=>v.variant_id);
    h+=card(ct('lab.new'),'<p class="kc-note">'+esc(ct('lab.new.note'))+'</p><div class="kc-form">'
      +field('kcName',ct('lab.name'),'',{wide:true})
      +(source?'<input type="hidden" id="kcInitialCheckpoint" value="'+esc(source.id+'|'+source.checkpoint.sha256)+'">'+plain(tx('continuesFrom',{run:source.run_id,round:source.checkpoint.round,hash:short(source.checkpoint.sha256)}),'kc-caption'):'')
      +'<label class="kc-field"><span>'+esc(ct('lab.preset'))+'</span><select id="kcPreset">'+['smoke','pilot','research'].map(x=>'<option value="'+x+'">'+esc(ct('preset.'+x))+'</option>').join('')+'</select></label>'
      +'<label class="kc-field"><span>'+esc(ct('lab.dataset'))+'</span><select id="kcDataset">'+l.datasets.map(d=>'<option'+(prior?.dataset_id===d.id?' selected':'')+'>'+esc(d.id)+'</option>').join('')+'</select></label>'
      +'<fieldset class="kc-field wide"><legend>'+esc(ct('lab.variants'))+'</legend>'+vlist.map(v=>'<label class="kc-check"><input type="checkbox" class="kcVar" id="kcVar_'+esc(v)+'" value="'+esc(v)+'"'+((prior?prior.variants.includes(v):variants.some(x=>x.variant_id===v))?' checked':'')+'> '+esc(v)+'</label>').join('')+'</fieldset>'
      +field('kcRounds',ct('lab.rounds'),'',{type:'number',placeholder:'2'})+field('kcSteps',ct('lab.steps'),'',{type:'number',placeholder:'3'})
      +'<label class="kc-field"><span>'+esc(ct('lab.optimizer'))+'</span><select id="kcOpt"><option>sgd</option><option>adamw</option></select></label>'+field('kcLr',ct('lab.lr'),'',{placeholder:'0.001'})
      +'<label class="kc-field"><span>'+esc(ct('lab.maxlen'))+'</span><select id="kcMaxLen"><option>256</option><option value="512"'+(S.preflight?.max_length!==512?' disabled':'')+(prior?.max_length===512?' selected':'')+'>512</option></select></label>'
      +'<label class="kc-field"><span>'+esc(ct('lab.quorum'))+'</span><select id="kcQMode"><option value="">'+esc(ct('lab.preset'))+'</option><option value="all">'+esc(ct('quorum.all'))+'</option><option value="fault_tolerant">'+esc(ct('quorum.ft'))+'</option></select></label>'
      +field('kcQMin',ct('lab.qmin'),'',{type:'number'})+field('kcQTarget',ct('lab.qtarget'),'',{type:'number',placeholder:'3'})+field('kcDeadline',ct('lab.deadline'),'',{type:'number',placeholder:'600'})+field('kcSeed',ct('lab.seed'),prior?.seed??'',{type:'number',placeholder:'20261126'})+field('kcEvalEvery',ct('lab.evalEvery'),'',{type:'number'})
      +'<label class="kc-check wide"><input type="checkbox" id="kcResearch"> '+esc(ct('lab.research'))+'</label></div>'
      +'<div class="kc-actions">'+btn('dry-run',ct('lab.dryRun'))+btn('create',ct('lab.create'),{primary:true,disabled:!plan})+'</div><div data-plan-summary></div>');
    h+=card(ct('lab.experiments'),L('exps',expList));
    return h;
  }
  // Variants reported by approved devices that are not registered here yet (or registered with another digest).
  function reportedVariants(registered){
    const out=[];
    for(const d of (S.lab?.devices||[]))if(d.state==='active')for(const v of (d.capabilities?.variants||[])){
      if(v.profile_id!==S.profile.id||!v.files_digest)continue;
      const r=registered.find(x=>x.variant_id===v.variant_id);if(r&&r.files_digest===v.files_digest)continue;
      if(out.some(o=>o.v.variant_id===v.variant_id&&o.v.files_digest===v.files_digest))continue;out.push({d,v,conflict:!!r});
    }
    if(!out.length)return '';
    return '<h4>'+esc(ct('lab.reported'))+'</h4><ul class="dev-list">'+out.map(o=>'<li><span><strong>'+esc(o.v.variant_id)+'</strong> · '+esc(o.d.alias)+'<small>'+esc(short(o.v.files_digest))+(o.conflict?' · '+esc(ct('lab.digestDiffers')):'')+'</small></span>'+btn('register-device-model',ct('lab.registerReported'),{arg:o.d.id+'|'+o.v.variant_id})+'</li>').join('')+'</ul>';
  }
  function expList(){
    const ex=S.lab?.experiments||[];if(!ex.length)return '<p class="kc-note">'+esc(ct('lab.noExperiments'))+'</p>';
    return '<ul class="dev-list nodes">'+ex.map(e=>{
      const a=[];
      if(e.state==='CREATED')a.push(btn('exp-start',ct('exp.start'),{arg:e.id,primary:true}));
      if(e.state==='RUNNING')a.push(btn('exp-pause',ct('exp.pause'),{arg:e.id}),btn('exp-finish',ct('exp.finish'),{arg:e.id}));
      if(['PAUSED','BLOCKED'].includes(e.state))a.push(btn('exp-resume',ct('exp.resume'),{arg:e.id}));
      if(!['COMPLETED','CANCELLED'].includes(e.state))a.push(btn('exp-cancel',ct('exp.cancel'),{arg:e.id}));
      if(e.checkpoint)a.push(btn('exp-continue',tx('continueAdapter'),{arg:e.id}));
      a.push(btn('exp-report',ct('exp.report'),{arg:e.id}),btn('exp-peft',ct('exp.peft'),{arg:e.id,disabled:!e.committed_rounds}),btn('exp-monitor',ct('tab.monitor'),{arg:e.id}));
      return '<li><span><strong>'+esc(e.name)+'</strong> <span class="badge'+(e.state==='COMPLETED'?' ok':'')+'">'+esc(stateText(e.state))+'</span><small>'+esc(e.run_id)+' · '+esc(e.config.preset==='smoke'?tx('smoke'):ct('preset.'+e.config.preset))+' · '+esc(e.committed_rounds)+'/'+esc(e.target_rounds)+' · '+esc(when(e.created_at))+'</small></span><span class="kc-actions">'+a.join('')+'</span></li>';
    }).join('')+'</ul><label class="kc-check"><input type="checkbox" id="kcWeights"> '+esc(ct('exp.weights'))+'</label>'+msg('exp');
  }
  // ---------- Monitoring ----------
  function chart(points){
    if(points.length<2)return '';
    const W=520,H=140,pad=28,xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
    const x0=Math.min(...xs),x1=Math.max(...xs)||1,y0=Math.min(...ys),y1=Math.max(...ys);
    const X=x=>pad+(x1===x0?0.5:(x-x0)/(x1-x0))*(W-2*pad),Y=y=>H-pad-(y1===y0?0.5:(y-y0)/(y1-y0))*(H-2*pad);
    return '<svg class="kc-chart" viewBox="0 0 '+W+' '+H+'" role="img"><polyline points="'+points.map(p=>X(p[0]).toFixed(1)+','+Y(p[1]).toFixed(1)).join(' ')+'"/>'+points.map(p=>'<circle cx="'+X(p[0]).toFixed(1)+'" cy="'+Y(p[1]).toFixed(1)+'" r="3"><title>r'+p[0]+': '+p[1].toFixed(6)+'</title></circle>').join('')
      +'<text x="'+pad+'" y="14">'+y1.toFixed(4)+'</text><text x="'+pad+'" y="'+(H-6)+'">'+y0.toFixed(4)+'</text></svg>';
  }
  function monitorLive(){
    if(!expData)return '<p class="kc-note">'+esc(ct('mon.none'))+'</p>';
    const e=expData.status,r=e.round,rounds=expData.rounds||[];
    let h=kv([[ct('mon.rounds'),esc(e.committed_rounds+' / '+e.target_rounds)],[ct('col.state'),'<span class="badge">'+esc(stateText(e.state))+'</span>'],
      r?[ct('mon.round'),esc('#'+r.idx+' · attempt '+r.attempt+' · '+stateText(r.state))]:null,r?[ct('mon.accepted'),esc(r.accepted+' / '+r.min_quorum+'–'+r.target+' (leased '+r.leased+')')]:null,
      r&&e.state==='RUNNING'?[ct('mon.deadline'),esc(fmtMs(r.remaining_ms))]:null,['config','<code>'+esc(short(e.config_hash))+'</code> · frozen A <code>'+esc(short(e.frozen_a_hash))+'</code>']]);
    const bl=e.blocker||r?.blocker;if(bl)h+='<p class="kc-msg bad">'+esc(ct('mon.blocker',{r:friendly(bl.reason||bl.code),a:r?.accepted??0,m:r?.min_quorum??'?'}))+'</p>';
    if(r?.slots?.length)h+='<h4>'+esc(ct('mon.slots'))+'</h4><ul class="dev-list">'+r.slots.map(s=>{const dev=(S.lab?.devices||[]).find(d=>d.id===s.device_id);const pr=s.progress||{};return '<li><span>slot '+s.slot+' · <strong>'+esc(dev?.alias||s.device_id||ct('none'))+'</strong><small>'+esc(({open:tx('checking'),leased:tx('inProgress'),accepted:tx('accepted'),void:tx('cancelled')})[s.state]||tx('checking'))+(pr.step!=null?' · '+pr.step+'/'+(pr.steps??'?'):'')+'</small></span>'+(pr.step!=null&&pr.steps?'<progress max="'+pr.steps+'" value="'+pr.step+'"></progress>':'')+'</li>';}).join('')+'</ul>';
    const ev=e.eval||{},pts=Object.entries(ev.rounds||{}).filter(([,v])=>Number.isFinite(v.nll)).map(([k,v])=>[Number(k),v.nll]).sort((a,b)=>a[0]-b[0]);
    h+='<h4>'+esc(ct('mon.eval'))+'</h4>'+(pts.length?chart(pts)+'<table class="kc-table"><tr><th>'+esc(ct('col.round'))+'</th><th>NLL</th><th>PPL</th><th>tokens</th><th>acc</th></tr>'+Object.entries(ev.rounds).map(([k,v])=>'<tr><td>'+esc(k)+'</td><td>'+esc(v.nll!=null?v.nll.toFixed(6):v.status)+'</td><td>'+esc(v.perplexity!=null?v.perplexity.toFixed(3):'')+'</td><td>'+esc(v.tokens??'')+'</td><td>'+esc(v.token_accuracy!=null?(v.token_accuracy*100).toFixed(1)+'%':'')+'</td></tr>').join('')+'</table>':'<p class="kc-note">'+esc(ev.status||ct('mon.noEval'))+'</p>')
      +(ev.gate?'<p class="kc-msg'+(ev.gate.passed?'':' bad')+'">'+esc(ct('mon.gate',{r:ct(ev.gate.passed?'gate.pass':'gate.fail')+' ('+(ev.gate.rel_change*100).toFixed(2)+'%)'}))+'</p>':'');
    h+='<h4>'+esc(ct('mon.table'))+'</h4><div class="kc-scroll"><table class="kc-table"><tr><th>'+['col.round','col.state','col.base','col.updates','col.tokens','col.excluded','col.duration','col.ckpt'].map(k=>esc(ct(k))).join('</th><th>')+'</th></tr>'
      +rounds.map(x=>{const acc=x.accepted||[],exc=x.excluded||[];return '<tr><td>'+x.idx+'.'+x.attempt+'</td><td>'+esc(stateText(x.state))+'</td><td><code>'+esc(short(x.parent_hash))+'</code></td><td>'+acc.length+'</td><td>'+esc(acc.map(a=>a.weight??a.tokens).join(' + '))+'</td><td>'+esc(exc.map(a=>'slot '+a.slot+': '+a.reason).join('; '))+'</td><td>'+esc(fmtMs(x.duration_ms))+(x.aggregation_ms!=null?' (agg '+x.aggregation_ms+' ms)':'')+'</td><td><code>'+esc(short(x.checkpoint_hash))+'</code></td></tr>';}).join('')+'</table></div>';
    return h;
  }
  function eventsBlock(){
    const loc=(S.events||[]).slice(-30).reverse(),co=coordEvents.slice(-30).reverse();
    const li=e=>'<li class="lvl-'+esc(e.level)+'"><time>'+esc(new Date(e.ts).toLocaleTimeString(lang()))+'</time> <code>'+esc(e.code)+'</code> '+esc(JSON.stringify(e.details||{}).slice(0,160))+'</li>';
    return '<div class="kc-grid"><div><h4>'+esc(ct('mon.local'))+'</h4><ul class="kc-events">'+loc.map(li).join('')+'</ul></div><div><h4>'+esc(ct('lab.local'))+'</h4><ul class="kc-events">'+co.map(li).join('')+'</ul></div></div>';
  }
  function monitor(){
    const ex=S.lab?.experiments||[];
    if(!expData)return panel(tx('experiments'),plain(tx('checking')),'kc-hero');
    const e=expData.status,r=e.round,failed=expData.rounds.filter(x=>['FAILED','BLOCKED'].includes(x.state));
    const committed=expData.rounds.filter(x=>x.state==='COMMITTED');
    const finished=e.state==='COMPLETED';
    const picker=ex.length>1?'<label class="kc-field"><span>'+esc(ct('mon.choose'))+'</span><select id="kcExpSel" data-act-change="select-exp">'+
      ex.map(x=>'<option value="'+esc(x.id)+'"'+(x.id===selExp?' selected':'')+'>'+esc(x.name+' · '+stateText(x.state))+'</option>').join('')+'</select></label>':'';
    const evals=Object.entries(e.eval?.rounds||{});
    const metrics=v=>'NLL '+v.nll.toFixed(4)+' · PPL '+v.perplexity.toFixed(2)+' · '+(v.token_accuracy*100).toFixed(1)+'% · '+v.tokens;
    const summary=evals.map(([round,v])=>'<div class="kc-device-row"><div class="kc-device-summary"><strong>'+esc(ct('col.round')+' '+round)+'</strong>'+
      '<small>'+esc(v.backend||'—')+' · '+esc(trust(v.provenance))+'</small></div>'+
      (v.status==='DONE'?'<strong>'+esc(metrics(v))+'</strong>':pill(tx('noMeasure'),'warn'))+'</div>').join('');
    const test=e.eval?.test, dataset=S.lab?.datasets.find(d=>d.id===e.config.dataset_id),testReady=!!(dataset?.group_audited&&dataset.split_counts?.test);
    const testPanel=finished?panel(tx('testEvaluation'),test?.status==='DONE'?
      plain(metrics(test))+plain([test.variant_id,trust(test.provenance),tx('testCheckpoint',{round:test.round,hash:short(test.checkpoint)})].filter(Boolean).join(' · '),'kc-caption'):
      plain(tx(testReady?'testEvaluationInfo':'testNeedsAudit'))+
      (test?notice(tx('testNotRun'),'warn'):'')+
      (testReady?row(btn('exp-test',tx(e.test_pending?'checking':'runTest'),{arg:e.id,disabled:e.test_pending})):'')):'';
    const participants=finished?(committed.at(-1)?.accepted||[]).map(item=>({device_id:item.device_id,state:'accepted'})):(r?.slots||[]);
    const slots=participants.map(item=>{
      const device=S.lab?.devices.find(d=>d.id===item.device_id);
      const label=item.state==='accepted'?tx('accepted'):item.progress?.step!=null?item.progress.step+' / '+item.progress.steps:tx('checking');
      return '<div class="kc-device-row"><span class="kc-device-icon" aria-hidden="true">▣</span><div class="kc-device-summary"><strong>'+esc(device?.alias||ct('none'))+'</strong></div>'+
        pill(label,item.state==='accepted'?'good':'warn')+'</div>';
    }).join('');
    const progress=finished?[[tx('acceptedUpdates'),committed.reduce((n,x)=>n+(x.accepted?.length||0),0)]]:
      [[ct('mon.accepted'),r?r.accepted+' / '+r.target:'—'],[ct('mon.round'),r?(r.idx+1)+' / '+e.target_rounds:'—'],[ct('mon.deadline'),e.state==='RUNNING'?fmtMs(r?.remaining_ms):'—']];
    return '<div class="kc-stack">'+panel('',picker+pill(stateText(e.state),finished?'good':e.state==='BLOCKED'?'warn':'')+
      h2(e.name)+plain(e.run_id,'kc-caption')+
      (e.config.initial_checkpoint?plain(tx('continuesFrom',{run:e.config.initial_checkpoint.experiment_id,round:e.config.initial_checkpoint.source_round,hash:short(e.config.initial_checkpoint.sha256)}),'kc-caption'):'')+
      scores([[tx('completedRounds'),e.committed_rounds+' / '+e.target_rounds],...progress])+
      '<progress class="kc-monitor-progress" aria-label="'+esc(tx('completedRounds'))+'" max="'+e.target_rounds+'" value="'+e.committed_rounds+'"></progress>'+
      (e.blocker?.reason?notice(friendly(e.blocker.reason),'warn'):'')+
      row(btn('lab-nav',tx('experiments'),{arg:'experiments'})+btn('rounds-json',ct('mon.exportJson'))+
        (e.state==='RUNNING'?btn('exp-pause',ct('exp.pause'),{arg:e.id})+btn('exp-finish',ct('exp.finish'),{arg:e.id})+btn('exp-cancel',ct('exp.cancel'),{arg:e.id}):'')+
        (['PAUSED','BLOCKED'].includes(e.state)?btn('exp-resume',ct('exp.resume'),{arg:e.id,primary:true}):'')+
        (e.state==='COMPLETED'?btn('exp-report',ct('exp.report'),{arg:e.id,primary:true})+btn('exp-peft',ct('exp.peft'),{arg:e.id}):'')+
        (e.checkpoint?btn('exp-continue',tx('continueAdapter'),{arg:e.id}):''))+
      (e.state==='COMPLETED'?'<label class="kc-check"><input id="kcWeights" type="checkbox">'+esc(ct('exp.weights'))+'</label>':'')+msg('exp'),'kc-hero')+
      '<div class="kc-experience-grid">'+panel(tx(finished?'lastRoundDevices':'devices'),slots||plain(tx('noAssignments')))+panel(tx('validationEvaluation'),summary||plain(tx('noMeasure')))+testPanel+'</div>'+
      (failed.length?panel(tx('blocked'),failed.map(f=>plain(ct('col.round')+' '+(f.idx+1)+' · '+friendly(f.blocker?.reason))).join('')):'')+
      panel(tx('technicalDetails'),'<details data-expand="round-ledger"><summary>'+esc(ct('mon.table'))+'</summary>'+monitorLive()+'</details>'+
        '<details data-expand="round-events"><summary>'+esc(ct('mon.events'))+'</summary>'+eventsBlock()+'</details>')+'</div>';
  }
  // ---------- Models & data ----------
  function expertData(){
    const rt=S.runtime,m=S.model,pf=S.preflight,pr=rt?.probe;
    const backends=S.test_mode?['cuda','mlx','torch-cpu-test','mock']:['cuda','mlx'];
    const defB=rt?.backend||(S.platform==='darwin'?'mlx':'cuda');
    let h=card(ct('data.profile'),'<label class="kc-field"><select id="kcProfile" data-act-change="profile">'+S.profile.available.map(p=>'<option value="'+esc(p)+'"'+(p===S.profile.id?' selected':'')+'>'+esc(p)+'</option>').join('')+'</select></label>');
    h+='<div class="kc-grid">'+card(ct('data.runtime'),'<p class="kc-note">'+esc(ct('data.runtime.note'))+'</p>'+field('kcPython',ct('data.python'),rt?.python||'',{browse:'file',wide:true,placeholder:S.platform==='win32'?'C:\\kvalah-compute\\.venv\\Scripts\\python.exe':'~/kvalah-compute/.venv/bin/python'})
      +'<label class="kc-field"><span>'+esc(ct('data.backend'))+'</span><select id="kcBackend">'+backends.map(b=>'<option'+(b===defB?' selected':'')+'>'+b+'</option>').join('')+'</select></label>'+btn('runtime',ct('data.check'),{primary:true})
      +(pr?(pr.backend_ok?'<p class="kc-msg">'+esc(ct('data.ok'))+'</p>':'<p class="kc-msg bad">'+esc(ct('data.fail',{e:pr.backend_error?.message||'?'}))+'</p>')+kv([['python',esc(pr.python)],pr.torch?['torch',esc(pr.torch+(pr.cuda?' · CUDA '+pr.cuda:''))]:null,pr.bitsandbytes?['bitsandbytes',esc(pr.bitsandbytes)]:null,pr.mlx?['mlx',esc(pr.mlx+(pr.mlx_vlm?' · mlx-vlm '+pr.mlx_vlm:''))]:null,pr.gpu?['GPU',esc(pr.gpu+(pr.memory_total_bytes?' · '+fmtB(pr.memory_total_bytes):''))]:null,pr.transformers?['transformers',esc(pr.transformers)]:null]):'')+msg('runtime'))
      +card(ct('data.model'),field('kcModelDir',ct('data.modelDir'),m?.model_dir||'',{browse:'folder',wide:true})
        +'<label class="kc-field"><span>'+esc(ct('data.variant'))+'</span><select id="kcVariant">'+(S.profile.runtime_variants||[]).map(v=>'<option'+(m?.variant_id===v?' selected':'')+'>'+esc(v)+'</option>').join('')+'</select></label>'
        +btn('model',ct('data.verify'),{primary:true,disabled:!rt?.python})
        +(m?kv([[ct('data.digest'),'<code>'+esc(short(m.files_digest))+'</code> · '+esc(m.files)+' files · '+esc(fmtB(m.total_bytes))],[ct('data.arch'),'<span class="badge'+(m.architecture_ok?' ok':'')+'">'+esc(ct(m.architecture_ok?'data.archOk':'data.archBad'))+'</span> '+esc([m.architecture?.model_type,m.architecture?.num_hidden_layers+' layers',m.architecture?.hidden_size].join(' · '))],
          m.pinned?[ct('data.pinned'),esc(m.pinned.source_repo)+' @ <code>'+esc(short(m.pinned.source_revision))+'</code>']:null,[ct('data.prov'),'<span class="badge'+(m.provenance==='verified'?' ok':'')+'">'+esc(ct(m.provenance==='verified'?'prov.verified':'prov.unverified'))+'</span>'+(m.provenance_check?' '+esc(m.provenance_check.mismatches.length+' mismatches'):'')]])
          +'<div class="kc-actions">'+(m.pinned?btn('provenance',ct('data.checkHub')):'')+'<select id="kcPreflightLength" aria-label="'+esc(ct('data.context'))+'"><option>256</option><option'+(pf?.max_length===512?' selected':'')+'>512</option></select>'+btn('preflight',ct('data.preflight'),{disabled:!m.architecture_ok})+'</div>':'')
        +(pf?(pf.ok?'<p class="kc-msg">'+esc(ct('data.preflightOk',{l:pf.model_load_s?.toFixed?.(1)??'?',s:pf.step_s?.toFixed?.(2)??'?'}))+((pf.peak_reserved_bytes||pf.mlx_peak_bytes)?' · peak '+esc(fmtB(pf.peak_reserved_bytes||pf.mlx_peak_bytes)):'')+'</p>':'<p class="kc-msg bad">'+esc(ct('data.preflightFail',{e:pf.error?.message||'?'}))+'</p>'):'')+msg('model'))+'</div>';
    const lg=S.legacy;
    h+='<div class="kc-grid">'+card(ct('data.legacy'),field('kcLegacy','ZIP','',{browse:'file',wide:true,placeholder:'experiment-v01.zip'})+btn('legacy',ct('data.legacyBtn'))
        +(lg?'<p class="kc-msg'+(lg.verified_all?'':' bad')+'">'+esc(lg.verified_all?ct('data.legacyOk',{n:lg.aggregation?.length??0}):ct('data.legacyBad'))+'</p>'+(lg.notes?'<ul class="kc-facts">'+[].concat(lg.notes).slice(0,6).map(n=>'<li>'+esc(typeof n==='string'?n:JSON.stringify(n))+'</li>').join('')+'</ul>':''):'')+msg('legacy'))
      +card(ct('data.verifyReport'),field('kcReport','ZIP','',{browse:'file',wide:true,placeholder:'kvalah-compute-report-*.zip'})+btn('verify-report',ct('data.verifyBtn'))+msg('verify'))+'</div>';
    h+='<p class="kc-note">'+esc(ct('data.privacy'))+'</p>';
    return h;
  }
  function readyPill(reason){
    if(!reason)return pill(tx('deviceReady'),'good');
    return pill(reason==='pending_approval'?tx('approval'):reason==='revoked'?tx('revoked'):
      reason==='device_offline'?tx('deviceOffline'):tx('temporary'),reason==='revoked'?'bad':'warn');
  }
  function labDevices(){
    const devices=S.lab?.devices||[],readiness=S.lab?.smoke?.devices||[];
    return panel(tx('devices'),(!devices.length?plain(tx('deviceEmpty')):devices.map(d=>{
      const ready=readiness.find(x=>x.id===d.id),c=d.capabilities||{};
      return '<article class="kc-device-row"><span class="kc-device-icon" aria-hidden="true">▣</span><div class="kc-device-summary"><strong>'+esc(d.alias)+'</strong>'+
        '<small>'+esc([d.id===S.lab.self_device?ct('dev.self'):tx('workerRole'),c.device_name,d.online?tx('connected'):tx('deviceOffline')].filter(Boolean).join(' · '))+'</small>'+
        (ready?.reason?'<small>'+esc(friendly(ready.reason))+'</small>':'')+'</div>'+
        readyPill(ready?.reason||(!d.online?'device_offline':d.state==='pending'?'pending_approval':null))+
        (d.state==='pending'?btn('show-approval',ct('dev.approve'),{arg:d.id,primary:true}):'')+
        '<details data-expand="device-'+esc(d.id)+'"><summary>'+esc(tx('deviceDetails'))+'</summary>'+
        kv([[tx('deviceDetails'),esc(d.key_fingerprint)],[tx('stageRuntime'),esc(c.backend||tx('noMeasure'))],[tx('stageModel'),esc(c.variants?.[0]?.variant_id||tx('noMeasure'))]])+
        (d.state!=='revoked'?row(btn('dev-rename',ct('dev.rename'),{arg:d.id})+btn('dev-drain',ct(d.status?.drain?'dev.undrain':'dev.drain'),{arg:d.id+'|'+!d.status?.drain})+
           btn('dev-revoke',ct('dev.revoke'),{arg:d.id})):'')+'</details></article>';
    }).join(''))+msg('lab'));
  }
  function laboratory(){
    const l=S.lab,ready=l?.smoke,online=l?.info?.running&&!stale;
    const n=stale?0:ready?.devices?.filter(d=>!d.reason).length||0;
    const nav='<nav class="kc-lab-tabs" aria-label="'+esc(tx('nav'))+'">'+[['overview','overview'],['devices','devices'],['experiments','experiments'],['data','models'],['fusion','Expert Fusion']].map(([id,key])=>{
      const selected=tab===id||(tab==='monitor'&&id==='experiments');
      return '<button type="button" data-act="lab-nav" data-arg="'+id+'"'+(selected?' aria-current="page"':'')+'>'+esc(id==='fusion'?key:tx(key))+'</button>';
    }).join('')+'</nav>';
    if(tab==='fusion')return nav+renderFusion();
    const top=title(tx('laboratory'),tx('labIntro'),online?btn('new-experiment',tx('newExperiment'),{primary:true}):btn('auto-lab',tx('createNetwork'),{primary:true}))+nav;
    const networkControls=row(btn('lab-pairing',tx('inviteDevice'),{primary:tab==='devices'})+
      (!S.link?btn('lab-join-ux',tx('joinSelf')):'')+btn('lab-stop',ct('lab.stop')));
    if(tab==='devices')return top+panel(tx('network'),pill(online?tx('networkOn'):tx('networkStopped'),online?'good':'')+
      (online?networkControls:row(btn('auto-lab',tx('createNetwork'),{primary:true})))+'<details data-expand="network"><summary>'+esc(tx('technicalDetails'))+'</summary>'+
      (S.feature_enabled?expertDevices():'')+'</details>')+labDevices();
    if(tab==='data')return top+labModels();
    if(tab==='monitor')return top+monitor();
    if(tab==='experiments')return top+panel(tx('experiments'),(l?.experiments?.length?expList():plain(tx('emptyExperiments')))+msg('exp'));
    if(!online)return top+panel('',h2(tx('createNetworkTitle'))+plain(tx('createNetworkInfo'))+
      row(btn('auto-lab',tx('createNetwork'),{primary:true}))+msg('lab'),'kc-hero');
    return top+'<div class="kc-experience-grid"><div class="kc-stack">'+panel('',pill(tx('networkOn'),'good')+
      h2(tx(ready?.ready?'labReady':'labNotReady'))+plain(tx('labReadiness',{ready:n,target:3}))+
      row(btn('show-smoke',tx('smoke'),{primary:true})+btn('lab-pairing',tx('inviteDevice'))+(!S.link?btn('lab-join-ux',tx('joinSelf')):''))+
      (ready?.reason?plain(friendly(ready.reason),'kc-caption'):'')+msg('lab'),'kc-hero')+labDevices()+'</div><div class="kc-stack">'+
      panel(tx('networkStats'),scores([[tx('deviceReady'),n+' / 3'],[tx('experiments'),l.experiments.length],
      [tx('completedRounds'),l.experiments.reduce((a,r)=>a+r.committed_rounds,0)],[tx('devices'),l.devices.length]]))+'</div></div>';
  }
  function renderFusion(){
    if(!S.expert_fusion_enabled)return panel('Expert Fusion',plain(fx('Исследовательская лаборатория для экспертов, маршрутизации и циклических слоёв.','A research lab for experts, routing and looped layers.'))+
      row(S.feature_enabled?btn('fusion-enable',fx('Включить лабораторию','Enable laboratory'),{primary:true}):btn('feature-on',fx('Включить Compute','Enable Compute'),{primary:true}))+msg('fusion'));
    const entries=[['summary',fx('Обзор','Overview')],['architecture',fx('Архитектура','Architecture')],['experts',fx('Эксперты','Experts')],
      ['devices',fx('Устройства','Devices')],['models',fx('Версии моделей','Model versions')],['diagnostics',fx('Диагностика','Diagnostics')]];
    const nav='<nav class="kc-lab-tabs" aria-label="Expert Fusion">'+entries.map(([id,label])=>'<button type="button" data-act="fusion-nav" data-arg="'+id+'"'+
      (id===fusionTab?' aria-current="page"':'')+'>'+esc(label)+'</button>').join('')+'</nav>';
    const controls=title('Expert Fusion',fx('Независимые эксперты на общей модели','Independent experts on a shared model'),btn('fusion-disable',fx('Выключить','Disable')))+nav+msg('fusion');
    if(fusionError)return controls+notice(fusionError,'warn');
    if(!fusionState)return controls+plain(tx('checking'));
    const {experts,models,active}=fusionState;
    const base=fusionState.builder?.model;
    const datasets=fusionState.builder?.datasets||[];
    const runs=fusionState.builder?.runs||[];
    const runLabel=status=>({CREATED:fx('Создан','Created'),READY:fx('Готов','Ready'),RUNNING:fx('Обучается','Training'),
      TRAINING:fx('Обучается','Training'),PAUSED:fx('На паузе','Paused'),AGGREGATING:fx('Агрегация','Aggregating'),
      EVALUATING:fx('Проверка на Validation','Validation in progress'),VALIDATED:fx('Проверен','Validated'),
      REJECTED:fx('Порог качества не пройден','Quality threshold not met'),PUBLISHED:fx('Опубликован','Published'),
      STOPPED:fx('Остановлен','Stopped'),ARCHIVED:fx('В архиве','Archived')})[status]??status;
    const choose=(id,label,options)=>'<label class="kc-field"><span>'+esc(label)+'</span><select id="'+id+'">'+
      options.map(([value,name])=>'<option value="'+esc(value)+'">'+esc(name)+'</option>').join('')+'</select></label>';
    const placement=()=>{
      const start=Number(form.fxLoopStart??0),end=Number(form.fxLoopEnd??Math.min(base.layers,4)),repeated=Number(form.fxPasses??1)>1;
      return '<div class="kc-fusion-placement" role="group" aria-label="'+esc(fx('Размещение по слоям','Layer placement'))+'">'+
        Array.from({length:base.layers},(_,i)=>'<button type="button" data-act="fusion-layer" data-arg="'+i+'" data-loop="'+
          (repeated&&i>=start&&i<end?'true':'false')+'" aria-label="'+esc(fx('Слой ','Layer ')+(i+1))+'" aria-pressed="'+fusionLayers.has(i)+'">'+(i+1)+'</button>').join('')+'</div>'+
          '<p class="kc-caption">'+esc(fx('Нажмите на слой, чтобы разместить эксперта. Контур показывает повторяемый блок.','Select a layer to place an expert. The outline marks the repeated block.'))+'</p>';
    };
    const detected=base?panel(fx('Модель Compute','Compute model'),choose('fxModel',fx('Проверенная локальная копия','Verified local copy'),[[base.id,base.title]])+
      kv([[fx('Слои','Layers'),base.layers],[fx('Скрытая размерность','Hidden width'),base.width],[fx('Словарь','Vocabulary'),base.vocab],
        [fx('Размер FFN','FFN width'),base.intermediate],[fx('Параметры в файлах','Parameters in stored shards'),base.parameters.toLocaleString(lang())]])):
      panel(fx('Модель Compute','Compute model'),notice(fusionState.builder?.reason?friendly(fusionState.builder.reason):
        fx('Подготовьте и проверьте локальную базовую модель в Compute. Архитектура появится здесь автоматически.','Verify a local base model in Compute. Its architecture will appear here automatically.'))+
        row(btn('lab-nav',fx('Открыть модели и данные','Open models and data'),{arg:'data'})));
    const published=models.find(m=>m.hash===active)?.envelope?.manifest;
    const stats=published?.stats;
    const fmtN=value=>value==null?'—':value.toLocaleString(lang());
    if(fusionTab==='summary')return controls+panel('',scores([
      [fx('Эксперты','Experts'),experts.length],[fx('Устройства Compute','Compute devices'),S.lab?.devices?.length??0],
      [fx('Уникальные параметры','Unique parameters'),fmtN(stats?.parameters)],
      [fx('Обучаемые параметры','Trainable parameters'),fmtN(stats?.trainable)],
      [fx('Верхняя граница активных параметров','Active parameter upper bound'),fmtN(stats?.active_upper_bound)],
      [fx('Выполнения слоёв','Layer executions'),fmtN(stats?.logical_layers)]])+plain(published?.base?.revision??fx('Активная композиция ещё не опубликована','No active composition has been published')));
    if(fusionTab==='architecture')return controls+detected+(base?panel(fx('Оценка по формам тензоров','Tensor-based sizing'),placement()+'<div class="kc-experience-grid">'+
      field('fxContext',fx('Контекст','Context'),Math.min(256,base.context),{type:'number'})+
      field('fxExperts',fx('Число дополнительных FFN','Additional FFNs'),1,{type:'number'})+field('fxInner',fx('Внутренний размер FFN','FFN intermediate width'),Math.min(512,base.intermediate),{type:'number'})+
      choose('fxTopK','Top‑K',[[1,1],[2,2],[4,4]])+
      field('fxLoopStart',fx('Начало цикла, индекс с нуля','Loop start, zero-based'),0,{type:'number'})+field('fxLoopEnd',fx('Конец цикла, исключительно','Loop end, exclusive'),Math.min(base.layers,4),{type:'number'})+
      choose('fxPasses',fx('Проходы','Passes'),[[1,1],[2,2],[3,3],[4,4]])+'</div>'+
      row(btn('fusion-estimate',fx('Рассчитать','Estimate'),{primary:true}))+(fusionEstimate?scores([
        [fx('Уникальные параметры','Unique parameters'),fmtN(fusionEstimate.parameters)],
        [fx('Верхняя граница активных','Active upper bound'),fmtN(fusionEstimate.active_upper_bound)],
        [fx('Выполнения слоёв','Layer executions'),fmtN(fusionEstimate.logical_layers)],
        ['FP16 checkpoint',fmtB(fusionEstimate.fp16_checkpoint_bytes)],['KV FP16',fmtB(fusionEstimate.fp16_kv_bytes)],
        [fx('Градиенты FP32','FP32 gradients'),fmtB(fusionEstimate.gradient_bytes)],['AdamW',fmtB(fusionEstimate.adamw_state_bytes)]
      ]):'')):'');
    if(fusionTab==='experts'){
      const expertRows=experts.map(e=>{
        const run=runs.find(r=>r.expert===e.id),dataset=datasets.find(d=>d.manifest_hash===e.dataset_sha256);
        const running=run&&['RUNNING','PAUSED'].includes(run.status);
        return card(e.name,kv([[fx('Специализация','Domain'),esc(e.domain)],[fx('Тип','Type'),esc(e.kind)],
        [fx('Версия','Version'),e.version],[fx('Параметры','Parameters'),fmtN(e.parameters)],[fx('Размер весов','Weights size'),fmtB(e.bytes)],
        [fx('Статус','Status'),'<span data-fusion-status="'+esc(run?.status??e.status)+'">'+esc(runLabel(run?.status??e.status))+'</span>'],
        [fx('Датасет','Dataset'),esc(dataset?.id??short(e.dataset_sha256))],
        [fx('Checkpoint','Checkpoint'),esc(short(e.checkpoint?.hash))],['Validation NLL',e.checkpoint?.assessment?.candidate_nll?.toFixed(5)??'—']])+
        (run?.leases?.length?'<ul class="kc-fusion-leases">'+run.leases.map(l=>{
          const d=S.lab?.devices?.find(d=>d.id===l.device),m=d?.metrics;
          const p=l.progress;
          return '<li>'+esc(d?.alias??short(l.device))+' · '+esc(({leased:fx('Назначено','Assigned'),accepted:fx('Принято','Accepted'),
            expired:fx('Аренда истекла','Lease expired'),cancelled:fx('Отменено','Cancelled')})[l.state]??l.state)+
            (p?' · '+esc(`${p.step} / ${e.training.local_steps}`):'')+(m?.tokens_per_s?' · '+esc(m.tokens_per_s+' tok/s'):'')+
            (m?.peak_reserved_bytes?' · '+esc(fmtB(m.peak_reserved_bytes)):'')+(d?.status?.blocking_reason?' · '+esc(reason(d.status.blocking_reason)):'')+'</li>';
        }).join('')+'</ul>':'')+
        (running?row(btn('fusion-control',run.status==='RUNNING'?fx('Пауза','Pause'):fx('Продолжить','Resume'),{arg:run.id+'|'+(run.status==='RUNNING'?'pause':'resume')})+
          btn('fusion-control',fx('Остановить','Stop'),{arg:run.id+'|stop'})):'')+
        (base&&dataset&&['CREATED','READY'].includes(e.status)?row(btn('fusion-start-dialog',fx('Запустить обучение','Start training'),{arg:e.id,primary:true})):'')+
        (['CREATED','READY','VALIDATED','PUBLISHED','REJECTED'].includes(e.status)?row(btn('fusion-archive',fx('Архивировать','Archive'),{arg:e.id})):''));
      }).join('');
      return controls+panel(fx('Реестр экспертов','Expert registry'),expertRows||plain(fx('Пока нет экспертов','No experts yet')))+detected+
        (base?panel(fx('Новый эксперт','New expert'),placement()+'<div class="kc-experience-grid">'+
        field('fxName',fx('Название','Name'),'')+field('fxKey',fx('Ключ латиницей','Expert key'),'')+
        field('fxDomain',fx('Специализация','Domain'),'')+choose('fxKind',fx('Тип эксперта','Expert type'),[['ffa-lora','FFA‑LoRA'],['lora','LoRA'],['ffn','FFN']])+
        choose('fxDataset',fx('Датасет','Dataset'),[['',fx('Выберите датасет','Choose a dataset')],...datasets.map(d=>[d.id,d.id])])+
        field('fxRank','Rank',8,{type:'number'})+field('fxExpertWidth',fx('Ширина FFN','FFN width'),Math.min(512,base.intermediate),{type:'number'})+
        choose('fxTrainingMode',fx('Обучение FFN','FFN training'),[['full',fx('Все матрицы','All matrices')],['down',fx('Выходная матрица','Down projection')]])+'</div>'+
        (!datasets.length?notice(fx('Импортируйте датасет для этой модели. Нужна проверка разделения выборок.','Import a dataset for this model with audited splits.')):'')+
        row(btn('fusion-create',fx('Создать эксперта','Create expert'),{primary:true,disabled:!datasets.length}))):'');
    }
    if(fusionTab==='devices')return controls+panel(fx('Этот воркер','This worker'),plain(S.policy?.fusion_training?
      fx('Участвует в заданиях Fusion при соблюдении ограничений Compute.','Eligible for Fusion jobs within the Compute resource policy.'):
      fx('Участие в заданиях Fusion выключено.','Fusion job participation is off.'))+
      row(btn('fusion-worker-toggle',S.policy?.fusion_training?fx('Остановить участие','Stop participation'):fx('Разрешить задания Fusion','Allow Fusion jobs'))))+labDevices();
    if(fusionTab==='models')return controls+panel(fx('Композиции','Compositions'),models.map(m=>card(short(m.hash),kv([
      [fx('Статус','Status'),esc(m.status)], [fx('Эксперты','Experts'),m.envelope.manifest.experts.length],
      [fx('Маршрутизатор','Router'),esc(m.envelope.manifest.router.mode)],[fx('Проходы','Passes'),m.envelope.manifest.loop.passes],
      ['Validation NLL',m.assessment?.candidate_nll??'—']])+row(m.hash===active?pill(fx('Активна','Active'),'good'):
        m.status==='VALIDATED'?btn('fusion-publish',fx('Опубликовать','Publish'),{arg:m.hash}):
        m.status==='PUBLISHED'?btn('fusion-rollback',fx('Вернуться к версии','Roll back to version'),{arg:m.hash}):''))).join('')||
      plain(fx('Композиции создаются после проверки экспертных checkpoint','Create compositions after validating expert checkpoints')));
    return controls+panel(fx('Диагностика','Diagnostics'),kv([[fx('Ключ подписания','Signing public key'),esc(fusionState.public_key)],
      [fx('Связь с координатором Compute','Compute coordinator'),esc(S.lab?.info?.endpoint??ct('none'))]]));
  }
  function labModels(){
    const l=S.lab,variants=l?.variants||[];
    return '<div class="kc-experience-grid"><div class="kc-stack">'+panel(tx('runtimeModels'),(variants.length?variants.map(v=>
      '<div class="kc-device-row"><span class="kc-device-icon" aria-hidden="true">◈</span><div class="kc-device-summary"><strong>'+esc(v.variant_id)+'</strong>'+
      (v.official_source?'<small>'+esc(tx('officialSource',{repo:v.official_source.repo,revision:short(v.official_source.revision)}))+'</small>':'')+'</div>'+
      pill(trust(v.provenance),v.provenance==='unverified'?'warn':'good')+'</div>').join(''):plain(tx('autoModels')))+
      (S.feature_enabled?row(btn('expert-open',tx('expert'))+(S.profile.variants.includes('mlx-4bit')?btn('show-mlx-import',tx('importMlx')):'')):'')+msg('model'))+
      panel(tx('bundleData'),plain(tx('autoModels'))+(l?.datasets||[]).map(d=>'<div class="kc-device-row"><div class="kc-device-summary"><strong>'+esc(d.id)+'</strong><small>'+esc(tx('splitCounts',d.split_counts||{}))+'</small></div>'+
        pill(tx(d.group_audited?'groupsAudited':'groupsLegacy'),d.group_audited?'good':'warn')+'</div>').join(''))+
      '</div><div class="kc-stack">'+(onlineOptions(l))+'</div></div>';
  }
  function onlineOptions(l){
    if(!l?.info?.running)return '';
    return panel(tx('expert'),'<details data-expand="lab-assets"><summary>'+esc(tx('technicalDetails'))+'</summary>'+
      row(btn('register-model',ct('lab.registerModel'),{disabled:!S.model?.architecture_ok})+btn('import-fixture',ct('lab.importFixture')))+
      reportedVariants(l.variants)+field('kcDsFile',ct('lab.file'),'',{browse:'file',wide:true})+
      '<div class="kc-row">'+field('kcDsId',ct('lab.dsid'),'')+field('kcDsRev',ct('lab.rev'),'1')+'</div>'+
      row(btn('import-dataset',ct('lab.import')))+msg('dataset')+'</details>');
  }
  async function rememberFeature(){
    if(!S?.feature_enabled){
      await api('/api/compute/v2/feature',{enabled:true});
      S=await call('state');render(true);
    }
  }
  function showSmoke(){
    smoke=S.lab?.smoke||null;
    smokeIds=smoke?.ids||[];
    requestId=crypto.randomUUID();
    openDialog('smoke',tx('smokeTitle'),plain(tx('smokeDescription'))+
      '<div data-smoke-devices></div><label class="kc-check" data-smoke-warning><input id="kcSmokeUnverified" type="checkbox">'+esc(tx('smokeUnverified'))+'</label>'+
      '<p data-dialog-error role="alert"></p>',btn('close-dialog',tx('cancel'))+btn('smoke-start',tx('smokeRun'),{primary:true,disabled:true}));
    updateSmoke();
    void refreshSmoke();
  }
  function updateSmoke(){
    if(!dialog().open||dialog().dataset.kind!=='smoke')return;
    const block=dialog().querySelector('[data-smoke-devices]');
    const existing=block.querySelector('input:focus');
    if(!existing)block.innerHTML=(smoke?.devices||[]).map(d=>'<label class="kc-check kc-device-row"><input type="checkbox" data-smoke-id="'+esc(d.id)+'"'+
      (smokeIds.includes(d.id)?' checked':'')+'><span class="kc-device-summary"><strong>'+esc(d.alias)+'</strong>'+
      (d.reason?'<small>'+esc(friendly(d.reason))+'</small>':'')+'</span>'+readyPill(d.reason)+'</label>').join('')+
      (smoke?.reason?notice(friendly(smoke.reason),'warn'):'');
    dialog().querySelector('[data-smoke-warning]').hidden=!smoke?.unverified;
    dialog().querySelector('[data-act=smoke-start]').disabled=busy||stale||!smoke?.ready||smokeIds.length!==3||
      (smoke.unverified&&!dialog().querySelector('#kcSmokeUnverified').checked);
  }
  async function refreshSmoke(){
    const id=requestId,ids=smokeIds.slice();
    if(dialog().dataset.kind!=='smoke')return;
    try{
      const result=await call('lab/smoke-readiness',{ids});
      if(requestId===id&&smokeIds.join()===ids.join()){smoke=result;updateSmoke();}
    }catch(error){if(requestId===id)dialogError(friendly(error.code));}
  }
  function showExpert(){
    openDialog('expert',tx('expert'),expertData()+row(btn('feature-off',ct('feature.disable'))));
  }
  function showExperiment(source){
    plan=null;planInput=null;lastResult.plan=null;
    if(!source){tab='experiments';render(true);}
    const smokeIntro=source?'':plain(tx('smokeDescription'))+row(btn('show-smoke',tx('smoke'),{primary:true}));
    openDialog('new-experiment',tx(source?'continueAdapter':'newExperiment'),smokeIntro+'<details'+(source?' open':'')+'><summary>'+
      esc(tx('customExperiment'))+'</summary>'+expertExperiment(source)+'</details>');
  }
  // ---------- actions ----------
  const fieldElement=id=>(dialog().open?dialog().querySelector('#'+id):null)||body().querySelector('#'+id);
  const val=id=>fieldElement(id)?.value?.trim()||'';
  const numv=id=>{const v=val(id);return v===''?undefined:Number(v);};
  const note=(k,text,bad)=>{lastResult[k]={text,bad};};
  async function run(fn,key){
    if(busy)return;busy=true;body().querySelectorAll('button,input,select').forEach(el=>el.disabled=true);
    try{const r=await fn();if(r&&typeof r==='object'&&'state' in r&&'policy' in r)S={feature_enabled:true,...r};return r;}
    catch(e){
      if(dialog().open&&dialog().querySelector('[data-dialog-error]'))dialogError(friendly(e.code));
      else if(key)note(key,friendly(e.code),true);else toast(friendly(e.code));
    }
    finally{
      busy=false;await refresh(true);
      if(dialog().dataset.kind==='expert'&&dialog().open){
        const d=dialog(),y=d.scrollTop;
        d.querySelector('[data-dialog-content]').innerHTML=expertData()+row(btn('feature-off',ct('feature.disable')));
        d.scrollTop=y;
      }
      if(dialog().dataset.kind==='new-experiment'&&dialog().open){
        const submit=dialog().querySelector('[data-act=create]');
        if(submit)submit.disabled=!plan;
        const target=dialog().querySelector('[data-plan-summary]');
        if(target)target.innerHTML=plan?notice(ct('lab.plan',{tasks:plan.tasks,rows:plan.rows_per_task,tokens:plan.supervised_tokens_total,params:plan.trainable_params,targets:plan.targets,r:plan.rank,a:plan.alpha}))+
          plain('config '+short(plan.config_hash)+' · frozen A '+short(plan.frozen_a_hash),'kc-caption')+
          (!plan.research_pass_possible?notice(ct('lab.planWarn',{why:[plan.dataset.synthetic?ct('lab.synthetic'):null,plan.model_variants.some(v=>!v.research_eligible)?ct('lab.unverified'):null].filter(Boolean).join(', ')}),'warn'):''):msg('plan');
      }
    }
  }
  async function pickDir(){if(!desktop())return null;return desktop().chooseFolder('other');}
  function experimentConfig(){
    const qm=val('kcQMode'),cfg={name:val('kcName'),preset:val('kcPreset'),dataset_id:val('kcDataset'),variants:[...(dialog().open?dialog():body()).querySelectorAll('.kcVar:checked')].map(i=>i.value),
      rounds:numv('kcRounds'),local_steps:numv('kcSteps'),seed:numv('kcSeed'),round_deadline_s:numv('kcDeadline'),max_length:numv('kcMaxLen')||256,memory_checked:S.preflight?.max_length===512,research_confirmed:fieldElement('kcResearch')?.checked===true};
    const lr=val('kcLr');cfg.optimizer={name:val('kcOpt')||'sgd',...(lr?{lr:Number(lr)}:{})};
    if(qm)cfg.quorum={mode:qm,target:numv('kcQTarget')??3,min:numv('kcQMin')};
    const ee=numv('kcEvalEvery');if(ee!==undefined)cfg.eval={every:ee};
    const initial=val('kcInitialCheckpoint');
    if(initial){const [experiment_id,sha256]=initial.split('|');cfg.initial_checkpoint={experiment_id,sha256};}
    return cfg;
  }
  const acts={
    'feature-on':()=>run(async()=>{await api('/api/compute/v2/feature',{enabled:true});}),
    'feature-off':()=>run(async()=>{clearDialog();await api('/api/compute/v2/feature',{enabled:false});setMode('contribution');}),
    goto:el=>{tab=el.dataset.arg==='devices'?'devices':'data';setMode('laboratory');},
    'switch-lab':()=>{tab='overview';setMode('laboratory');},
    'lab-nav':el=>{tab=el.dataset.arg;lastResult={};scroll().scrollTop=0;render(true);void refresh(true);},
    'fusion-enable':()=>run(()=>call('fusion-feature',{enabled:true}),'fusion'),
    'fusion-disable':()=>run(async()=>{await call('fusion-feature',{enabled:false});fusionState=null;},'fusion'),
    'fusion-nav':el=>{fusionTab=el.dataset.arg;render(true);},
    'fusion-layer':el=>{const i=Number(el.dataset.arg);if(fusionLayers.has(i))fusionLayers.delete(i);else fusionLayers.add(i);fusionEstimate=null;render(true);},
    'fusion-worker-toggle':()=>run(()=>call('policy',{policy:{fusion_training:!S.policy.fusion_training},revision:S.policy.revision}),'fusion'),
    'fusion-control':el=>{const [id,action]=el.dataset.arg.split('|');run(()=>fusionCall('control',{id,action}),'fusion');},
    'fusion-start-dialog':el=>{
      const devices=(S.lab?.devices??[]).filter(d=>d.state==='active');
      openDialog('fusion-start',fx('Запуск обучения эксперта','Start expert training'),
        '<label class="kc-field">'+esc(fx('Устройство','Device'))+'<select id="fxDevice"><option value="">'+esc(fx('Автоматическое назначение','Automatic assignment'))+'</option>'+
          devices.map(d=>'<option value="'+esc(d.id)+'">'+esc(d.alias??d.id)+'</option>').join('')+'</select></label>'+
        field('fxQuorum',fx('Устройств на раунд','Devices per round'),1,{type:'number'})+
        '<label class="kc-check"><input id="fxShareTrain" type="checkbox"> '+esc(fx('Разрешаю передать строки Train одобренным устройствам','Allow sending Train rows to approved devices'))+'</label>',
        btn('fusion-start',fx('Запустить','Start'),{arg:el.dataset.arg,primary:true})+btn('close-dialog',ct('cancel')));
    },
    'fusion-start':el=>run(async()=>{
      const e=fusionState.experts.find(x=>x.id===el.dataset.arg),builder=fusionState.builder;
      const dataset=builder.datasets.find(d=>d.manifest_hash===e.dataset_sha256),device=val('fxDevice');
      await fusionCall('start',{expert_id:e.id,dataset_id:dataset.id,model_sha256:builder.model.id,devices:device?[device]:[],
        quorum:device?1:numv('fxQuorum'),share_train:dialog().querySelector('#fxShareTrain')?.checked===true});
      clearDialog();
    },'fusion'),
    'fusion-create':()=>run(()=>fusionCall('expert/create',{model_id:val('fxModel'),dataset_id:val('fxDataset'),key:val('fxKey'),name:val('fxName'),
      domain:val('fxDomain'),kind:val('fxKind'),layers:[...fusionLayers],rank:numv('fxRank'),intermediate:numv('fxExpertWidth'),training_mode:val('fxTrainingMode')}),'fusion'),
    'fusion-archive':el=>{const e=fusionState?.experts.find(x=>x.id===el.dataset.arg);if(e)run(()=>fusionCall('expert/archive',{id:e.id,from:e.status}),'fusion');},
    'fusion-publish':el=>run(()=>fusionCall('models/publish',{hash:el.dataset.arg}),'fusion'),
    'fusion-rollback':el=>run(()=>fusionCall('models/rollback',{hash:el.dataset.arg}),'fusion'),
    'fusion-estimate':()=>run(async()=>{
      const n=numv('fxExperts');
      if(!Number.isInteger(n)||n<0||n>4096)throw Error(fx('Допустимо от 0 до 4096 экспертов','Choose between 0 and 4096 experts'));
      fusionEstimate=await fusionCall('estimate',{model_id:val('fxModel'),count:n,layers:[...fusionLayers],intermediate:numv('fxInner'),context:numv('fxContext'),
        top_k:numv('fxTopK'),loop:{start:numv('fxLoopStart'),end:numv('fxLoopEnd'),passes:numv('fxPasses')}});
    },'fusion'),
    'join-wizard':()=>run(async()=>{await rememberFeature();inviteDialog();},'join'),
    'close-dialog':clearDialog,
    'submit-invitation':()=>run(async()=>{
      const invite=val('kcInvitation'),replace=dialog().querySelector('#kcReplace')?.checked===true;
      if(!invite){dialogError(friendly('INVALID_SCHEMA'));return;}
      const attempt=invitationEpoch;
      S=await call('onboarding/join',{invitation:invite,replace});
      if(attempt!==invitationEpoch)return;
      hardware=null;
      if(S.consent.required||!S.consent.current?.scopes?.automatic_setup)consentDialog();
      else{
        clearDialog();
        if(S.missing?.length)await call('onboarding/retry',{});
        else await call('participation',{enabled:true});
      }
    },'join'),
    'review-consent':consentDialog,
    'accept-preparation':()=>run(async()=>{
      const c=S.consent.text;
      await call('consent/accept',{text_revision:c.text_revision,project_id:c.project_id,prepare:true});
      clearDialog();setMode('contribution');
    },'join'),
    'setup-retry':()=>run(()=>call('onboarding/retry',{}),'join'),
    'setup-cancel':()=>run(()=>call('onboarding/cancel',{}),'join'),
    'approve-download':()=>run(()=>call('onboarding/download',{id:S.download_offer?.id,bytes:S.download_offer?.bytes}),'join'),
    'policy-preset':el=>run(async()=>{const id=el.dataset.arg;await rememberFeature();return call('policy/preset',{id,revision:S.policy.revision});},'policy'),
    'full-profile':()=>openDialog('full',ct('profile.full'),plain(tx('resourcesNote'))+notice('GPU 100% · CPU 50%'),
      btn('close-dialog',tx('cancel'))+btn('confirm-full',ct('profile.full'),{primary:true})),
    'confirm-full':()=>run(async()=>{const s=await call('policy',{policy:{profile:'full',gpu_target_pct:100,cpu_target_pct:50,daily_hours:4},revision:S.policy.revision});clearDialog();return s;},'policy'),
    'start-participation':()=>run(()=>call('participation',{enabled:true}),'join'),
    pause:()=>run(()=>call('pause',{})),resume:()=>run(()=>call('resume',{})),
    stop:()=>{if(confirm(tx('confirmStop')))run(()=>call('participation',{enabled:false}));},
    'expert-open':showExpert,
    'auto-lab':()=>run(async()=>{await rememberFeature();return call('lab/auto-start',{});},'lab'),
    'new-experiment':()=>showExperiment(),
    'show-smoke':showSmoke,
    'smoke-start':()=>run(async()=>{
      const id=requestId,accept=dialog().querySelector('#kcSmokeUnverified').checked;
      const e=await call('lab/smoke-start',{device_ids:smokeIds,accept_unverified:accept,request_id:id});
      clearDialog();selExp=e.id;tab='monitor';
    },'exp'),
    diag:()=>run(async()=>{
      const report=await call('diagnostics');
      const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
      const a=document.createElement('a');a.href=url;a.download='kvalah-compute-diagnostics.json';a.click();
      setTimeout(()=>URL.revokeObjectURL(url),5000);
    },'diag'),
    'consent-revoke':()=>run(()=>call('consent/revoke',{})),
    pair:()=>run(async()=>{lastResult.pair=null;const r=await call('link/pair',{pairing:val('kcPairing'),alias:val('kcAlias')||undefined});delete form.kcPairing;return r;},'pair'),
    'link-refresh':()=>run(()=>call('link/refresh',{}),'pair'),
    'link-forget':()=>{if(confirm(ct('confirm.stop')))run(()=>call('link/forget',{}));},
    'lab-start':()=>run(()=>call('lab/start',{bind_ip:val('kcBind'),port:numv('kcPort')}),'lab'),
    'lab-stop':()=>run(()=>{pairing=null;return call('lab/stop',{});},'lab'),
    'lab-pairing':()=>run(async()=>{
      pairing=await call('lab/pairing',{});
      openDialog('issued',tx('inviteDevice'),plain(tx('inviteInfo'))+
        '<label class="kc-field">'+esc(tx('inviteField'))+'<textarea rows="3" readonly id="kcIssuedCode" spellcheck="false">'+esc(pairing.pairing)+'</textarea></label>'+
        plain(tx('inviteExpiry',{time:when(pairing.expires_at)}),'kc-caption'),btn('close-dialog',tx('close'))+btn('copy-code',ct('copy'),{primary:true}));
    },'lab'),
    'lab-join':()=>run(()=>call('lab/join-self',{}),'lab'),
    'lab-join-ux':()=>run(async()=>{S=await call('lab/join-self',{});consentDialog();},'lab'),
    'show-approval':el=>{
      const d=S.lab?.devices.find(x=>x.id===el.dataset.arg);
      if(!d)return;
      openDialog('approve',ct('dev.approve'),notice(d.alias)+kv([[ct('dev.key'),esc(d.key_fingerprint)],[tx('stageRuntime'),esc(d.capabilities?.backend||tx('noMeasure'))],
        [tx('stageModel'),esc(d.capabilities?.variants?.[0]?.variant_id||tx('noMeasure'))]]),
        btn('close-dialog',tx('cancel'))+btn('dev-approve',ct('dev.approve'),{arg:d.id,primary:true}));
    },
    'copy-code':()=>{navigator.clipboard?.writeText(pairing?.pairing||'').then(()=>toast(ct('copied')),()=>{});},
    'dev-approve':el=>run(async()=>{await call('lab/approve',{id:el.dataset.arg});if(dialog().dataset.kind==='approve')clearDialog();},'lab'),
    'dev-revoke':el=>{if(confirm(ct('dev.confirmRevoke')))run(()=>call('lab/revoke',{id:el.dataset.arg}),'lab');},
    'dev-drain':el=>{const [id,on]=el.dataset.arg.split('|');run(()=>call('lab/drain',{id,on:on==='true'}),'lab');},
    'dev-rename':el=>{const a=prompt(ct('dev.renamePrompt'));if(a)run(()=>call('lab/rename',{id:el.dataset.arg,alias:a}),'lab');},
    'register-model':()=>run(async()=>{await call('lab/register-model',{});note('model',ct('saved'));},'model'),
    'show-mlx-import':()=>openDialog('mlx-import',tx('importMlx'),plain(tx('importMlxInfo'))+
      field('kcMlxManifest',tx('mlxManifest'),'',{browse:'file',wide:true})+field('kcMlxSource',tx('mlxSource'),'',{browse:'folder',wide:true})+
      field('kcMlxOutput',tx('mlxOutput'),S.model?.variant_id==='mlx-4bit'?S.model.model_dir:'',{browse:'folder',wide:true})+
      '<label class="kc-check"><input type="checkbox" id="kcMlxReviewed">'+esc(tx('mlxReviewed'))+'</label>'+
      '<p data-mlx-progress role="status"></p><p data-dialog-error role="alert"></p>',
      btn('close-dialog',tx('cancel'))+btn('import-mlx',tx('verifyMlx'),{primary:true})),
    'import-mlx':()=>run(async()=>{
      const progress=dialog().querySelector('[data-mlx-progress]'),button=dialog().querySelector('[data-act=import-mlx]');
      progress.textContent=tx('verifyingMlx');button.disabled=true;
      try{
        const result=await call('lab/import-mlx-conversion',{manifest_file:val('kcMlxManifest'),source_dir:val('kcMlxSource'),
          output_dir:val('kcMlxOutput'),reviewed:fieldElement('kcMlxReviewed').checked});
        clearDialog();note('model',tx('mlxVerified',{hash:short(result.files_digest)}));
      }finally{progress.textContent='';button.disabled=false;}
    },'model'),
    'register-device-model':el=>{const [device_id,variant_id]=el.dataset.arg.split('|');run(async()=>{await call('lab/register-model',{device_id,variant_id});note('model',ct('saved'));},'model');},
    'import-fixture':()=>run(async()=>{const r=await call('lab/import-dataset',{fixture:true});note('dataset',ct('saved')+': '+(r.id||r.dataset_id||''));},'dataset'),
    'import-dataset':()=>run(async()=>{const r=await call('lab/import-dataset',{file:val('kcDsFile'),dataset_id:val('kcDsId'),revision:val('kcDsRev')||'1'});note('dataset',ct('saved')+': '+(r.id||r.dataset_id||''));},'dataset'),
    'dry-run':()=>run(async()=>{plan=null;lastResult.plan=null;const cfg=experimentConfig();plan=await call('lab/dry-run',{config:cfg});planInput=cfg;},'plan'),
    create:()=>{if(!plan||!planInput)return;if(!confirm(ct('lab.confirmStart',{n:plan.config.name,t:plan.tasks})))return;
      run(async()=>{const e=await call('lab/create',{config:planInput});for(const k of Object.keys(form))if(/^kc(Name|Rounds|Steps|Lr|Q|Deadline|Seed|EvalEvery|Research|Var_)/.test(k))delete form[k];planInput=null;await call('lab/experiment/start',{id:e.id});clearDialog();selExp=e.id;plan=null;tab='monitor';},'plan');},
    'exp-start':el=>run(()=>call('lab/experiment/start',{id:el.dataset.arg}),'exp'),'exp-pause':el=>run(()=>call('lab/experiment/pause',{id:el.dataset.arg}),'exp'),
    'exp-resume':el=>run(()=>call('lab/experiment/resume',{id:el.dataset.arg}),'exp'),'exp-finish':el=>run(()=>call('lab/experiment/finish',{id:el.dataset.arg}),'exp'),
    'exp-cancel':el=>{if(confirm(ct('exp.confirmCancel')))run(()=>call('lab/experiment/cancel',{id:el.dataset.arg}),'exp');},
    'exp-monitor':el=>{selExp=el.dataset.arg;tab='monitor';refresh(true);},
    'exp-continue':el=>{const e=S.lab?.experiments.find(x=>x.id===el.dataset.arg);if(e?.checkpoint)showExperiment(e);},
    'exp-test':el=>run(()=>call('lab/experiment/evaluate-test',{id:el.dataset.arg}),'exp'),
    'exp-report':el=>{const w=body().querySelector('#kcWeights')?.checked===true;pickDir().then(d=>{d=d||prompt(ct('browse'));if(d)run(async()=>{const r=await call('lab/report',{experiment_id:el.dataset.arg,dir:d,include_weights:w});note('exp',ct('exp.done',{p:r.path}));},'exp');});},
    'exp-peft':el=>{pickDir().then(d=>{d=d||prompt(ct('browse'));if(d)run(async()=>{const r=await call('lab/export-peft',{experiment_id:el.dataset.arg,dir:d});note('exp',ct('exp.done',{p:r.out_dir||r.path||d}));},'exp');});},
    'select-exp':el=>{selExp=el.value;refresh(true);},
    'rounds-json':()=>{if(!expData)return;const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(expData,null,1)],{type:'application/json'}));a.download='kvalah-compute-'+expData.status.run_id+'-rounds.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),5000);},
    profile:el=>run(()=>call('profile',{profile_id:el.value}),'model'),
    runtime:()=>run(()=>call('runtime',{python:val('kcPython'),backend:val('kcBackend')}),'runtime'),
    model:()=>run(()=>call('model',{model_dir:val('kcModelDir'),variant_id:val('kcVariant')}),'model'),
    provenance:()=>run(()=>call('model/provenance',{}),'model'),
    preflight:()=>run(()=>call('preflight',{max_length:Number(val('kcPreflightLength'))||256}),'model'),
    legacy:()=>run(async()=>{await call('legacy/import',{file:val('kcLegacy')});},'legacy'),
    'verify-report':()=>run(async()=>{const r=await call('verify-report',{file:val('kcReport')});note('verify',(r.ok?'OK':'FAIL')+' · '+(r.run_id||'')+' · rounds '+(r.committed_rounds??'?')+(r.problems?.length?' · '+r.problems.slice(0,5).join('; '):''),!r.ok);},'verify'),
    browse:async el=>{const [id,kind]=el.dataset.arg.split('|');if(!desktop())return;try{const f=kind==='folder'?await desktop().chooseFolder('other'):await desktop().chooseFile('any');if(f){fieldElement(id).value=f;form[id]=f;}}catch(e){toast(friendly(e.code));}}
  };
  // ---------- wiring ----------
  function init(){
    const nav=document.getElementById('openCompute');if(!nav||!root())return;
    nav.addEventListener('click',()=>show(true));
    document.getElementById('computeBack').addEventListener('click',()=>show(false));
    document.getElementById('computeModes').addEventListener('click',e=>{const b=e.target.closest('[data-mode]');if(b)setMode(b.dataset.mode);});
    const click=e=>{const b=e.target.closest('[data-act]');if(b&&!b.disabled&&acts[b.dataset.act]){e.preventDefault();acts[b.dataset.act](b);}};
    root().addEventListener('click',click);dialog().addEventListener('click',click);
    dialog().addEventListener('cancel',e=>{e.preventDefault();clearDialog();});
    root().addEventListener('toggle',e=>{const key=e.target.dataset.expand;if(key){if(e.target.open)expanded.add(key);else expanded.delete(key);}},true);
    const change=e=>{
      const t=e.target;
      if(t.dataset.smokeId){smokeIds=t.checked?[...new Set([...smokeIds,t.dataset.smokeId])]:smokeIds.filter(v=>v!==t.dataset.smokeId);updateSmoke();void refreshSmoke();return;}
      if(t.id==='kcSmokeUnverified'){updateSmoke();return;}
      if(t.id&&t.dataset.pol===undefined&&!t.dataset.actChange&&!['kcInvitation','kcAgree','kcReplace','kcIssuedCode','kcPairing'].includes(t.id)){
        form[t.id]=t.type==='checkbox'?t.checked:t.value;if(t.closest('.kc-form')){plan=null;const start=dialog().querySelector('[data-act=create]');if(start)start.disabled=true;}
      }
      if(t.dataset.actChange&&acts[t.dataset.actChange])return acts[t.dataset.actChange](t);
      if(['fxLoopStart','fxLoopEnd','fxPasses'].includes(t.id)){fusionEstimate=null;render(true);}
      if(t.dataset.pol!==undefined){const p=collectPolicy();run(async()=>{lastResult.policy=null;await call('policy',{policy:p,revision:S.policy.revision});},'policy');}
    };
    root().addEventListener('change',change);dialog().addEventListener('change',change);
    root().addEventListener('input',e=>{const t=e.target;if(t.id&&t.dataset.pol===undefined&&t.type!=='checkbox'&&t.id!=='kcPairing')form[t.id]=t.value;
      if(t.type==='range'&&t.dataset.pol){const n=document.getElementById('v_'+t.dataset.pol);if(n)n.textContent=t.value+t.dataset.unit;}});
    dialog().addEventListener('input',e=>{
      if(!e.target.closest('.kc-form'))return;
      plan=null;const b=dialog().querySelector('[data-act=create]');if(b)b.disabled=true;
    });
    desktop()?.onComputeInvitation?.(value=>{
      if(typeof value!=='string'||value.length>4096)return;
      show(true);setMode('contribution');
      void run(async()=>{await rememberFeature();inviteDialog(value);},'join');
    });
    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&open&&!document.querySelector('dialog[open]'))show(false);});
    const ic=document.getElementById('computeIcon');if(ic)ic.innerHTML='<svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/></svg>';
  }
  window.kvCompute={show,refresh};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
