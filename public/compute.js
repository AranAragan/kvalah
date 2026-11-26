// Kvalah Compute v0.2 view. Every control calls /api/compute/v2/* (served by the compute host child
// process); nothing here is simulated. When the feature flag is off only the enable card is shown.
(()=>{
  const D=window.KC_I18N;
  const lang=()=>window.kvI18n?.lang==='ru'?'ru':'en';
  const ct=(k,p)=>{let v=D[lang()][k]??D.en[k]??k;if(p)for(const [a,b] of Object.entries(p))v=v.split('{'+a+'}').join(String(b));return v;};
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const reason=r=>r?(D[lang()]['r.'+r]?ct('r.'+r):String(r)):'';
  const short=h=>h?String(h).slice(0,12):ct('none');
  const fmtMs=ms=>{if(ms==null)return ct('none');const s=Math.round(ms/1000);return s<60?s+' s':s<3600?Math.floor(s/60)+' min '+(s%60)+' s':Math.floor(s/3600)+' h '+Math.floor(s%3600/60)+' min';};
  const fmtB=b=>b==null?ct('none'):b<1024?b+' B':b<1048576?(b/1024).toFixed(1)+' KB':b<1073741824?(b/1048576).toFixed(1)+' MB':(b/1073741824).toFixed(2)+' GB';
  const when=ts=>ts?new Date(ts).toLocaleString(lang()):ct('none');
  const desktop=()=>window.kvalahDesktop;
  const call=(route,body)=>api('/api/compute/v2/'+route,body);
  let form={},planInput=null;
  let S=null,tab='participate',open=false,busy=false,timer=null,selExp=null,expData=null,coordEvents=[],plan=null,pairing=null,lastResult={};
  const root=()=>document.getElementById('computeView');
  const body=()=>document.getElementById('computeBody');
  // ---------- shell ----------
  function show(on){
    open=on;document.body.classList.toggle('compute-open',on);root().hidden=!on;
    if(on){refresh(true);clearInterval(timer);timer=setInterval(()=>{if(!document.hidden)refresh(false);},2000);}else clearInterval(timer);
  }
  async function refresh(full){
    try{S=await call('state');}catch(e){S={feature_enabled:false,error:e.message};}
    if(S.feature_enabled&&S.lab&&tab==='monitor'){
      const exps=S.lab.experiments||[];if(!selExp||!exps.find(e=>e.id===selExp))selExp=exps[0]?.id||null;
      try{expData=selExp?await call('lab/experiment/status',{id:selExp}):null;const ev=await call('lab/events',{tail:true});coordEvents=Array.isArray(ev)?ev.slice(-60):[];}catch{expData=null;}
    }
    render(full);
  }
  const editing=()=>{const a=document.activeElement;return a&&root()?.contains(a)&&/^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName);};
  const live={};
  const L=(id,fn)=>{live[id]=fn;return '<div data-live="'+id+'">'+fn()+'</div>';};
  function render(full){
    if(!open)return;
    document.querySelectorAll('#computeTabs [data-tab]').forEach(b=>{b.classList.toggle('active',b.dataset.tab===tab);b.textContent=ct('tab.'+b.dataset.tab);b.hidden=!S?.feature_enabled;});
    document.getElementById('computeTitle').textContent=ct('title');document.getElementById('computeSub').textContent=ct('subtitle');
    document.getElementById('computeBadge').textContent=ct('experimental');document.getElementById('computeBack').title=ct('back');document.getElementById('computeBack').setAttribute('aria-label',ct('back'));
    if(!full&&editing()){for(const el of body().querySelectorAll('[data-live]'))if(live[el.dataset.live]&&!el.contains(document.activeElement))el.innerHTML=live[el.dataset.live]();return;}
    const y=body().scrollTop;
    body().innerHTML=!S?'':!S.feature_enabled?featureOff():({participate,devices,lab,monitor,data})[tab]();
    // Keep what the user typed across re-renders (polling, actions).
    for(const [id,v] of Object.entries(form)){const el=body().querySelector('#'+CSS.escape(id));if(!el)continue;if(el.type==='checkbox')el.checked=v;else el.value=v;}
    if(busy)body().querySelectorAll('button,input,select').forEach(el=>{if(!el.closest('#computeTabs'))el.disabled=true;});
    body().scrollTop=y;
  }
  const card=(title,inner,extra='')=>'<section class="kc-card'+extra+'">'+(title?'<h3>'+esc(title)+'</h3>':'')+inner+'</section>';
  const btn=(act,label,o={})=>'<button type="button" class="'+(o.primary?'primary kc-btn':'secondary')+'" data-act="'+act+'"'+(o.arg!=null?' data-arg="'+esc(o.arg)+'"':'')+(o.disabled||busy?' disabled':'')+'>'+esc(label)+'</button>';
  const field=(id,label,value,o={})=>'<label class="kc-field'+(o.wide?' wide':'')+'"><span>'+esc(label)+'</span><span class="kc-inline"><input id="'+id+'" value="'+esc(value??'')+'"'+(o.placeholder?' placeholder="'+esc(o.placeholder)+'"':'')+(o.type?' type="'+o.type+'"':'')+'>'+(o.browse?'<button type="button" class="secondary" data-act="browse" data-arg="'+id+'|'+o.browse+'">'+esc(ct('browse'))+'</button>':'')+'</span></label>';
  const msg=k=>lastResult[k]?'<p class="kc-msg'+(lastResult[k].bad?' bad':'')+'">'+esc(lastResult[k].text)+'</p>':'';
  const kv=rows=>'<dl class="kc-kv">'+rows.filter(Boolean).map(([k,v])=>'<dt>'+esc(k)+'</dt><dd>'+v+'</dd>').join('')+'</dl>';
  function featureOff(){
    return card('',(S.error?'<p class="kc-msg bad">'+esc(S.error)+'</p>':'')+'<p>'+esc(ct('feature.off'))+'</p><p class="kc-note">'+esc(ct('feature.note'))+'</p>'+btn('feature-on',ct('feature.enable'),{primary:true}));
  }
  // ---------- Participation ----------
  function statusLine(){
    const st=S.state,w=S.worker;
    let h='<div class="kc-status"><span class="kc-dot s-'+esc(st)+'"></span><strong>'+esc(ct('state.'+st))+'</strong>'+(S.reason?'<span class="kc-note">'+esc(ct('reason',{r:reason(S.reason)}))+'</span>':'')+'</div>';
    if(w?.task)h+='<p class="kc-note">'+esc(ct('task',{round:w.task.round??'?',step:w.task.step??0,steps:w.task.steps??'?',tokens:w.task.expected_tokens??'?'}))+'</p>';
    if(w?.task?.lease)h+='<p class="kc-note">'+esc('Lease · '+fmtMs(w.task.lease.remaining_ms))+'</p>';
    const rpc=w?.last_rpc_error;
    if(rpc&&['ERROR_RECOVERABLE','UPLOADING','PAUSED'].includes(w.state))h+='<p class="kc-note">'+esc([rpc.method,rpc.route,rpc.stage,rpc.code,rpc.next_retry_at?new Date(rpc.next_retry_at).toLocaleTimeString(lang()):null].filter(Boolean).join(' · '))+'</p>';
    if(S.last_error)h+='<p class="kc-msg bad">'+esc((S.last_error.code||'')+': '+(S.last_error.message||''))+'</p>';
    return h;
  }
  function measuredBlock(){
    const b=S.budget||{},m=S.measured||{},w=S.worker?.metrics||{};
    return kv([[ct('measured.wall'),esc(fmtMs(b.used_wall_ms))+' / '+esc(fmtMs(b.limit_ms))],[ct('measured.gpu'),esc(fmtMs(b.used_gpu_ms))],[ct('measured.share'),m.active_fraction_60s==null?ct('none'):Math.round(m.active_fraction_60s*100)+'%'],
      [ct('measured.tasks'),esc(w.tasks_accepted??0)],[ct('measured.tokens'),esc(w.supervised_tokens??0)],[ct('measured.acceptedTokens'),esc(w.accepted_tokens??0)],[ct('measured.bytes'),esc(fmtB(w.bytes_in??null))+' / '+esc(fmtB(w.bytes_out??null))+' · '+esc(fmtB(b.bytes)+' / '+fmtB(S.policy.daily_traffic_mb*1e6))]])
      +'<p class="kc-note">'+esc(ct('measured.month',{h:((S.month?.wall_ms||0)/3600e3).toFixed(1)}))+'</p>';
  }
  function sensorsBlock(){
    const s=S.governor?.sensors||{};
    return kv([s.gpu?[ct('gpu.info'),esc(s.gpu.name+' · '+(s.gpu.utilization_pct??'?')+'% · '+(s.gpu.temperature_c??'?')+' °C · '+fmtB(s.gpu.memory_used_bytes)+' / '+fmtB(s.gpu.memory_total_bytes))]:null,
      s.ram_free_bytes!=null?[ct('ram.info'),esc(fmtB(s.ram_free_bytes)+' / '+fmtB(s.ram_total_bytes))]:null]);
  }
  function setupList(){
    const miss=S.missing||[];
    if(!S.link)miss.includes('link')||miss.unshift('link');
    if(!miss.length)return '<p class="kc-note ok">'+esc(ct('setup.done'))+'</p>';
    return '<ul class="kc-setup">'+miss.map(m=>'<li><button type="button" class="kc-link" data-act="goto" data-arg="'+(m==='link'||m==='revoked'?'devices':'data')+'">'+esc(ct('setup.'+m))+'</button></li>').join('')+'</ul>';
  }
  function participate(){
    const p=S.policy,on=S.participation&&!S.consent.required;
    const slider=(k,label,note,max=100,stepv=5,unit='%')=>'<label class="kc-slider"><span>'+esc(label)+' <b id="v_'+k+'">'+(unit==='h'?esc(ct('hours.unit',{n:p[k]})):p[k]+unit)+'</b></span><input type="range" min="'+(unit==='h'?1:0)+'" max="'+max+'" step="'+stepv+'" value="'+p[k]+'" data-pol="'+k+'" data-unit="'+unit+'"><small class="kc-note">'+esc(note)+'</small></label>';
    const chk=(k,label,dis)=>'<label class="kc-check"><input type="checkbox" data-pol="'+k+'"'+(p[k]?' checked':'')+(dis?' disabled':'')+'> '+esc(label)+'</label>';
    const num=(k,label,min,max,stepv=1)=>'<label class="kc-field"><span>'+esc(label)+'</span><input type="number" min="'+min+'" max="'+max+'" step="'+stepv+'" value="'+esc(p[k])+'" data-pol="'+k+'"></label>';
    let h=card('','<div class="kc-toggle-row"><div><strong>'+esc(ct('toggle'))+'</strong><small class="kc-note">'+esc(ct('card.subtitle'))+' · '+esc(ct('toggle.note'))+'</small></div><label class="kc-switch"><input type="checkbox" id="kcToggle" data-act-change="toggle"'+(on?' checked':'')+(busy?' disabled':'')+'><span></span></label></div>'
      +L('status',statusLine)+L('setup',setupList)
      +'<div class="kc-actions">'+btn(S.manual_pause?'resume':'pause',ct(S.manual_pause?'btn.resume':'btn.pause'),{disabled:!S.participation})+btn('stop',ct('btn.stop'),{disabled:!S.link&&!S.participation})+btn('diag',ct('btn.diag'))+'</div>'+msg('diag'));
    h+='<div class="kc-grid">'+card(ct('limits'),slider('gpu_target_pct',ct('gpu'),ct('gpu.note'))+slider('cpu_target_pct',ct('cpu'),ct('cpu.note'))+slider('daily_hours',ct('hours'),'',p.extended_hours?24:12,1,'h')
      +chk('only_idle',ct('only_idle'))+chk('only_ac',ct('only_ac'))+chk('pause_on_games',ct('pause_on_games'))+chk('pause_on_local_ai',ct('pause_on_local_ai'))+chk('pause_on_fullscreen',ct('pause_on_fullscreen'))
      +'<details class="kc-adv"><summary>'+esc(ct('advanced'))+'</summary><label class="kc-field"><span>'+esc(ct('profile'))+'</span><select data-pol="profile">'+['gentle','custom','full'].map(x=>'<option value="'+x+'"'+(p.profile===x?' selected':'')+'>'+esc(ct('profile.'+x))+'</option>').join('')+'</select></label>'
      +chk('extended_hours',ct('extended_hours'))+num('idle_minutes',ct('idle_minutes'),1,120)+num('min_free_ram_gib',ct('min_free_ram_gib'),0,256,0.5)+num('temp_limit_c',ct('temp_limit_c'),50,95)+num('daily_traffic_mb',ct('daily_traffic_mb'),10,1e6,10)+chk('allow_metered',ct('allow_metered'))
      +'<div class="kc-quiet"><label class="kc-check"><input type="checkbox" data-pol="quiet_hours.enabled"'+(p.quiet_hours.enabled?' checked':'')+'> '+esc(ct('quiet'))+'</label><label>'+esc(ct('quiet.from'))+' <input type="time" data-pol="quiet_hours.from" value="'+esc(p.quiet_hours.from)+'"></label><label>'+esc(ct('quiet.to'))+' <input type="time" data-pol="quiet_hours.to" value="'+esc(p.quiet_hours.to)+'"></label></div>'
      +'<label class="kc-check"><input type="checkbox" disabled> '+esc(ct('background'))+'</label><small class="kc-note">'+esc(ct('background.note'))+'</small></details><p class="kc-note">'+esc(ct('sensors.note'))+'</p>'+msg('policy'))
      +'<div>'+card(ct('nominal'),'<div class="kc-big" id="kcNominal">'+esc(S.nominal_monthly_hours)+' '+esc(lang()==='ru'?'ч':'h')+'</div><p class="kc-note">'+esc(ct('nominal.note'))+'</p>')
      +card(ct('measured'),L('measured',measuredBlock)+L('sensors',sensorsBlock))
      +(S.consent.current?card('','<p class="kc-note">'+esc(ct('consent.given',{d:when(S.consent.current.accepted_at),p:S.consent.current.project_id}))+'</p>'+btn('consent-revoke',ct('consent.revoke'))):'')+'</div></div>';
    h+='<p class="kc-note">'+esc(ct('data.privacy'))+'</p>'+btn('feature-off',ct('feature.disable'));
    return h;
  }
  function collectPolicy(){
    const p=JSON.parse(JSON.stringify(S.policy));
    body().querySelectorAll('[data-pol]').forEach(el=>{
      const k=el.dataset.pol;let v=el.type==='checkbox'?el.checked:el.type==='range'||el.type==='number'?Number(el.value):el.value;
      if(k.startsWith('quiet_hours.'))p.quiet_hours[k.slice(12)]=v;else p[k]=v;
    });
    if(p.daily_hours>(p.extended_hours?24:12))p.daily_hours=p.extended_hours?24:12;
    return p;
  }
  // ---------- consent ----------
  function consentDialog(){
    const c=S.consent.text,d=document.getElementById('computeConsent');
    d.innerHTML='<form method="dialog"><h2>'+esc(ct('consent.title'))+'</h2>'+kv([[ct('consent.project'),esc(c.project_id)],[ct('consent.endpoint'),esc(c.endpoint)],[ct('consent.fingerprint'),'<code>'+esc(c.fingerprint)+'</code>']])
      +'<ul class="kc-facts">'+Object.values(c.facts).map(f=>'<li>'+esc(f)+'</li>').join('')+'<li>'+esc(ct('consent.weights'))+'</li><li>'+esc(ct('consent.autostart'))+'</li></ul>'
      +(c.remote?'<label class="kc-check warn"><input type="checkbox" id="kcRemote"> '+esc(ct('consent.remote'))+'</label>':'')
      +'<label class="kc-check"><input type="checkbox" id="kcAgree"> '+esc(ct('consent.agree'))+'</label><p class="kc-note">'+esc(ct('consent.revision',{r:c.text_revision}))+'</p>'
      +'<div class="dialog-actions"><button class="secondary" value="cancel">'+esc(ct('consent.cancel'))+'</button><button class="primary kc-btn" id="kcAccept" value="ok" disabled>'+esc(ct('consent.accept'))+'</button></div></form>';
    const upd=()=>{d.querySelector('#kcAccept').disabled=!(d.querySelector('#kcAgree').checked&&(!c.remote||d.querySelector('#kcRemote').checked));};
    d.querySelectorAll('input').forEach(i=>i.onchange=upd);
    d.onclose=()=>{if(d.returnValue==='ok')run(()=>call('consent/accept',{text_revision:c.text_revision,project_id:c.project_id,allow_remote:c.remote?true:undefined}));else render(true);};
    d.returnValue='';d.showModal();
  }
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
        +'<small>'+esc([d.heartbeat_age_ms!=null?ct('dev.hb',{s:Math.round(d.heartbeat_age_ms/1000)}):null,s.state?s.state+(s.reason?' ('+reason(s.reason)+')':''):null,ct('measured.tasks')+': '+(d.accepted_count||0),m.tokens_per_s?m.tokens_per_s.toFixed(1)+' tok/s':null,m.step_s?m.step_s.toFixed(2)+' s/step':null].filter(Boolean).join(' · '))+'</small></span><span class="kc-actions">'+acts+'</span></li>';
    }).join('')+'</ul>';
  }
  function labInfo(){
    const i=S.lab?.info;
    if(!i?.running)return '<p class="kc-note">'+esc(ct('lab.stopped'))+'</p>';
    return '<p><span class="badge ok">'+esc(ct('lab.running',{e:i.endpoint}))+'</span></p>'+kv([[ct('consent.fingerprint'),'<code>'+esc(i.fingerprint)+'</code>'],[ct('consent.project'),esc(i.project_id||'')]]);
  }
  function devices(){
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
  function lab(){
    if(!S.lab?.info?.running&&!S.lab?.experiments?.length)return card('','<p>'+esc(ct('lab.need'))+'</p>'+btn('goto',ct('tab.devices'),{arg:'devices'}));
    const l=S.lab,prof=S.profile.id;
    const variants=l.variants.filter(v=>v.profile_id===prof);
    let h='<div class="kc-grid">'+card(ct('lab.models'),(variants.length?'<ul class="dev-list">'+variants.map(v=>'<li><span><strong>'+esc(v.variant_id)+'</strong><small>'+esc(short(v.files_digest))+'</small></span><span class="badge'+(v.provenance==='verified'?' ok':'')+'">'+esc(ct(v.provenance==='verified'?'prov.verified':'prov.unverified'))+'</span></li>').join('')+'</ul>':'<p class="kc-note">'+esc(ct('lab.noModels'))+'</p>')
      +btn('register-model',ct('lab.registerModel'),{disabled:!S.model?.architecture_ok})+reportedVariants(variants)+msg('model'))
      +card(ct('lab.datasets'),(l.datasets.length?'<ul class="dev-list">'+l.datasets.map(d=>'<li><span><strong>'+esc(d.id)+'</strong><small>'+esc(Object.entries(d.split_counts||{}).map(([k,v])=>k+': '+v).join(' · '))+' · '+esc(d.license||'')+' · max '+esc(d.max_length)+'</small></span>'+(d.synthetic?'<span class="badge">'+esc(ct('lab.synthetic'))+'</span>':'')+'</li>').join('')+'</ul>':'<p class="kc-note">'+esc(ct('lab.noDatasets'))+'</p>')
        +'<details><summary>'+esc(ct('lab.import'))+'</summary>'+field('kcDsFile',ct('lab.file'),'',{browse:'file',wide:true})+'<div class="kc-row">'+field('kcDsId',ct('lab.dsid'),'')+field('kcDsRev',ct('lab.rev'),'1')+'</div>'+btn('import-dataset',ct('lab.import'))+'</details>'
        +btn('import-fixture',ct('lab.importFixture'))+msg('dataset'))+'</div>';
    const pv=S.profile.variants||[];
    const vlist=pv.length?pv:variants.map(v=>v.variant_id);
    h+=card(ct('lab.new'),'<p class="kc-note">'+esc(ct('lab.new.note'))+'</p><div class="kc-form">'
      +field('kcName',ct('lab.name'),'',{wide:true})
      +'<label class="kc-field"><span>'+esc(ct('lab.preset'))+'</span><select id="kcPreset">'+['smoke','pilot','research'].map(x=>'<option value="'+x+'">'+esc(ct('preset.'+x))+'</option>').join('')+'</select></label>'
      +'<label class="kc-field"><span>'+esc(ct('lab.dataset'))+'</span><select id="kcDataset">'+l.datasets.map(d=>'<option>'+esc(d.id)+'</option>').join('')+'</select></label>'
      +'<fieldset class="kc-field wide"><legend>'+esc(ct('lab.variants'))+'</legend>'+vlist.map(v=>'<label class="kc-check"><input type="checkbox" class="kcVar" id="kcVar_'+esc(v)+'" value="'+esc(v)+'"'+(variants.find(x=>x.variant_id===v)?' checked':'')+'> '+esc(v)+'</label>').join('')+'</fieldset>'
      +field('kcRounds',ct('lab.rounds'),'',{type:'number',placeholder:'2'})+field('kcSteps',ct('lab.steps'),'',{type:'number',placeholder:'3'})
      +'<label class="kc-field"><span>'+esc(ct('lab.optimizer'))+'</span><select id="kcOpt"><option>sgd</option><option>adamw</option></select></label>'+field('kcLr',ct('lab.lr'),'',{placeholder:'0.001'})
      +'<label class="kc-field"><span>'+esc(ct('lab.maxlen'))+'</span><select id="kcMaxLen"><option>256</option><option disabled>'+esc(ct('lab.ctx512'))+'</option></select></label>'
      +'<label class="kc-field"><span>'+esc(ct('lab.quorum'))+'</span><select id="kcQMode"><option value="">'+esc(ct('lab.preset'))+'</option><option value="all">'+esc(ct('quorum.all'))+'</option><option value="fault_tolerant">'+esc(ct('quorum.ft'))+'</option></select></label>'
      +field('kcQMin',ct('lab.qmin'),'',{type:'number'})+field('kcQTarget',ct('lab.qtarget'),'',{type:'number',placeholder:'3'})+field('kcDeadline',ct('lab.deadline'),'',{type:'number',placeholder:'600'})+field('kcSeed',ct('lab.seed'),'',{type:'number',placeholder:'20261126'})+field('kcEvalEvery',ct('lab.evalEvery'),'',{type:'number'})
      +'<label class="kc-check wide"><input type="checkbox" id="kcResearch"> '+esc(ct('lab.research'))+'</label></div>'
      +'<div class="kc-actions">'+btn('dry-run',ct('lab.dryRun'))+btn('create',ct('lab.create'),{primary:true,disabled:!plan})+'</div>'+msg('plan')
      +(plan?'<p class="kc-note">'+esc(ct('lab.plan',{tasks:plan.tasks,rows:plan.rows_per_task,tokens:plan.supervised_tokens_total,params:plan.trainable_params.toLocaleString(lang()),targets:plan.targets,r:plan.rank,a:plan.alpha}))+'</p><p class="kc-note"><code>config '+esc(short(plan.config_hash))+' · frozen A '+esc(short(plan.frozen_a_hash))+'</code></p>'
        +(!plan.research_pass_possible?'<p class="kc-msg bad">'+esc(ct('lab.planWarn',{why:[plan.dataset.synthetic?ct('lab.synthetic'):null,plan.model_variants.some(v=>v.provenance!=='verified')?ct('lab.unverified'):null].filter(Boolean).join(', ')}))+'</p>':''):''));
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
      a.push(btn('exp-report',ct('exp.report'),{arg:e.id}),btn('exp-peft',ct('exp.peft'),{arg:e.id,disabled:!e.committed_rounds}),btn('exp-monitor',ct('tab.monitor'),{arg:e.id}));
      return '<li><span><strong>'+esc(e.name)+'</strong> <span class="badge'+(e.state==='COMPLETED'?' ok':'')+'">'+esc(e.state)+'</span><small>'+esc(e.run_id)+' · '+esc(e.config.preset)+' · '+esc(e.committed_rounds)+'/'+esc(e.target_rounds)+' · '+esc(when(e.created_at))+'</small></span><span class="kc-actions">'+a.join('')+'</span></li>';
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
    let h=kv([[ct('mon.rounds'),esc(e.committed_rounds+' / '+e.target_rounds)],[ct('col.state'),'<span class="badge">'+esc(e.state)+'</span>'],
      r?[ct('mon.round'),esc('#'+r.idx+' · attempt '+r.attempt+' · '+r.state+' · base '+short(r.parent_hash))]:null,r?[ct('mon.accepted'),esc(r.accepted+' / '+r.min_quorum+'–'+r.target+' (leased '+r.leased+')')]:null,
      r&&e.state==='RUNNING'?[ct('mon.deadline'),esc(fmtMs(r.remaining_ms))]:null,['config','<code>'+esc(short(e.config_hash))+'</code> · frozen A <code>'+esc(short(e.frozen_a_hash))+'</code>']]);
    const bl=e.blocker||r?.blocker;if(bl)h+='<p class="kc-msg bad">'+esc(ct('mon.blocker',{r:bl.reason||bl.code||JSON.stringify(bl),a:r?.accepted??0,m:r?.min_quorum??'?'}))+'</p>';
    if(r?.slots?.length)h+='<h4>'+esc(ct('mon.slots'))+'</h4><ul class="dev-list">'+r.slots.map(s=>{const dev=(S.lab?.devices||[]).find(d=>d.id===s.device_id);const pr=s.progress||{};return '<li><span>slot '+s.slot+' · <strong>'+esc(dev?.alias||s.device_id||ct('none'))+'</strong><small>'+esc(s.state+(s.task_state?' / '+s.task_state:'')+' · '+s.expected_tokens+' tok'+(pr.step!=null?' · step '+pr.step+'/'+(pr.steps??'?'):''))+'</small></span>'+(pr.step!=null&&pr.steps?'<progress max="'+pr.steps+'" value="'+pr.step+'"></progress>':'')+'</li>';}).join('')+'</ul>';
    const ev=e.eval||{},pts=Object.entries(ev.rounds||{}).filter(([,v])=>Number.isFinite(v.nll)).map(([k,v])=>[Number(k),v.nll]).sort((a,b)=>a[0]-b[0]);
    h+='<h4>'+esc(ct('mon.eval'))+'</h4>'+(pts.length?chart(pts)+'<table class="kc-table"><tr><th>'+esc(ct('col.round'))+'</th><th>NLL</th><th>PPL</th><th>tokens</th><th>acc</th></tr>'+Object.entries(ev.rounds).map(([k,v])=>'<tr><td>'+esc(k)+'</td><td>'+esc(v.nll!=null?v.nll.toFixed(6):v.status)+'</td><td>'+esc(v.perplexity!=null?v.perplexity.toFixed(3):'')+'</td><td>'+esc(v.tokens??'')+'</td><td>'+esc(v.token_accuracy!=null?(v.token_accuracy*100).toFixed(1)+'%':'')+'</td></tr>').join('')+'</table>':'<p class="kc-note">'+esc(ev.status||ct('mon.noEval'))+'</p>')
      +(ev.gate?'<p class="kc-msg'+(ev.gate.passed?'':' bad')+'">'+esc(ct('mon.gate',{r:ct(ev.gate.passed?'gate.pass':'gate.fail')+' ('+(ev.gate.rel_change*100).toFixed(2)+'%)'}))+'</p>':'');
    h+='<h4>'+esc(ct('mon.table'))+'</h4><div class="kc-scroll"><table class="kc-table"><tr><th>'+['col.round','col.state','col.base','col.updates','col.tokens','col.excluded','col.duration','col.ckpt'].map(k=>esc(ct(k))).join('</th><th>')+'</th></tr>'
      +rounds.map(x=>{const acc=x.accepted||[],exc=x.excluded||[];return '<tr><td>'+x.idx+'.'+x.attempt+'</td><td>'+esc(x.state)+'</td><td><code>'+esc(short(x.parent_hash))+'</code></td><td>'+acc.length+'</td><td>'+esc(acc.map(a=>a.weight??a.tokens).join(' + '))+'</td><td>'+esc(exc.map(a=>'slot '+a.slot+': '+a.reason).join('; '))+'</td><td>'+esc(fmtMs(x.duration_ms))+(x.aggregation_ms!=null?' (agg '+x.aggregation_ms+' ms)':'')+'</td><td><code>'+esc(short(x.checkpoint_hash))+'</code></td></tr>';}).join('')+'</table></div>';
    return h;
  }
  function eventsBlock(){
    const loc=(S.events||[]).slice(-30).reverse(),co=coordEvents.slice(-30).reverse();
    const li=e=>'<li class="lvl-'+esc(e.level)+'"><time>'+esc(new Date(e.ts).toLocaleTimeString(lang()))+'</time> <code>'+esc(e.code)+'</code> '+esc(JSON.stringify(e.details||{}).slice(0,160))+'</li>';
    return '<div class="kc-grid"><div><h4>'+esc(ct('mon.local'))+'</h4><ul class="kc-events">'+loc.map(li).join('')+'</ul></div><div><h4>'+esc(ct('lab.local'))+'</h4><ul class="kc-events">'+co.map(li).join('')+'</ul></div></div>';
  }
  function monitor(){
    const ex=S.lab?.experiments||[];
    let h=card('',(ex.length?'<label class="kc-field"><span>'+esc(ct('mon.choose'))+'</span><select id="kcExpSel" data-act-change="select-exp">'+ex.map(e=>'<option value="'+esc(e.id)+'"'+(e.id===selExp?' selected':'')+'>'+esc(e.name+' · '+e.run_id+' · '+e.state)+'</option>').join('')+'</select></label>'+btn('rounds-json',ct('mon.exportJson'),{disabled:!expData}):'')+L('mon',monitorLive));
    h+=card(ct('mon.events'),L('events',eventsBlock));
    return h;
  }
  // ---------- Models & data ----------
  function data(){
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
  // ---------- actions ----------
  const val=id=>body().querySelector('#'+id)?.value?.trim()||'';
  const numv=id=>{const v=val(id);return v===''?undefined:Number(v);};
  const note=(k,text,bad)=>{lastResult[k]={text,bad};};
  async function run(fn,key){
    if(busy)return;busy=true;body().querySelectorAll('button,input,select').forEach(el=>el.disabled=true);
    try{const r=await fn();if(r&&typeof r==='object'&&'state' in r&&'policy' in r)S={feature_enabled:true,...r};return r;}
    catch(e){if(key)note(key,e.message,true);else toast(e.message);}
    finally{busy=false;await refresh(true);}
  }
  async function pickDir(){if(!desktop())return null;return desktop().chooseFolder('other');}
  function experimentConfig(){
    const qm=val('kcQMode'),cfg={name:val('kcName'),preset:val('kcPreset'),dataset_id:val('kcDataset'),variants:[...body().querySelectorAll('.kcVar:checked')].map(i=>i.value),
      rounds:numv('kcRounds'),local_steps:numv('kcSteps'),seed:numv('kcSeed'),round_deadline_s:numv('kcDeadline'),max_length:256,research_confirmed:body().querySelector('#kcResearch')?.checked===true};
    const lr=val('kcLr');cfg.optimizer={name:val('kcOpt')||'sgd',...(lr?{lr:Number(lr)}:{})};
    if(qm)cfg.quorum={mode:qm,target:numv('kcQTarget')??3,min:numv('kcQMin')};
    const ee=numv('kcEvalEvery');if(ee!==undefined)cfg.eval={every:ee};
    return cfg;
  }
  const acts={
    'feature-on':()=>run(async()=>{await api('/api/compute/v2/feature',{enabled:true});}),
    'feature-off':()=>run(async()=>{await api('/api/compute/v2/feature',{enabled:false});tab='participate';}),
    goto:el=>{tab=el.dataset.arg;render(true);},
    toggle:el=>{
      if(el.checked){
        el.checked=false;
        if(!S.link){tab='devices';toast(ct('setup.link'));render(true);return;}
        if(S.consent.required)return consentDialog();
        run(()=>call('participation',{enabled:true}));
      }else run(()=>call('participation',{enabled:false}));
    },
    pause:()=>run(()=>call('pause',{})),resume:()=>run(()=>call('resume',{})),
    stop:()=>{if(confirm(ct('confirm.stop')))run(async()=>{await call('participation',{enabled:false});return call('link/forget',{});});},
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
    'lab-pairing':()=>run(async()=>{pairing=await call('lab/pairing',{});},'lab'),
    'lab-join':()=>run(()=>call('lab/join-self',{}),'lab'),
    'copy-code':()=>{navigator.clipboard?.writeText(pairing?.pairing||'').then(()=>toast(ct('copied')),()=>{});},
    'dev-approve':el=>run(()=>call('lab/approve',{id:el.dataset.arg}),'lab'),
    'dev-revoke':el=>{if(confirm(ct('dev.confirmRevoke')))run(()=>call('lab/revoke',{id:el.dataset.arg}),'lab');},
    'dev-drain':el=>{const [id,on]=el.dataset.arg.split('|');run(()=>call('lab/drain',{id,on:on==='true'}),'lab');},
    'dev-rename':el=>{const a=prompt(ct('dev.renamePrompt'));if(a)run(()=>call('lab/rename',{id:el.dataset.arg,alias:a}),'lab');},
    'register-model':()=>run(async()=>{await call('lab/register-model',{});note('model',ct('saved'));},'model'),
    'register-device-model':el=>{const [device_id,variant_id]=el.dataset.arg.split('|');run(async()=>{await call('lab/register-model',{device_id,variant_id});note('model',ct('saved'));},'model');},
    'import-fixture':()=>run(async()=>{const r=await call('lab/import-dataset',{fixture:true});note('dataset',ct('saved')+': '+(r.id||r.dataset_id||''));},'dataset'),
    'import-dataset':()=>run(async()=>{const r=await call('lab/import-dataset',{file:val('kcDsFile'),dataset_id:val('kcDsId'),revision:val('kcDsRev')||'1'});note('dataset',ct('saved')+': '+(r.id||r.dataset_id||''));},'dataset'),
    'dry-run':()=>run(async()=>{plan=null;lastResult.plan=null;const cfg=experimentConfig();plan=await call('lab/dry-run',{config:cfg});planInput=cfg;},'plan'),
    create:()=>{if(!plan||!planInput)return;if(!confirm(ct('lab.confirmStart',{n:plan.config.name,t:plan.tasks})))return;
      run(async()=>{const e=await call('lab/create',{config:planInput});for(const k of Object.keys(form))if(/^kc(Name|Rounds|Steps|Lr|Q|Deadline|Seed|EvalEvery|Research|Var_)/.test(k))delete form[k];planInput=null;await call('lab/experiment/start',{id:e.id});selExp=e.id;plan=null;tab='monitor';},'plan');},
    'exp-start':el=>run(()=>call('lab/experiment/start',{id:el.dataset.arg}),'exp'),'exp-pause':el=>run(()=>call('lab/experiment/pause',{id:el.dataset.arg}),'exp'),
    'exp-resume':el=>run(()=>call('lab/experiment/resume',{id:el.dataset.arg}),'exp'),'exp-finish':el=>run(()=>call('lab/experiment/finish',{id:el.dataset.arg}),'exp'),
    'exp-cancel':el=>{if(confirm(ct('exp.confirmCancel')))run(()=>call('lab/experiment/cancel',{id:el.dataset.arg}),'exp');},
    'exp-monitor':el=>{selExp=el.dataset.arg;tab='monitor';refresh(true);},
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
    browse:async el=>{const [id,kind]=el.dataset.arg.split('|');if(!desktop())return;try{const f=kind==='folder'?await desktop().chooseFolder('other'):await desktop().chooseFile('any');if(f){body().querySelector('#'+id).value=f;form[id]=f;}}catch(e){toast(e.message);}}
  };
  // ---------- wiring ----------
  function init(){
    const nav=document.getElementById('openCompute');if(!nav||!root())return;
    nav.addEventListener('click',()=>show(true));
    document.getElementById('computeBack').addEventListener('click',()=>show(false));
    document.getElementById('computeTabs').addEventListener('click',e=>{const b=e.target.closest('[data-tab]');if(b){tab=b.dataset.tab;lastResult={};refresh(true);}});
    root().addEventListener('click',e=>{const b=e.target.closest('[data-act]');if(b&&!b.disabled&&acts[b.dataset.act]){e.preventDefault();acts[b.dataset.act](b);}});
    root().addEventListener('change',e=>{
      const t=e.target;
      if(t.id&&t.dataset.pol===undefined&&!t.dataset.actChange){form[t.id]=t.type==='checkbox'?t.checked:t.value;if(t.closest('.kc-form'))plan=null;}
      if(t.dataset.actChange&&acts[t.dataset.actChange])return acts[t.dataset.actChange](t);
      if(t.dataset.pol!==undefined){const p=collectPolicy();run(async()=>{lastResult.policy=null;await call('policy',{policy:p,revision:S.policy.revision});},'policy');}
    });
    root().addEventListener('input',e=>{const t=e.target;if(t.id&&t.dataset.pol===undefined&&t.type!=='checkbox'&&!t.dataset.actChange){form[t.id]=t.value;if(t.closest('.kc-form')&&plan){plan=null;const cb=body().querySelector('[data-act=create]');if(cb)cb.disabled=true;}}if(t.type==='range'&&t.dataset.pol){const o=document.getElementById('v_'+t.dataset.pol);if(o)o.textContent=t.dataset.unit==='h'?ct('hours.unit',{n:t.value}):t.value+t.dataset.unit;
      if(t.dataset.pol==='gpu_target_pct'||t.dataset.pol==='daily_hours'){const g=Number(body().querySelector('[data-pol=gpu_target_pct]').value),hh=Number(body().querySelector('[data-pol=daily_hours]').value);const n=document.getElementById('kcNominal');if(n)n.textContent=(Math.round(g/100*hh*30*10)/10)+' '+(lang()==='ru'?'ч':'h');}}});
    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&open&&!document.querySelector('dialog[open]'))show(false);});
    const ic=document.getElementById('computeIcon');if(ic)ic.innerHTML='<svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/></svg>';
  }
  window.kvCompute={show,refresh};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
