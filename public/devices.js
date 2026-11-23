// Settings → Devices: share this device, pair other computers, distribute tasks, pool memory (llama.cpp RPC).
// Uses globals from app.js: $, t, esc, api, toast, busy.
(function(){
  const dialog=$('#devicesDialog'),bodyEl=$('#devicesBody'),errorEl=$('#devicesError');
  let tab='this',data=null,timer=null,gguf=null,ggufBlobs='',ggufLoading=false,pairTarget=null;
  // Unsaved choices on the Pool tab. The tab is re-rendered every few seconds; without this a picked model was lost.
  let poolDraft=null;
  const BACKEND_KEYS={auto:'devices.backend.auto',cpu:'devices.backend.cpu',vulkan:'devices.backend.vulkan',cuda:'devices.backend.cuda',metal:'devices.backend.metal'};
  const LOCAL_KEYS=['devices.local.0','devices.local.1','devices.local.2'];
  const STATE_KEYS={stopped:'devices.state.stopped',starting:'devices.state.starting',loading:'devices.state.loading',running:'devices.state.running',error:'devices.state.error'};
  const mb=n=>(n/1048576).toFixed(1);
  const gb=mib=>(mib/1024).toFixed(1);
  const when=ms=>ms?new Date(ms).toLocaleString(kvI18n.lang,{dateStyle:'short',timeStyle:'short'}):'—';
  const busyField=()=>{const a=document.activeElement;return a&&bodyEl.contains(a)&&/^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)&&a.type!=='checkbox';};
  async function call(route,payload){
    errorEl.textContent='';
    try{const r=await api('/api/devices'+route,payload);if(r&&r.self)data=r;render();return r;}
    catch(e){errorEl.textContent=e.message;throw e;}
  }
  async function refresh(force){
    try{const r=await api('/api/devices');data=r;if(force||!busyField())render();}catch(e){errorEl.textContent=e.message;}
  }
  function open(next){
    if(next)tab=next;
    poolDraft=null;dialog.showModal();refresh(true);
    clearInterval(timer);timer=setInterval(()=>{if(dialog.open)refresh(false);else clearInterval(timer);},2500);
  }
  window.openDevices=open;window.renderDevices=()=>{if(dialog.open)render();};
  dialog.addEventListener('close',()=>clearInterval(timer));
  for(const b of dialog.querySelectorAll('.tab'))b.onclick=()=>{tab=b.dataset.tab;render();};
  async function loadGguf(){if(ggufLoading)return;ggufLoading=true;try{const r=await api('/api/devices/gguf');gguf=r.models||[];ggufBlobs=r.blobs||'';}catch{gguf=[];}finally{ggufLoading=false;}if(dialog.open&&tab==='pool')render();}
  function readPoolForm(){
    const q=s=>bodyEl.querySelector(s);if(!q('#poolGguf'))return poolDraft;
    return {gguf:q('#poolGguf').value,file:q('#poolModel').value.trim(),ctx:Number(q('#poolCtx').value),localGpu:q('#poolLocal').checked,workers:[...bodyEl.querySelectorAll('[data-worker]:checked')].map(x=>x.dataset.worker)};
  }
  const dot=s=>'<span class="status-dot '+(s===true?'ok':s===false?'bad':'wait')+'"></span>';
  const sw=(id,key,note,checked)=>'<label class="switch-row"><span><strong data-i18n="'+key+'"></strong><small>'+note+'</small></span><input type="checkbox" id="'+id+'"'+(checked?' checked':'')+'></label>';

  function renderThis(){
    const s=data.share,l=data.llama,backendName=settings.provider==='openai'?t('settings.provider.openai'):'Ollama';
    let h='<section class="dev-card">'+sw('shareEnabled','devices.share',esc(t('devices.shareNote')),s.enabled);
    h+='<div class="settings-row"><label><span data-i18n="devices.name"></span><input id="devName" value="'+esc(data.self.name)+'" maxlength="64"></label><label class="narrow"><span data-i18n="devices.port"></span><input id="sharePort" type="number" min="1024" max="65535" value="'+s.port+'"></label></div>';
    if(s.enabled){
      h+='<div class="pair-code"><div><span data-i18n="devices.code"></span><code id="pairCode">'+esc(s.code)+'</code></div><button type="button" class="secondary" id="newCode" data-i18n="devices.newCode"></button></div>';
      h+='<p class="field-note">'+dot(s.listening)+'<span data-i18n="'+(s.listening?'devices.listening':'devices.notListening')+'"></span> · <span data-i18n="devices.addresses"></span>: '+(s.addresses.map(a=>'<code>'+esc(a.address)+':'+a.port+'</code>').join(' ')||'—')+'</p>';
      if(s.error)h+='<p class="form-error">'+esc(s.error)+'</p>';
      h+='<label class="check-row"><input type="checkbox" id="shareTasks"'+(s.tasks?' checked':'')+'><span><strong data-i18n="devices.shareTasks"></strong><small>'+esc(t('devices.shareTasksNote',{backend:backendName}))+'</small></span></label>';
      h+='<label class="check-row"><input type="checkbox" id="shareRpc"'+(s.rpc?' checked':'')+'><span><strong data-i18n="devices.shareRpc"></strong><small data-i18n="devices.shareRpcNote"></small></span></label>';
      if(s.rpc)h+='<p class="field-note">'+dot(data.rpc.running)+'<span data-i18n="'+(data.rpc.running?'devices.rpcRunning':'devices.rpcStopped')+'"></span>'+(data.rpc.error?' — <span class="error-text">'+esc(data.rpc.error)+'</span>':'')+'</p>';
      h+='<h4 data-i18n="devices.hosts"></h4>';
      h+=s.hosts.length?'<ul class="dev-list">'+s.hosts.map(x=>'<li><span><strong>'+esc(x.name)+'</strong><small>'+esc(x.address||'')+' · '+esc(t('devices.lastSeen',{time:when(x.lastSeen)}))+'</small></span><button type="button" class="secondary small" data-revoke="'+esc(x.id)+'" data-i18n="devices.revoke"></button></li>').join('')+'</ul>':'<p class="field-note" data-i18n="devices.noHosts"></p>';
      h+='<p class="field-note note-box">'+esc(t('devices.firewall',{port:s.port}))+'</p>';
    }
    h+='</section><section class="dev-card"><h3 data-i18n="devices.llama"></h3><p class="field-note">'+esc(t('devices.llamaNote',{build:l.build}))+'</p>';
    const inst=l.installed;
    h+='<p>'+dot(!!inst)+(inst?(l.path?esc(t('devices.llamaCustom',{path:l.path})):esc(t('devices.llamaInstalled',{build:inst.build,backend:inst.backend}))):'<span data-i18n="devices.llamaMissing"></span>')+'</p>';
    if(l.supported){
      const opts=['auto','cpu','vulkan','cuda','metal'].filter(b=>data.self.platform==='darwin'?['auto','metal'].includes(b):b!=='metal');
      h+='<div class="settings-row align-end"><label><span data-i18n="devices.llamaBackend"></span><select id="llamaBackend">'+opts.map(b=>'<option value="'+b+'"'+(l.backend===b?' selected':'')+' data-i18n="'+BACKEND_KEYS[b]+'"></option>').join('')+'</select></label><button type="button" class="secondary" id="llamaInstall" data-i18n="devices.download"'+(l.install.state==='downloading'?' disabled':'')+'></button></div>';
      if(l.install.state==='downloading'){const pct=l.install.expected?Math.round(l.install.received/l.install.expected*100):0;h+='<div class="progress"><i style="width:'+pct+'%"></i></div><p class="field-note">'+esc(t('devices.downloading',{done:mb(l.install.received),total:l.install.expected?mb(l.install.expected):'?'}))+'</p>';}
      if(l.install.state==='error')h+='<p class="form-error">'+esc(l.install.error)+'</p>';
    }else h+='<p class="field-note" data-i18n="devices.unsupported"></p>';
    h+='<div class="settings-row align-end"><label><span data-i18n="devices.llamaPath"></span><input id="llamaPath" value="'+esc(l.path||'')+'" placeholder="'+(data.self.platform==='win32'?'C:\\llama.cpp':'/opt/llama.cpp/build/bin')+'"></label><button type="button" class="secondary" id="llamaPathSave" data-i18n="devices.usePath"></button></div></section>';
    return h;
  }
  function nodeRow(n){
    const s=n.status||{},models=s.models||[];
    const kindKey={kvalah:'devices.kind.kvalah',ollama:'devices.kind.ollama',openai:'devices.kind.openai'}[n.kind];
    let h='<li class="node-row" data-node="'+esc(n.id)+'"><div class="node-main">'+dot(s.online)+'<span><strong>'+esc(n.name)+'</strong><small>'+esc(t(kindKey))+' · '+esc(n.url.replace(/^https?:\/\//,''))+'</small></span>';
    h+='<span class="node-stats">'+(s.online===true?esc(t('devices.online'))+(s.latencyMs!=null?' · '+esc(t('devices.latency',{ms:s.ewmaMs??s.latencyMs})):'')+' · '+esc(t('devices.modelsCount',{n:models.length}))+' · '+esc(t('devices.load',{n:s.inflight||0,max:n.maxParallel})):s.online===false?'<span class="error-text">'+esc(t('devices.offline'))+(s.error?': '+esc(s.error):'')+'</span>':esc(t('devices.checking')))+'</span></div>';
    h+='<div class="node-controls"><label class="chip"><input type="checkbox" data-field="tasks"'+(n.tasks?' checked':'')+'><span data-i18n="devices.useTasks"></span></label>';
    if(n.kind==='kvalah')h+='<label class="chip"><input type="checkbox" data-field="memory"'+(n.memory?' checked':'')+'><span data-i18n="devices.useMemory"></span></label>';
    h+='<select data-field="model" aria-label="'+esc(t('devices.poolModel'))+'"><option value="" data-i18n="devices.sameModel"></option>'+models.map(m=>'<option value="'+esc(m)+'"'+(n.model===m?' selected':'')+'>'+esc(m)+'</option>').join('')+(n.model&&!models.includes(n.model)?'<option selected value="'+esc(n.model)+'">'+esc(n.model)+'</option>':'')+'</select>';
    h+='<select data-field="maxParallel" aria-label="'+esc(t('devices.parallel'))+'" title="'+esc(t('devices.parallel'))+'">'+[1,2,3,4].map(v=>'<option value="'+v+'"'+(n.maxParallel===v?' selected':'')+'>×'+v+'</option>').join('')+'</select>';
    h+='<button type="button" class="secondary small" data-remove="'+esc(n.id)+'" data-i18n="devices.remove"></button></div></li>';
    return h;
  }
  function renderNetwork(){
    const tk=data.tasks;
    let h='<section class="dev-card">'+sw('tasksEnabled','devices.tasks',esc(t('devices.tasksNote')),tk.enabled);
    h+='<label><span data-i18n="devices.localParallel"></span><select id="localParallel">'+[0,1,2].map(v=>'<option value="'+v+'"'+(Number(tk.localParallel)===v?' selected':'')+' data-i18n="'+LOCAL_KEYS[v]+'"></option>').join('')+'</select></label></section>';
    h+='<section class="dev-card"><div class="card-head"><h3 data-i18n="devices.found"></h3><button type="button" class="secondary small" id="discoverBtn" data-i18n="devices.search"></button></div>';
    h+=data.discovered.length?'<ul class="dev-list">'+data.discovered.map(d=>'<li><span>'+dot(true)+'<strong>'+esc(d.name)+'</strong><small>'+esc(d.address)+':'+d.port+' · v'+esc(d.version)+(d.modes.tasks?' · '+esc(t('devices.useTasks')):'')+(d.modes.rpc?' · '+esc(t('devices.useMemory')):'')+'</small></span>'+(d.paired?'<span class="badge" data-i18n="devices.paired"></span>':pairTarget===d.id?'<span class="pair-inline"><input id="pairCodeInput" placeholder="'+esc(t('devices.codePlaceholder'))+'" autocomplete="off"><button type="button" class="primary small" data-pair-go="'+esc(d.address)+':'+d.port+'" data-i18n="devices.pair"></button></span>':'<button type="button" class="secondary small" data-pair="'+esc(d.id)+'" data-i18n="devices.pair"></button>')+'</li>').join('')+'</ul>':'<p class="field-note" data-i18n="devices.noneFound"></p>';
    if(data.discoveryError)h+='<p class="form-error">'+esc(data.discoveryError)+'</p>';
    h+='</section><section class="dev-card"><h3 data-i18n="devices.addManual"></h3><div class="settings-row align-end"><label class="narrow"><span data-i18n="devices.kind"></span><select id="addKind"><option value="kvalah" data-i18n="devices.kind.kvalah"></option><option value="ollama" data-i18n="devices.kind.ollama"></option><option value="openai" data-i18n="devices.kind.openai"></option></select></label><label><span data-i18n="devices.address"></span><input id="addAddress" placeholder="192.168.1.20:47317"></label><label><span id="addSecretLabel" data-i18n="devices.secretCode"></span><input id="addSecret" autocomplete="off"></label><button type="button" class="primary" id="addBtn" data-i18n="devices.add"></button></div><p class="field-note hidden" id="ollamaNote" data-i18n="devices.ollamaNote"></p></section>';
    h+='<section class="dev-card"><div class="card-head"><h3 data-i18n="devices.list"></h3><button type="button" class="secondary small" id="checkBtn" data-i18n="devices.checkNow"></button></div>';
    h+=data.nodes.length?'<ul class="dev-list nodes">'+data.nodes.map(nodeRow).join('')+'</ul>':'<p class="field-note" data-i18n="devices.empty"></p>';
    return h+'</section>';
  }
  function renderPool(){
    const p=data.pool,workers=data.nodes.filter(n=>n.kind==='kvalah'&&n.memory),runningish=['starting','loading','running'].includes(p.state);
    const list=gguf||[],byPath=list.find(m=>m.path===p.model);
    const d=poolDraft||{gguf:p.ollamaModel||byPath?.name||'',file:byPath?'':p.model||'',ctx:Number(p.ctx),localGpu:p.localGpu,workers:p.workers};
    let h='<div class="warn-box"><strong data-i18n="devices.poolWarnTitle"></strong><p data-i18n="devices.poolWarn"></p></div>';
    h+='<section class="dev-card"><h3 data-i18n="devices.poolDevices"></h3><label class="check-row"><input type="checkbox" id="poolLocal"'+(d.localGpu?' checked':'')+(runningish?' disabled':'')+'><span><strong data-i18n="devices.poolLocal"></strong><small>'+esc(data.self.name)+'</small></span></label>';
    h+=workers.length?workers.map(n=>{const ready=n.status?.info?.rpc?.running===true;return '<label class="check-row"><input type="checkbox" data-worker="'+esc(n.id)+'"'+(d.workers.includes(n.id)?' checked':'')+(runningish?' disabled':'')+'><span><strong>'+esc(n.name)+'</strong><small>'+dot(ready)+esc(t(ready?'devices.workerReady':'devices.workerNotReady'))+' · '+esc(n.url.replace(/^https?:\/\//,''))+'</small></span></label>';}).join(''):'<p class="field-note" data-i18n="devices.poolNoWorkers"></p>';
    h+='</section><section class="dev-card"><h3 data-i18n="devices.poolModel"></h3>';
    if(!data.llama.installed?.llamaServer)h+='<p class="form-error" data-i18n="devices.poolNeedsLlama"></p>';
    const extra=d.gguf&&!list.some(m=>m.name===d.gguf)?'<option selected value="'+esc(d.gguf)+'">'+esc(d.gguf)+'</option>':'';
    h+='<label><span data-i18n="devices.ollamaGguf"></span><select id="poolGguf"'+(runningish?' disabled':'')+'><option value="" data-i18n="devices.chooseModel"></option>'+list.map(m=>'<option value="'+esc(m.name)+'"'+(d.gguf===m.name?' selected':'')+'>'+esc(m.name)+' · '+(m.size>=1e9?(m.size/1e9).toFixed(1)+' GB':Math.max(1,Math.round(m.size/1e6))+' MB')+'</option>').join('')+extra+'</select></label>';
    h+='<div class="settings-row align-end"><label><span data-i18n="devices.ggufPath"></span><input id="poolModel" value="'+esc(d.file||'')+'" placeholder="model.gguf"'+(runningish?' disabled':'')+'></label>'+(window.kvalahDesktop?.chooseFile?'<button type="button" class="secondary" id="poolBrowse" data-i18n="devices.browse"'+(runningish?' disabled':'')+'></button>':'')+'<label class="narrow"><span data-i18n="devices.poolCtx"></span><select id="poolCtx"'+(runningish?' disabled':'')+'>'+[4096,8192,16384,32768,65536].map(v=>'<option value="'+v+'"'+(Number(d.ctx)===v?' selected':'')+'>'+v/1024+'K</option>').join('')+'</select></label></div>';
    if(ggufBlobs)h+='<p class="field-note">'+esc(t('devices.blobsHint',{dir:ggufBlobs}))+'</p>';
    h+='<div class="dialog-actions left">'+(runningish?'<button type="button" class="secondary" id="poolStop" data-i18n="devices.poolStop"></button>':'<button type="button" class="primary" id="poolStart" data-i18n="devices.poolStart"></button>')+(p.state==='running'?(settings.poolInUse&&settings.baseUrl===p.baseUrl?'<span class="badge ok" data-i18n="devices.poolInUse"></span>':'<button type="button" class="primary" id="poolUse" data-i18n="devices.poolUse"></button>'):'')+'</div>';
    const stateText=p.state==='running'?t('devices.state.running',{url:p.baseUrl}):t(STATE_KEYS[p.state]||STATE_KEYS.stopped);
    h+='<p class="pool-state">'+dot(p.state==='running'?true:p.state==='error'?false:p.state==='stopped'?null:null)+esc(stateText)+'</p>';
    if(p.error)h+='<pre class="form-error pre">'+esc(p.error)+'</pre>';
    for(const w of p.warnings||[])h+='<p class="field-note warn-text">'+esc(w)+'</p>';
    if(p.devices?.length)h+='<ul class="dev-list">'+p.devices.map(d=>'<li><span><strong>'+esc(d.name)+'</strong><small>'+esc(d.device)+' · '+esc(t('devices.memory',{free:gb(d.freeMiB),total:gb(d.totalMiB)}))+'</small></span><span class="badge'+(d.used?' ok':'')+'">'+esc(t(d.used?'devices.inUse':'devices.notUsed'))+'</span></li>').join('')+'</ul>';
    if(p.tunnels?.length){const up=p.tunnels.reduce((s,x)=>s+x.bytesUp,0),down=p.tunnels.reduce((s,x)=>s+x.bytesDown,0);h+='<p class="field-note">'+esc(t('devices.traffic',{up:mb(up),down:mb(down)}))+'</p>';}
    if(p.log?.length)h+='<details><summary data-i18n="devices.log"></summary><pre class="pre">'+esc(p.log.join('\n'))+'</pre></details>';
    return h+'</section>';
  }
  function render(){
    for(const b of dialog.querySelectorAll('.tab')){const on=b.dataset.tab===tab;b.classList.toggle('active',on);b.setAttribute('aria-selected',on);}
    if(!data){bodyEl.innerHTML='';return;}
    bodyEl.innerHTML=tab==='this'?renderThis():tab==='network'?renderNetwork():renderPool();
    kvI18n.apply(bodyEl);bind();
    if(tab==='pool'&&gguf===null)loadGguf();
  }
  const on=(sel,ev,fn)=>{const el=bodyEl.querySelector(sel);if(el)el[ev]=fn;};
  const share=patch=>call('/share',patch).catch(()=>{});
  function bind(){
    on('#shareEnabled','onchange',e=>share({enabled:e.target.checked}));
    on('#shareTasks','onchange',e=>share({tasks:e.target.checked}));
    on('#shareRpc','onchange',e=>share({rpc:e.target.checked}));
    on('#devName','onchange',e=>share({name:e.target.value}));
    on('#sharePort','onchange',e=>share({port:Number(e.target.value)}));
    on('#newCode','onclick',()=>call('/code',{}).catch(()=>{}));
    for(const b of bodyEl.querySelectorAll('[data-revoke]'))b.onclick=()=>call('/hosts/revoke',{id:b.dataset.revoke}).catch(()=>{});
    on('#llamaInstall','onclick',()=>call('/llama/install',{backend:bodyEl.querySelector('#llamaBackend').value}).catch(()=>{}));
    on('#llamaPathSave','onclick',()=>call('/llama/path',{path:bodyEl.querySelector('#llamaPath').value}).then(()=>toast(t('devices.saved'))).catch(()=>{}));
    on('#tasksEnabled','onchange',e=>call('/tasks',{enabled:e.target.checked}).catch(()=>{}));
    on('#localParallel','onchange',e=>call('/tasks',{localParallel:Number(e.target.value)}).catch(()=>{}));
    on('#discoverBtn','onclick',e=>{e.target.disabled=true;call('/discover',{}).catch(()=>{});});
    for(const b of bodyEl.querySelectorAll('[data-pair]'))b.onclick=()=>{pairTarget=b.dataset.pair;render();bodyEl.querySelector('#pairCodeInput')?.focus();};
    for(const b of bodyEl.querySelectorAll('[data-pair-go]'))b.onclick=()=>call('/pair',{address:b.dataset.pairGo,code:bodyEl.querySelector('#pairCodeInput').value}).then(()=>{pairTarget=null;toast(t('devices.pairedToast'));render();}).catch(()=>{});
    const kind=bodyEl.querySelector('#addKind');
    if(kind)kind.onchange=()=>{const k=kind.value;const label=bodyEl.querySelector('#addSecretLabel');label.dataset.i18n=k==='kvalah'?'devices.secretCode':'devices.secretKey';label.textContent=t(label.dataset.i18n);bodyEl.querySelector('#addSecret').closest('label').classList.toggle('hidden',k==='ollama');bodyEl.querySelector('#ollamaNote').classList.toggle('hidden',k!=='ollama');bodyEl.querySelector('#addAddress').placeholder=k==='kvalah'?'192.168.1.20:47317':k==='ollama'?'192.168.1.20:11434':'http://192.168.1.20:8080/v1';};
    on('#addBtn','onclick',()=>{const k=kind.value,address=bodyEl.querySelector('#addAddress').value,secret=bodyEl.querySelector('#addSecret').value;(k==='kvalah'?call('/pair',{address,code:secret}):call('/add',{kind:k,url:address,apiKey:secret})).then(()=>toast(t(k==='kvalah'?'devices.pairedToast':'devices.saved'))).catch(()=>{});});
    on('#checkBtn','onclick',e=>{e.target.disabled=true;call('/check',{}).catch(()=>{});});
    for(const row of bodyEl.querySelectorAll('.node-row')){
      const id=row.dataset.node;
      for(const el of row.querySelectorAll('[data-field]'))el.onchange=()=>{const f=el.dataset.field;call('/node',{id,[f]:el.type==='checkbox'?el.checked:f==='maxParallel'?Number(el.value):el.value}).catch(()=>{});};
    }
    for(const b of bodyEl.querySelectorAll('[data-remove]'))b.onclick=()=>{const n=data.nodes.find(x=>x.id===b.dataset.remove);if(confirm(t('devices.removeConfirm',{name:n?.name||''})))call('/remove',{id:b.dataset.remove}).catch(()=>{});};
    const keepPool=()=>{poolDraft=readPoolForm();};
    for(const el of bodyEl.querySelectorAll('#poolLocal,[data-worker],#poolCtx'))el.addEventListener('change',keepPool);
    on('#poolModel','oninput',e=>{if(e.target.value.trim())bodyEl.querySelector('#poolGguf').value='';keepPool();});
    on('#poolGguf','onchange',e=>{if(e.target.value)bodyEl.querySelector('#poolModel').value='';keepPool();});
    on('#poolBrowse','onclick',async()=>{try{const f=await window.kvalahDesktop.chooseFile('gguf');if(f){bodyEl.querySelector('#poolModel').value=f;bodyEl.querySelector('#poolGguf').value='';keepPool();}}catch(e){toast(e.message);}});
    on('#poolStart','onclick',()=>{const f=readPoolForm();poolDraft=f;call('/pool/start',{workers:f.workers,localGpu:f.localGpu,model:f.file,ollamaModel:f.file?'':f.gguf,ctx:f.ctx}).then(()=>{poolDraft=null;render();}).catch(()=>{});});
    on('#poolStop','onclick',async()=>{await call('/pool/stop',{}).catch(()=>{});try{settings=(await api('/api/state')).settings;if(window.refreshModels)refreshModels();}catch{}render();});
    on('#poolUse','onclick',async()=>{try{settings=await api('/api/devices/pool/use',{});if(window.refreshModels)refreshModels();render();toast(t('devices.poolInUse'));}catch(e){errorEl.textContent=e.message;}});
  }
  $('#openDevices').onclick=()=>{$('#settingsDialog').close();open();};
})();
