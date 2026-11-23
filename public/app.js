const $=s=>document.querySelector(s);
const paths={
 panel:'M3 4h18v16H3z M9 4v16 M5.5 7h1 M5.5 10h1',
 new:'M12 5v14 M5 12h14',
 search:'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
 settings:'M4 7h16 M4 17h16 M8 4v6 M16 14v6',
 refresh:'M20 7v5h-5 M4 17v-5h5 M6 6a8 8 0 0 1 13 2 M18 18A8 8 0 0 1 5 16',
 moon:'M20 15a8 8 0 0 1-11-11 8 8 0 1 0 11 11',
 download:'M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5',
 mic:'M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0z M6 10v1a6 6 0 0 0 12 0v-1 M12 17v4 M8 21h8',
 arrow:'M12 19V5 M6 11l6-6 6 6',
 clip:'M8 12l6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l8-8',
 agent:'M5 8h14v12H5z M9 8V5h6 M9 13h.01 M15 13h.01 M9 17h6 M2 12v4 M22 12v4',
 copy:'M8 8h12v13H8z M16 8V3H3v13h5',
 file:'M14 2H5v20h14V7z M14 2v6h5 M8 12h8 M8 16h6',
 audio:'M4 9h4l5-5v16l-5-5H4z M16 8a6 6 0 0 1 0 8 M19 5a10 10 0 0 1 0 14',
 globe:'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18 M3 12h18 M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9 M12 3c-2.5 2.6-3.8 5.6-3.8 9s1.3 6.4 3.8 9'
};
const icon=n=>'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="'+paths[n]+'"/></svg>';
for(const [selector,name] of Object.entries({'#toggleSide':'panel','#closeSide':'panel','#newIcon':'new','#searchIcon':'search','#settingsIcon':'settings','#refreshModels':'refresh','#themeToggle':'moon','#exportChat':'download','#attach':'clip','#agentIcon':'agent','#mic':'mic','#send':'arrow','#langIcon':'globe'}))$(selector).innerHTML=icon(name);
// Provisional language until the saved choice arrives from /api/state (avoids a flash of the wrong language).
kvI18n.setLang(localStorage.getItem('kvalah-lang')||kvI18n.match(navigator.languages?.length?navigator.languages:[navigator.language]));
const TOOL_NAMES=['list_files','read_file','write_file','edit_file','inspect_project','update_plan','verify_project','finish_task','get_environment','request_access','search_code','find_files','outline_file','append_file','apply_patch','git_status','git_diff','git_commit','parallel_tasks','batch_files'];
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let token='',chats=[],settings={},current=null,pending=[],busy=false,runId=null,agent=localStorage.getItem('kvalah-agent-mode')!=='chat',recognition=null,recording=false;
let connectionState=null,autoScroll=true,lastPaint=0,toastTimer=null,requestController=null;
const projectBar=document.createElement('button');projectBar.className='project-path hidden';projectBar.type='button';projectBar.title=t('project.copyPath');$('header').after(projectBar);
projectBar.onclick=()=>{const p=currentChat()?.project?.path;if(p)copyText(p);};
const projectStrip=document.createElement('div');projectStrip.className='project-strip hidden';projectBar.replaceWith(projectStrip);
const projectReview=document.createElement('button');projectReview.className='project-review';projectReview.textContent=t('project.review');
const projectOpen=document.createElement('button');projectOpen.className='project-review';projectOpen.type='button';projectOpen.textContent=t('project.open');projectOpen.title=t('project.openHint');
projectStrip.append(projectBar,projectReview,projectOpen);
async function openProjectFolder(){
  if(busy)return toast(t('busy.stopFirst'));
  if(!current)await newChat();if(!current)return;
  let chosen=null;
  if(window.kvalahDesktop)chosen=await window.kvalahDesktop.chooseFolder('project');
  else chosen=prompt(t('project.promptPath'));
  if(!chosen)return;
  try{const data=await api('/api/project/open',{chatId:current,path:chosen});const chat=currentChat();chat.project=data.project;delete chat.workflow;renderProject();toast(t('project.opened',{path:data.project.path+(data.project.git?' (Git)':'')}));}
  catch(e){toast(e.message);}
}
projectOpen.onclick=openProjectFolder;
const projectDialog=document.createElement('dialog');projectDialog.id='projectDialog';projectDialog.innerHTML='<div class="dialog-heading"><div><span class="eyebrow" data-i18n="project.eyebrow"></span><h2 data-i18n="project.dialogTitle"></h2></div><button class="icon dialog-close" data-i18n-aria="common.close">×</button></div><div id="projectDetails"></div>';kvI18n.apply(projectDialog);document.body.append(projectDialog);
function renderProject(){const p=currentChat()?.project;projectStrip.classList.toggle('hidden',!current);projectBar.classList.toggle('hidden',!p);projectReview.classList.toggle('hidden',!p);projectBar.textContent=p?t(p.existing?'project.folder':'project.project',{path:p.path}):'';projectBar.title=p?t('project.clickToCopy',{path:p.path}):'';}
projectReview.onclick=()=>showProject();
async function showProject(){
  const container=$('#projectDetails');container.textContent=t('common.loading');if(!projectDialog.open)projectDialog.showModal();
  try{
    const data=await api('/api/project?chatId='+encodeURIComponent(current));container.replaceChildren();
    const w=data.workflow;if(!w){container.textContent=t('project.noPlanYet');return;}
    const phase=w.phase&&['inspect','implement','verified','blocked','completed'].includes(w.phase)?t('phase.'+w.phase):w.phase;
    const state=document.createElement('p');state.className='workflow-phase';state.textContent=t('project.revision',{phase,revision:w.revision});container.append(state);
    const goal=document.createElement('p');goal.textContent=w.goal;container.append(goal);
    const heading=text=>{const h=document.createElement('h3');h.textContent=text;container.append(h);};
    heading(t('project.plan'));
    for(const step of w.steps){const row=document.createElement('p');row.className='workflow-step';row.textContent=(step.status==='done'?'✓ ':step.status==='in_progress'?'→ ':'○ ')+step.title;container.append(row);}
    if(!w.steps.length){const p=document.createElement('p');p.textContent=t('project.noSteps');container.append(p);}
    if(w.note){const note=document.createElement('p');note.textContent=w.note;container.append(note);}
    heading(t('project.checks'));
    for(const check of [...w.checks].reverse()){
      const detail=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');
      summary.textContent=t(check.passed?'check.passed':'check.failed')+' · r'+check.revision+' · '+check.command;
      pre.textContent=(check.output||check.message||'')+'\n'+(check.artifacts||[]).map(a=>a.path+': '+(a.exists?t('units.bytes',{n:a.size}):a.error)).join('\n')+(check.launched?'\n'+t('check.launched'):'');detail.append(summary,pre);container.append(detail);
    }
    if(!w.checks.length){const p=document.createElement('p');p.textContent=t('project.noChecks');container.append(p);}
    heading(t('project.changes'));
    for(const change of [...w.changes].reverse()){
      const detail=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');summary.textContent=change.path+(change.stats?' · +'+change.stats.added+' −'+change.stats.removed:'')+(change.rewound?' · '+t('change.rewound'):change.undone?' · '+t('change.undone'):'');pre.className='diff';pre.replaceChildren(...String(change.diff||'').split('\n').map(line=>{const span=document.createElement('span');span.className=line.startsWith('@@')?'hunk':line.startsWith('+')&&!line.startsWith('+++')?'add':line.startsWith('-')&&!line.startsWith('---')?'del':'';span.textContent=line+'\n';return span;}));
      const undo=document.createElement('button');undo.className='secondary';undo.textContent=t('change.undo');undo.disabled=busy||change.undone;
      undo.onclick=async()=>{if(!confirm(t('change.undoConfirm',{path:change.path})))return;undo.disabled=true;try{await api('/api/project/undo',{chatId:current,changeId:change.id});await showProject();toast(t('change.undoneToast'));}catch(e){toast(e.message);undo.disabled=false;}};
      detail.append(summary,pre,undo);container.append(detail);
    }
    heading(t('project.checkpoints'));
    if(!data.checkpoints?.length){const p=document.createElement('p');p.textContent=t('project.noCheckpoints');container.append(p);}
    for(const point of data.checkpoints||[]){
      const row=document.createElement('div');row.className='checkpoint-row';const label=document.createElement('span');label.textContent=new Date(point.time).toLocaleString(kvI18n.lang)+' · '+point.label;
      const back=document.createElement('button');back.className='secondary';back.textContent=t('checkpoint.rewind');back.disabled=busy;
      back.onclick=async()=>{if(!confirm(t('checkpoint.confirm',{label:point.label})))return;back.disabled=true;try{const r=await api('/api/project/rewind',{chatId:current,checkpointId:point.id});const chat=currentChat();Object.assign(chat,await api('/api/chats/get?id='+encodeURIComponent(current)));render();await showProject();toast(t('checkpoint.done',{n:r.files.length}));}catch(e){toast(e.message);back.disabled=false;}};
      row.append(label,back);container.append(row);
    }
    if(data.allowRules?.length){
      heading(t('project.allowRules'));
      for(const rule of data.allowRules){const row=document.createElement('div');row.className='checkpoint-row';const label=document.createElement('code');label.textContent=rule;const remove=document.createElement('button');remove.className='secondary';remove.textContent=t('common.remove');remove.onclick=async()=>{try{await api('/api/project/rules',{chatId:current,remove:rule});row.remove();}catch(e){toast(e.message);}};row.append(label,remove);container.append(row);}
    }
    const note=document.createElement('p');note.className='field-note';note.textContent=t('project.note');container.append(note);
  }catch(e){container.textContent=e.message;}
}
let preferredTheme=localStorage.getItem('local-codex-theme')||'light';
function setTheme(value){preferredTheme=value;localStorage.setItem('local-codex-theme',value);document.documentElement.dataset.theme=value==='system'?(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'):value;}
setTheme(preferredTheme);
if(innerWidth<760||localStorage.getItem('local-codex-side')==='closed')document.body.classList.add('side-closed');
function toast(text){$('#toast').textContent=text;$('#toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),5000);}
async function api(route,data){
  const response=await fetch(route,data===undefined?{headers:{'X-Local-Token':token}}:{method:'POST',headers:{'Content-Type':'application/json','X-Local-Token':token},body:JSON.stringify(data)});
  const result=await response.json();if(!response.ok)throw Error(result.error||t('error.request'));return result;
}
let lastStatus=null;
function statusT(key,params,isBusy=false){if(typeof params==='boolean'){isBusy=params;params=undefined;}status(t(key,params),isBusy);lastStatus={key,params};}
function status(text,isBusy=false){lastStatus=null;$('#statusLine').textContent=text;$('#statusLine').classList.toggle('busy',isBusy);}
function side(){document.body.classList.toggle('side-closed');localStorage.setItem('local-codex-side',document.body.classList.contains('side-closed')?'closed':'open');}
$('#toggleSide').onclick=side;$('#closeSide').onclick=side;$('#scrim').onclick=side;
$('#themeToggle').onclick=()=>setTheme(document.documentElement.dataset.theme==='dark'?'light':'dark');
function currentChat(){return chats.find(c=>c.id===current);}
function history(){
  const q=$('#search').value.toLowerCase(),nav=$('#history');nav.replaceChildren();
  const items=chats.filter(c=>c.title.toLowerCase().includes(q)).sort((a,b)=>b.updated-a.updated);
  let group='';
  for(const c of items){
    const today=new Date(c.updated).toDateString()===new Date().toDateString(),label=today?t('history.today'):t('history.earlier');
    if(label!==group){const g=document.createElement('div');g.className='history-group';g.textContent=label;nav.append(g);group=label;}
    const row=document.createElement('div');row.className='history-item'+(c.id===current?' active':'');
    const button=document.createElement('button');button.className='history-link';button.textContent=c.title;button.title=c.title;button.onclick=()=>selectChat(c.id);
    const rename=document.createElement('button');rename.className='rename';rename.textContent='···';
    rename.setAttribute('aria-haspopup','menu');
    rename.title=t('chat.actions');rename.setAttribute('aria-label',t('chat.actionsFor',{title:c.title}));
    rename.onclick=e=>openChatMenu(c,e.currentTarget);
    row.append(button,rename);nav.append(row);
  }
  if(!items.length){const note=document.createElement('div');note.className='history-empty';note.textContent=q?t('history.notFound'):t('history.empty');nav.append(note);}
}
$('#search').oninput=history;
let menuChat=null,deleteId=null,menuAnchor=null;
function closeChatMenu(){$('#chatMenu').classList.add('hidden');menuAnchor?.setAttribute('aria-expanded','false');}
function openChatMenu(chat,anchor){
  if(busy)return toast(t('busy.stopFirst'));
  closeChatMenu();menuChat=chat;menuAnchor=anchor;anchor.setAttribute('aria-expanded','true');
  const rect=anchor.getBoundingClientRect(),menu=$('#chatMenu');menu.classList.remove('hidden');
  menu.style.left=Math.max(8,Math.min(rect.left,innerWidth-190))+'px';
  menu.style.top=Math.max(8,Math.min(rect.bottom+5,innerHeight-100))+'px';
  $('#renameMenu').focus();
}
document.addEventListener('click',e=>{if(!e.target.closest('#chatMenu')&&!e.target.closest('.rename'))closeChatMenu();});
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeChatMenu();});
$('#chatMenu').addEventListener('keydown',e=>{if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();const items=[...$('#chatMenu').querySelectorAll('button')],index=items.indexOf(document.activeElement);items[(index+1)%items.length].focus();}});
addEventListener('resize',closeChatMenu);
$('#renameMenu').onclick=async()=>{
  const chat=menuChat;closeChatMenu();if(!chat)return;
  const title=prompt(t('chat.renamePrompt'),chat.title);if(title===null)return;
  try{await api('/api/rename',{id:chat.id,title});chat.title=title||t('chat.new');history();}catch(e){toast(e.message);}
};
$('#deleteMenu').onclick=()=>{
  const chat=menuChat;closeChatMenu();if(!chat)return;
  deleteId=chat.id;$('#deleteTitle').textContent='«'+chat.title+'»';$('#deleteDialog').showModal();$('#cancelDelete').focus();
};
$('#cancelDelete').onclick=()=>$('#deleteDialog').close();
$('#confirmDelete').onclick=async()=>{
  if(!deleteId)return;
  const button=$('#confirmDelete');button.disabled=true;
  try{
    await api('/api/chats/delete',{id:deleteId});chats=chats.filter(c=>c.id!==deleteId);$('#deleteDialog').close();
    if(current===deleteId){current=null;pending=[];localStorage.removeItem('local-codex-chat');if(chats.length)selectChat(chats[0].id);else{render();renderAttachments();history();}}
    else history();
    toast(t('chat.deleted'));deleteId=null;
  }catch(e){toast(e.message);}finally{button.disabled=false;}
};
async function showTrash(){
  const container=$('#trashList');container.textContent=t('common.loading');$('#trashDialog').showModal();
  try{
    const data=await api('/api/trash');container.replaceChildren();
    if(!data.chats.length){const empty=document.createElement('p');empty.className='trash-empty';empty.textContent=t('trash.empty');container.append(empty);}
    for(const item of data.chats){
      const row=document.createElement('div');row.className='trash-row';const text=document.createElement('div'),title=document.createElement('strong'),meta=document.createElement('small');
      title.textContent=item.title;meta.textContent=t('trash.deletedOn',{date:new Date(item.deletedAt).toLocaleDateString(kvI18n.lang)});text.append(title,meta);
      const restore=document.createElement('button');restore.textContent=t('trash.restore');restore.onclick=async()=>{
        restore.disabled=true;
        try{const chat=await api('/api/chats/restore',{id:item.id});chats.unshift(chat);history();row.remove();toast(t('trash.restored'));if(!current)selectChat(chat.id);if(!container.children.length)container.textContent=t('trash.nowEmpty');}
        catch(e){toast(e.message);restore.disabled=false;}
      };row.append(text,restore);container.append(row);
    }
  }catch(e){container.textContent=e.message;}
}
async function newChat(){
  if(busy)return toast(t('busy.stopFirst'));
  try{const chat=await api('/api/chats',{});chats.unshift(chat);selectChat(chat.id);$('#prompt').focus();}catch(e){toast(e.message);}
}
$('#newChat').onclick=newChat;
async function selectChat(id){
  if(busy&&id!==current)return toast(t('busy.stopFirst'));
  const summary=chats.find(c=>c.id===id);
  if(summary&&!Array.isArray(summary.messages)){
    try{Object.assign(summary,await api('/api/chats/get?id='+encodeURIComponent(id)));}catch(e){return toast(e.message);}
  }
  current=id;pending=[];localStorage.setItem('local-codex-chat',id);
  const chat=currentChat();if(chat?.model&&[...$('#model').options].some(o=>o.value===chat.model))$('#model').value=chat.model;
  render();history();renderAttachments();renderProject();if(innerWidth<760)document.body.classList.add('side-closed');autoScroll=true;scrollEnd();
}
function inline(text){
  const blocks=[];
  let s=String(text).replace(/\x60([^\x60]+)\x60/g,(_,code)=>{blocks.push('<code class="inline-code">'+esc(code)+'</code>');return '\u0001'+(blocks.length-1)+'\u0001';});
  s=esc(s).replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>');
  s=s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,(_,label,url)=>'<a href="'+url+'" target="_blank" rel="noopener noreferrer">'+label+'</a>');
  return s.replace(/\u0001(\d+)\u0001/g,(_,n)=>blocks[Number(n)]);
}
function markdown(text){
  const container=document.createElement('div'),pieces=String(text||'').split(/\x60\x60\x60/);
  pieces.forEach((piece,index)=>{
    if(index%2){
      const nl=piece.indexOf('\n'),lang=nl<0?'code':piece.slice(0,nl).trim(),code=nl<0?piece:piece.slice(nl+1);
      const block=document.createElement('div');block.className='code-block';const bar=document.createElement('div');bar.className='code-bar';
      const label=document.createElement('span');label.textContent=lang||'code';const copy=document.createElement('button');copy.textContent=t('common.copy');copy.onclick=()=>copyText(code);
      bar.append(label,copy);const pre=document.createElement('pre');pre.textContent=code.replace(/\n$/,'');block.append(bar,pre);container.append(block);
    }else{
      const lines=piece.split('\n');let paragraph=[],list=null;
      const flush=()=>{if(paragraph.length){const p=document.createElement('p');p.innerHTML=inline(paragraph.join('\n'));container.append(p);paragraph=[];}list=null;};
      for(const line of lines){
        if(!line.trim()){flush();continue;}
        const heading=line.match(/^(#{1,3})\s+(.+)/),bullet=line.match(/^\s*[-*]\s+(.+)/),number=line.match(/^\s*\d+\.\s+(.+)/);
        if(heading){flush();const h=document.createElement('h'+heading[1].length);h.innerHTML=inline(heading[2]);container.append(h);}
        else if(bullet||number){if(paragraph.length)flush();const type=number?'OL':'UL';if(!list||list.tagName!==type){list=document.createElement(type.toLowerCase());container.append(list);}const li=document.createElement('li');li.innerHTML=inline((bullet||number)[1]);list.append(li);}
        else {if(list)list=null;paragraph.push(line);}
      }flush();
    }
  });
  return container;
}
function fileChip(a,remove=false){
  const div=document.createElement('div');div.className='file-chip';
  div.innerHTML=icon('file')+'<div><strong>'+esc(a.name)+'</strong><small>'+esc(t(a.kind==='image'?'file.image':a.kind==='text'?'file.text':'file.binary')+' · '+t('units.kb',{n:Math.max(1,Math.round(a.size/1024))}))+'</small></div>';
  if(remove){const b=document.createElement('button');b.textContent='×';b.title=t('file.remove');b.setAttribute('aria-label',t('file.removeNamed',{name:a.name}));b.onclick=()=>{pending=pending.filter(f=>f.id!==a.id);renderAttachments();};div.append(b);}
  return div;
}
function toolNode(m){
  const details=document.createElement('details');details.className='tool-card';details.dataset.tool=m.id;
  const label=m.tool_name==='run_shell'?'PowerShell':TOOL_NAMES.includes(m.tool_name)?t('tool.'+m.tool_name):m.tool_name;
  let state=t(m.content?'toolState.done':'toolState.running');
  try{const result=JSON.parse(m.content);if(result.error||result.exitCode>0||result.passed===false)state=t('toolState.error');else if(result.denied)state=t('toolState.denied');else if(result.skipped)state=t('toolState.skipped');}catch{}
  const summary=document.createElement('summary');summary.innerHTML='<span class="tool-icon">⌘</span><strong>'+esc(label)+'</strong><span class="tool-state">'+esc(state)+'</span>';
  const pre=document.createElement('pre');pre.textContent=JSON.stringify(m.args,null,2)+(m.content?'\n\n'+m.content:'');
  details.append(summary,pre);return details;
}
function messageNode(m){
  if(m.role==='tool')return toolNode(m);
  const div=document.createElement('article');div.className='message '+m.role;div.dataset.id=m.id;
  if(m.role==='activity'){div.className='activity-error';div.textContent=m.content;return div;}
  if(m.role==='user'){
    if(m.attachments?.length){const files=document.createElement('div');files.className='user-files';m.attachments.forEach(a=>files.append(fileChip(a)));div.append(files);}
    const bubble=document.createElement('div');bubble.className='bubble';bubble.textContent=m.content;div.append(bubble);return div;
  }
  div.innerHTML='<div class="message-head"><span class="mini-brand"><img src="/logo.svg" alt=""></span><strong>kvalah</strong><span>'+esc(m.model||'')+'</span></div>';
  if(m.tool_calls?.length&&!m.content&&!m.thinking)div.classList.add('hidden');
  const thinking=document.createElement('details');thinking.className='thinking'+(m.thinking?'':' hidden');thinking.innerHTML='<summary></summary><pre></pre>';thinking.querySelector('summary').textContent=t('message.thinking');thinking.querySelector('pre').textContent=m.thinking||'';div.append(thinking);
  const content=document.createElement('div');content.className='message-body';content.append(markdown(m.content));div.append(content);
  const actions=document.createElement('div');actions.className='message-actions';
  const copy=document.createElement('button');copy.className='icon';copy.innerHTML=icon('copy');copy.title=t('message.copy');copy.setAttribute('aria-label',t('message.copy'));copy.onclick=()=>copyText(m.content);
  const speak=document.createElement('button');speak.className='icon';speak.innerHTML=icon('audio');speak.title=t('message.speak');speak.setAttribute('aria-label',t('message.speak'));speak.onclick=()=>{
    if(!('speechSynthesis'in window))return toast(t('message.speechUnavailable'));
    speechSynthesis.cancel();const utterance=new SpeechSynthesisUtterance(m.content);utterance.lang=kvI18n.speech;speechSynthesis.speak(utterance);
  };
  const metrics=document.createElement('span');metrics.className='metrics';metrics.textContent=statsText(m.stats);actions.append(copy,speak,metrics);div.append(actions);return div;
}
function statsText(s){return s?[s.tps?t('stats.tps',{n:s.tps}):'',s.seconds?t('stats.seconds',{n:s.seconds}):'',s.promptTokens?t('stats.promptTokens',{n:s.promptTokens}):''].filter(Boolean).join(' · '):'';}
function render(){
  renderProject();
  const chat=currentChat(),messages=chat?.messages||[];
  $('#welcome').classList.toggle('hidden',messages.length>0);
  $('#messages').replaceChildren(...messages.filter(m=>!m.error||m.role==='activity').map(messageNode));
}
function renderAttachments(){$('#attachments').replaceChildren(...pending.map(a=>fileChip(a,true)));}
function scrollEnd(){if(autoScroll)requestAnimationFrame(()=>{$('#conversation').scrollTop=$('#conversation').scrollHeight;});}
$('#conversation').onscroll=()=>{const c=$('#conversation');autoScroll=c.scrollHeight-c.scrollTop-c.clientHeight<130;$('#jump').classList.toggle('hidden',autoScroll);};
$('#jump').onclick=()=>{autoScroll=true;scrollEnd();};
async function copyText(text){try{await navigator.clipboard.writeText(text);toast(t('copy.done'));}catch{toast(t('copy.failed'));}}
function updateAssistant(m){
  const node=document.querySelector('[data-id="'+m.id+'"]');if(!node)return;
  node.querySelector('.message-body').replaceChildren(markdown(m.content));
  const thinking=node.querySelector('.thinking');thinking.classList.toggle('hidden',!m.thinking);thinking.querySelector('pre').textContent=m.thinking||'';
  node.querySelector('.metrics').textContent=statsText(m.stats);scrollEnd();
}
async function refreshModels(){
  try{
    const data=await api('/api/models'),select=$('#model'),old=select.value;
    select.replaceChildren();
    for(const m of data.models||[]){const o=document.createElement('option');o.value=m.name;o.textContent=m.name+(m.size?' · '+t('units.gb',{n:kvI18n.number(Math.round(m.size/1e8)/10)}):'');select.append(o);}
    const desired=old||currentChat()?.model||settings.model;
    if([...select.options].some(o=>o.value===desired))select.value=desired;
    connectionState={online:true,provider:data.provider,count:data.models?.length||0};renderConnection();
    if(!data.models?.length){const o=document.createElement('option');o.value='';o.textContent=t('models.none');select.append(o);}
  }catch(e){connectionState={online:false,provider:settings.provider};renderConnection();status(e.message);toast(e.message);}
}
$('#refreshModels').onclick=refreshModels;
function renderMode(){
  $('#agentToggle').classList.toggle('on',agent);$('#agentToggle').setAttribute('aria-pressed',agent);$('#modeLabel').textContent=t(agent?'mode.agent':'mode.chat');
  const mode=['ask','auto','full'].includes(settings.approvalMode)?settings.approvalMode:'ask';
  $('#agentToggle').title=agent?t('agent.onTitle',{mode:t('approvalHint.'+mode)}):t('agent.offTitle');
  $('#privacyCaption').textContent=t(agent?(mode==='full'?'caption.full':'caption.agent'):'caption.chat');
}
$('#agentToggle').onclick=()=>{if(busy)return;agent=!agent;localStorage.setItem('kvalah-agent-mode',agent?'agent':'chat');renderMode();statusT(agent?'agent.enabled':'agent.disabled');};
renderMode();
$('#prompt').addEventListener('input',()=>{const t=$('#prompt');t.style.height='auto';t.style.height=Math.min(t.scrollHeight,180)+'px';});
$('#prompt').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();if(!busy)sendMessage();}});
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();newChat();}});
for(const b of document.querySelectorAll('[data-prompt]'))b.onclick=()=>{$('#prompt').value=b.dataset.prompt;$('#prompt').dispatchEvent(new Event('input'));$('#prompt').focus();};
function setBusy(value){busy=value;$('#send').innerHTML=value?'<span class="stop-square"></span>':icon('arrow');$('#send').classList.toggle('stop',value);$('#send').title=t(value?'composer.stop':'composer.send');$('#send').setAttribute('aria-label',t(value?'composer.stopAria':'composer.send'));$('#model').disabled=value;$('#attach').disabled=value;$('#agentToggle').disabled=value;}
$('#send').onclick=async()=>{if(busy){statusT('status.stopping',true);if(runId){try{await api('/api/cancel',{id:runId});}catch(e){toast(e.message);}}else requestController?.abort();return;}sendMessage();};
async function sendMessage(){
  const text=$('#prompt').value.trim();if((!text&&!pending.length)||busy)return;
  if(!$('#model').value)return toast(t('model.selectFirst'));
  if(!current)await newChat();if(!current)return;
  const chat=currentChat(),files=pending.map(a=>a.id);let receivedStart=false;
  setBusy(true);autoScroll=true;statusT('status.connecting',true);
  try{
    requestController=new AbortController();
    const response=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json','X-Local-Token':token},body:JSON.stringify({chatId:current,text,model:$('#model').value,agent,attachments:files}),signal:requestController.signal});
    if(!response.ok){const e=await response.json();throw Error(e.error||t('error.request'));}
    const reader=response.body.getReader(),decoder=new TextDecoder();let carry='';
    function event(data){
      if(data.type==='start'){
        receivedStart=true;runId=data.runId;chat.messages.push(data.user);chat.title=data.title;chat.model=data.model;chat.updated=Date.now();pending=[];$('#prompt').value='';$('#prompt').style.height='auto';renderAttachments();render();history();scrollEnd();
      }else if(data.type==='project'){
        chat.project=data.project;$('#contextLabel').title=t('project.project',{path:data.project.path});
        renderProject();
        statusT('project.project',{path:data.project.path},true);
      }else if(data.type==='assistant'){
        chat.messages.push(data.message);$('#messages').append(messageNode(data.message));scrollEnd();
      }else if(data.type==='delta'||data.type==='thinking'){
        const m=chat.messages.find(m=>m.id===data.id);if(!m)return;const field=data.type==='delta'?'content':'thinking';m[field]=(m[field]||'')+data.text;
        if(performance.now()-lastPaint>60){updateAssistant(m);lastPaint=performance.now();}
      }else if(data.type==='content'){
        const m=chat.messages.find(m=>m.id===data.id);if(m){m.content=data.text;updateAssistant(m);}
      }else if(data.type==='stats'){
        const m=chat.messages.find(m=>m.id===data.id);if(m){m.stats=data.stats;updateAssistant(m);}
      }else if(data.type==='status'){statusT('status.step',{text:data.text,step:data.step},true);}
      else if(data.type==='tool'){
        const previous=chat.messages.at(-1);
        if(previous?.role==='assistant'&&!previous.content&&!previous.thinking){previous.tool_calls=[{}];document.querySelector('[data-id="'+previous.id+'"]')?.classList.add('hidden');}
        const m={id:data.id,role:'tool',tool_name:data.name,args:data.args,content:''};chat.messages.push(m);$('#messages').append(toolNode(m));scrollEnd();statusT('status.tool',{name:data.name},true);
      }else if(data.type==='approval'){approval(data);}
      else if(data.type==='terminal'){statusT('status.shellRunning',true);const card=[...document.querySelectorAll('.tool-card')].at(-1);if(card){card.open=true;card.querySelector('pre').textContent+=data.text;scrollEnd();}}
      else if(data.type==='tool_result'){
        const m=chat.messages.find(m=>m.id===data.id);if(m)m.content=JSON.stringify(data.result);
        const node=document.querySelector('[data-tool="'+data.id+'"]');if(node&&m)node.replaceWith(toolNode(m));
      }else if(data.type==='warning'||data.type==='error'){
        const msg={id:crypto.randomUUID(),role:'activity',content:data.message||data.text,error:true};chat.messages.push(msg);$('#messages').append(messageNode(msg));scrollEnd();status(msg.content);
      }else if(data.type==='done'){statusT('done.'+(['awaiting_verification','step_limit','repeated_error','denied','length'].includes(data.reason)?data.reason:'completed'));}
    }
    while(true){const {value,done}=await reader.read();if(done)break;carry+=decoder.decode(value,{stream:true});let pos;while((pos=carry.indexOf('\n'))>=0){const line=carry.slice(0,pos);carry=carry.slice(pos+1);if(line.trim())event(JSON.parse(line));}}
    carry+=decoder.decode();if(carry.trim())event(JSON.parse(carry));
  }catch(e){toast(e.message);status(e.message);if(receivedStart){const m={id:crypto.randomUUID(),role:'activity',content:t('error.connectionLost',{error:e.message}),error:true};chat.messages.push(m);$('#messages').append(messageNode(m));}}
  finally{setBusy(false);runId=null;requestController=null;for(const m of chat.messages)if(m.role==='assistant')updateAssistant(m);for(const b of document.querySelectorAll('.approval-buttons button'))b.disabled=true;$('#statusLine').classList.remove('busy');history();}
}
function approval(data){
  statusT('approval.waiting');
  const card=document.createElement('section');card.className='approval-card';
  const access=data.name==='request_access',shell=data.name==='run_shell',commit=data.name==='git_commit';
  const title=document.createElement('h4');title.textContent=t(access?(data.args.mode==='write'?'approval.accessWrite':'approval.accessRead'):shell?'approval.shell':commit?'approval.commit':'approval.write');
  const note=document.createElement('p');note.textContent=access?data.args.reason+' '+t('approval.accessNote'):t(shell?'approval.shellNote':commit?'approval.commitNote':'approval.writeNote');
  const pre=document.createElement('pre');pre.textContent=access?data.args.path+'\n'+t('approval.scope',{scope:t(data.args.kind==='file'?'approval.scopeFile':'approval.scopeFolder')})+'\n'+t('approval.term'):shell?(data.args.cwd?t('approval.cwd',{cwd:data.args.cwd})+'\n\n':'')+data.args.command:commit?data.args.message+'\n\n'+(data.args.files?.length?t('approval.files',{files:data.args.files.join(', ')}):t('approval.allChanges')):data.args.path+'\n\n'+data.args.content;
  const buttons=document.createElement('div');buttons.className='approval-buttons';
  const choices=[[false,t('approval.deny')],[true,t(access?'approval.allowTask':'approval.allowOnce')]];
  if(shell&&data.args.rule)choices.push([true,t('approval.always',{rule:data.args.rule}),true]);
  for(const [allowed,label,always] of choices){
    const b=document.createElement('button');b.textContent=label;if(allowed)b.className='allow';if(always)b.classList.add('always');b.onclick=async()=>{
      for(const x of buttons.children)x.disabled=true;
      try{await api('/api/approve',{id:data.id,runId:data.runId,allowed,always:!!always});title.textContent=t(allowed?(always?'approval.allowedAlways':'approval.allowed'):'approval.denied');statusT(allowed?'status.executing':'status.actionDenied',allowed);}
      catch(e){toast(e.message);title.textContent=t('approval.unavailable');}
    };buttons.append(b);
  }
  card.append(title,note,pre,buttons);$('#messages').append(card);scrollEnd();
}
$('#attach').onclick=()=>$('#fileInput').click();
$('#fileInput').onchange=async e=>{await uploadFiles(e.target.files);e.target.value='';};
async function uploadFiles(files){
  if(busy)return toast(t('files.afterReply'));
  if(!current)await newChat();if(!current)return;
  for(const f of files){
    if(pending.length>=8){toast(t('files.max'));break;}
    if(f.size>20*1024*1024){toast(t('files.tooBig',{name:f.name}));continue;}
    try{
      statusT('files.adding',{name:f.name});
      const base64=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(',')[1]);r.onerror=()=>reject(Error(t('files.readFailed')));r.readAsDataURL(f);});
      const a=await api('/api/upload',{chatId:current,name:f.name,mime:f.type,base64});pending.push(a);(currentChat().uploads??=[]).push(a);renderAttachments();
      if(a.kind==='binary')toast(t('files.noText',{name:f.name}));
    }catch(e){toast(e.message);}
  }status('');
}
let dragDepth=0;
document.body.addEventListener('dragenter',e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();dragDepth++;$('#dropZone').classList.add('dragging');}});
document.body.addEventListener('dragover',e=>{if(e.dataTransfer.types.includes('Files'))e.preventDefault();});
document.body.addEventListener('dragleave',()=>{if(--dragDepth<=0){dragDepth=0;$('#dropZone').classList.remove('dragging');}});
document.body.addEventListener('drop',e=>{e.preventDefault();dragDepth=0;$('#dropZone').classList.remove('dragging');if(e.dataTransfer.files.length)uploadFiles(e.dataTransfer.files);});
$('#prompt').addEventListener('paste',e=>{const files=[...e.clipboardData.items].filter(i=>i.kind==='file').map(i=>i.getAsFile()).filter(Boolean);if(files.length){e.preventDefault();uploadFiles(files);}});
$('#openSettings').onclick=()=>{
  if(busy)return toast(t('settings.afterReply'));
  $('#workspace').value=settings.workspace;$('#context').value=settings.context;$('#thinking').checked=settings.thinking;$('#maxSteps').value=settings.maxSteps;
  $('#approvalMode').value=settings.approvalMode||'ask';$('#provider').value=settings.provider||'ollama';$('#toolMode').value=settings.toolMode||'auto';$('#ollamaUrl').value=settings.ollamaUrl||'';$('#baseUrl').value=settings.baseUrl||'';$('#apiKey').value='';$('#apiKey').placeholder=t(settings.apiKeySet?'settings.apiKeySaved':'settings.apiKeyUnset');$('#replyLanguage').value=settings.replyLanguage==='auto'?'auto':'ui';renderProviderRows();$('#themeSelect').value=preferredTheme;$('#settingsError').textContent='';$('#settingsDialog').showModal();
};
function renderProviderRows(){const openai=$('#provider').value==='openai';$('#ollamaUrlRow').classList.toggle('hidden',openai);$('#baseUrlRow').classList.toggle('hidden',!openai);$('#apiKeyRow').classList.toggle('hidden',!openai);}
$('#provider').onchange=renderProviderRows;
for(const b of document.querySelectorAll('.dialog-close'))b.onclick=()=>b.closest('dialog').close();
for(const d of document.querySelectorAll('dialog'))d.addEventListener('click',e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close();}});
$('#settingsForm').onsubmit=async e=>{
  e.preventDefault();try{const providerChanged=$('#provider').value!==settings.provider||$('#baseUrl').value!==settings.baseUrl||$('#ollamaUrl').value!==settings.ollamaUrl;
  settings=await api('/api/settings',{workspace:$('#workspace').value,context:Number($('#context').value),maxSteps:Number($('#maxSteps').value),thinking:$('#thinking').checked,model:$('#model').value,approvalMode:$('#approvalMode').value,provider:$('#provider').value,toolMode:$('#toolMode').value,ollamaUrl:$('#ollamaUrl').value.trim(),baseUrl:$('#baseUrl').value.trim(),apiKey:$('#apiKey').value,replyLanguage:$('#replyLanguage').value});if(providerChanged)refreshModels();renderMode();setTheme($('#themeSelect').value);$('#contextLabel').textContent=(settings.context/1024)+'K';$('#settingsDialog').close();toast(t('settings.saved'));}
  catch(e){$('#settingsError').textContent=e.message;}
};
$('#exportChat').onclick=async()=>{
  if(!current)return;
  try{const r=await fetch('/api/export?id='+encodeURIComponent(current),{headers:{'X-Local-Token':token}});if(!r.ok)throw Error((await r.json()).error||t('error.export'));
    const url=URL.createObjectURL(await r.blob()),a=document.createElement('a');a.href=url;a.download='chat.json';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  catch(e){toast(e.message);}
};
const shutdown=document.createElement('button');shutdown.type='button';shutdown.className='settings-button';shutdown.dataset.i18n='settings.shutdown';
shutdown.onclick=async()=>{if(!confirm(t('settings.shutdownConfirm')))return;try{if(window.kvalahDesktop){await window.kvalahDesktop.quit();return;}await api('/api/shutdown',{});$('#settingsDialog').close();statusT('settings.shutdownDone');connectionState={stopped:true};renderConnection();}catch(e){toast(e.message);}};
$('#settingsForm').append(shutdown);
const trashButton=document.createElement('button');trashButton.type='button';trashButton.className='settings-button';trashButton.dataset.i18n='settings.trash';
trashButton.onclick=()=>{$('#settingsDialog').close();showTrash();};$('#settingsForm').insertBefore(trashButton,shutdown);
if(window.kvalahDesktop){
  const shortcuts=document.createElement('button');shortcuts.type='button';shortcuts.className='settings-button';shortcuts.dataset.i18n='settings.shortcuts';
  shortcuts.onclick=async()=>{try{await window.kvalahDesktop.createShortcuts();toast(t('settings.shortcutsDone'));}catch(e){toast(e.message);}};
  $('#settingsForm').insertBefore(shortcuts,shutdown);
  const folder=document.createElement('button');folder.type='button';folder.className='settings-button';folder.dataset.i18n='settings.chooseWorkspace';
  folder.onclick=async()=>{try{const chosen=await window.kvalahDesktop.chooseFolder();if(chosen)$('#workspace').value=chosen;}catch(e){toast(e.message);}};
  $('#workspace').parentElement.append(folder);
  // Auto-update: a quiet bar above the conversation, never a modal. Desktop shell only.
  if(window.kvalahDesktop.onUpdate){
    const bar=document.createElement('div');bar.id='updateNotice';bar.className='update-notice hidden';bar.setAttribute('role','status');
    const text=document.createElement('span'),action=document.createElement('button'),later=document.createElement('button');
    action.type='button';action.className='primary update-action';later.type='button';later.className='icon update-later';later.textContent='×';
    bar.append(text,action,later);$('header').after(bar);
    let update=null;
    const renderUpdate=()=>{
      const downloading=update?.state==='downloading'&&typeof update.progress==='number'; // macOS self-update reports progress
      const show=update&&update.version&&localStorage.getItem('kvalah-update-dismissed')!==update.version&&(update.state==='ready'||downloading||(update.state==='available'&&(update.mode==='notify'||update.manual)));
      bar.classList.toggle('hidden',!show);if(!show)return;
      text.textContent=downloading?t('update.downloading',{version:update.version,percent:Math.round(update.progress*100)}):update.state==='available'&&update.reason==='location'?t('update.moveToApplications',{version:update.version}):update.state==='available'&&update.reason==='failed'?t('update.failed',{version:update.version}):t('update.available',{version:update.version});
      action.classList.toggle('hidden',downloading);
      action.textContent=t(update.state==='ready'?'update.restart':'update.download');
      later.title=t('update.later');later.setAttribute('aria-label',t('update.later'));
    };
    window.renderUpdateNotice=renderUpdate;
    action.onclick=async()=>{try{if(update?.state==='ready'){if(busy)return toast(t('busy.stopFirst'));await window.kvalahDesktop.installUpdate();}else await window.kvalahDesktop.openUpdatePage();}catch(e){toast(e.message);}};
    later.onclick=()=>{if(update?.version)localStorage.setItem('kvalah-update-dismissed',update.version);renderUpdate();};
    window.kvalahDesktop.onUpdate(next=>{update=next;renderUpdate();});
    window.kvalahDesktop.getUpdate().then(next=>{if(next){update=next;renderUpdate();}}).catch(()=>{});
    // Settings: one switch, stored by the desktop shell (update.json in the user data folder).
    window.kvalahDesktop.getUpdatePrefs().then(prefs=>{
      if(!prefs||prefs.mode==='off')return;
      const row=document.createElement('label');row.className='switch-row';
      const caption=document.createElement('span'),strong=document.createElement('strong'),small=document.createElement('small');
      strong.dataset.i18n='settings.autoUpdate';small.dataset.i18n='settings.autoUpdateNote';caption.append(strong,small);
      const box=document.createElement('input');box.type='checkbox';box.id='autoUpdate';box.checked=prefs.autoCheck!==false;
      box.onchange=async()=>{try{await window.kvalahDesktop.setUpdatePrefs(box.checked);}catch(e){toast(e.message);}};
      row.append(caption,box);$('#thinking').closest('label').after(row);kvI18n.apply(row);
    }).catch(()=>{});
  }
  window.kvalahDesktop.onAction(action=>{
    if(action==='new-chat')newChat();
    if(action==='settings')$('#openSettings').click();
    if(action==='devices'){if(!busy)window.openDevices?.();else toast(t('busy.stopFirst'));}
    if(action==='trash'){if(!busy)showTrash();else toast(t('busy.stopFirst'));}
    if(action==='sidebar')side();
    if(action.startsWith('language:')){const lang=action.slice(9);if(lang==='auto')systemLanguage().then(l=>changeLanguage(l,'auto'));else if(kvI18n.LANGS.includes(lang))changeLanguage(lang,'user');}
  });
}
$('#mic').onclick=()=>{
  if(recording){recognition?.stop();return;}
  if(!('SpeechRecognition'in window||'webkitSpeechRecognition'in window))return toast(t('voice.unsupported'));
  $('#voiceDialog').showModal();
};
$('#startVoice').onclick=()=>{
  $('#voiceDialog').close();const Recognition=window.SpeechRecognition||window.webkitSpeechRecognition;recognition=new Recognition();
  recognition.lang=kvI18n.speech;recognition.interimResults=true;recognition.continuous=true;
  const original=$('#prompt').value;let finalText='';
  recognition.onstart=()=>{recording=true;$('#mic').classList.add('recording');statusT('voice.listening');};
  recognition.onresult=e=>{let interim='';for(let i=e.resultIndex;i<e.results.length;i++){if(e.results[i].isFinal)finalText+=e.results[i][0].transcript+' ';else interim+=e.results[i][0].transcript;}$('#prompt').value=original+(original?' ':'')+finalText+interim;$('#prompt').dispatchEvent(new Event('input'));};
  recognition.onerror=e=>toast(t('voice.error',{error:e.error==='not-allowed'?t('voice.allowMic'):e.error}));
  recognition.onend=()=>{recording=false;$('#mic').classList.remove('recording');if(!busy)status('');};
  try{recognition.start();}catch(e){toast(e.message);}
};
// The session token comes from the desktop shell (IPC) or from the #token= link printed by the server.
async function loadToken(){
  if(window.kvalahDesktop?.getToken){const t=await window.kvalahDesktop.getToken();if(t)return t;}
  const match=/(?:^#|&)token=([0-9a-f]{20,})/.exec(location.hash);
  if(match){sessionStorage.setItem('kvalah-token',match[1]);location.replace(location.pathname);return new Promise(()=>{});}
  return sessionStorage.getItem('kvalah-token')||'';
}
function renderConnection(){
  const c=$('#connection'),s=connectionState,dot=document.createElement('i');
  if(!s){c.className='connection';c.replaceChildren(dot,t('header.connection'));$('#deviceLabel').textContent=t('sidebar.deviceConnecting');return;}
  if(s.stopped){c.className='connection offline';c.replaceChildren(dot,t('connection.stopped'));return;}
  const openai=s.provider==='openai';
  if(s.online){c.className='connection online';c.replaceChildren(dot,t(openai?'connection.serverOnline':'connection.ollamaOnline'));$('#deviceLabel').textContent=t('device.models',{n:s.count})+' · '+t(openai?'device.openai':'device.local');}
  else{c.className='connection offline';c.replaceChildren(dot,t(openai?'connection.serverOffline':'connection.ollamaOffline'));$('#deviceLabel').textContent=t(openai?'device.checkUrl':'device.openOllama');}
}
function renderContextOptions(){for(const o of $('#context').options){const n=Number(o.value);o.textContent=n===4096?t('settings.contextChatOnly',{n:kvI18n.number(n)}):t('settings.contextTokens',{n});}}
// Language switcher next to the theme button: native names, live switch, choice persisted in settings.
function renderLangMenu(){
  $('#langCode').textContent=kvI18n.SHORT[kvI18n.lang];
  const menu=$('#langMenu'),auto=settings.languageSource!=='user';
  const item=(label,checked,onClick,extra)=>{const b=document.createElement('button');b.type='button';b.setAttribute('role','menuitemradio');b.setAttribute('aria-checked',String(checked));b.textContent=label;if(extra){const small=document.createElement('small');small.textContent=extra;b.append(small);}b.onclick=onClick;return b;};
  const autoItem=item(t('lang.auto'),auto,async()=>{closeLangMenu();await changeLanguage(await systemLanguage(),'auto');});autoItem.classList.add('lang-auto');
  menu.replaceChildren(autoItem,...kvI18n.LANGS.map(l=>{const b=item(kvI18n.name(l),!auto&&l===kvI18n.lang,()=>{closeLangMenu();changeLanguage(l,'user');},kvI18n.SHORT[l]);b.lang=l;return b;}));
}
function closeLangMenu(){$('#langMenu').classList.add('hidden');$('#langToggle').setAttribute('aria-expanded','false');}
$('#langToggle').onclick=e=>{e.stopPropagation();const menu=$('#langMenu'),open=menu.classList.contains('hidden');closeLangMenu();if(open){renderLangMenu();menu.classList.remove('hidden');$('#langToggle').setAttribute('aria-expanded','true');(menu.querySelector('[aria-checked=true]')||menu.firstChild)?.focus();}};
document.addEventListener('click',e=>{if(!e.target.closest('.lang-picker'))closeLangMenu();});
$('#langMenu').addEventListener('keydown',e=>{if(e.key==='Escape'){closeLangMenu();$('#langToggle').focus();}if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();const items=[...$('#langMenu').querySelectorAll('button')],index=items.indexOf(document.activeElement);items[(index+(e.key==='ArrowDown'?1:items.length-1))%items.length].focus();}});
async function systemLanguage(){
  try{const info=await window.kvalahDesktop?.getLanguage?.();if(info?.system?.length)return kvI18n.match(info.system);}catch{}
  return kvI18n.match(navigator.languages?.length?navigator.languages:[navigator.language]);
}
// Re-renders every piece of UI text in place: no reload, current chat and running task are kept.
function applyLanguage(lang){
  kvI18n.setLang(lang);localStorage.setItem('kvalah-lang',kvI18n.lang);
  kvI18n.apply(document);renderContextOptions();renderLangMenu();window.renderDevices?.();
  projectBar.title=t('project.copyPath');projectReview.textContent=t('project.review');projectOpen.textContent=t('project.open');projectOpen.title=t('project.openHint');
  renderProject();history();renderMode();renderConnection();renderAttachments();setBusy(busy);
  window.renderUpdateNotice?.();
  if(lastStatus)statusT(lastStatus.key,lastStatus.params,$('#statusLine').classList.contains('busy'));
  if(!busy){render();if(projectDialog.open)showProject();}
}
async function changeLanguage(lang,source){
  applyLanguage(lang);
  try{if(token)settings=await api('/api/language',{language:kvI18n.lang,source});}catch(e){toast(e.message);}
  try{await window.kvalahDesktop?.setLanguage?.(kvI18n.lang,source);}catch{}
  renderLangMenu();
}
applyLanguage(kvI18n.lang);
async function init(){
  try{
    token=await loadToken();
    if(!token)throw Error(t('error.noToken'));
    const data=await api('/api/state');chats=data.chats;settings=data.settings;$('#appVersion').textContent='v'+data.version;
    // First run (or "system default"): follow the OS language; an explicit choice always wins.
    // A manual choice wins (server settings first, then the desktop shell's copy); otherwise follow the OS.
    let desktopPref=null;try{desktopPref=await window.kvalahDesktop?.getLanguage?.();}catch{}
    const serverChoice=settings.languageSource==='user'&&kvI18n.LANGS.includes(settings.language)?settings.language:null;
    const desktopChoice=desktopPref?.source==='user'&&kvI18n.LANGS.includes(desktopPref.language)?desktopPref.language:null;
    const source=serverChoice||desktopChoice?'user':'auto';
    const lang=serverChoice||desktopChoice||await systemLanguage();
    applyLanguage(lang);
    if(settings.language!==lang||settings.languageSource!==source||(desktopPref&&(desktopPref.language!==lang||desktopPref.source!==source)))await changeLanguage(lang,source);
    $('#contextLabel').textContent=(settings.context/1024)+'K';renderMode();
    await refreshModels();
    const saved=localStorage.getItem('local-codex-chat');current=chats.some(c=>c.id===saved)?saved:chats[0]?.id;
    if(current)selectChat(current);else history();
    if(data.active.length)statusT('status.otherTab');
  }catch(e){status(e.message);toast(e.message);}
}
// Live resource indicator above "On your computer": what this device does for other devices right now.
function kvRate(bytesPerSec){return bytesPerSec>=1048576?t('activity.mbs',{n:(bytesPerSec/1048576).toFixed(1)}):t('activity.kbs',{n:Math.round(bytesPerSec/1024)});}
(function(){
  const el=$('#activity');if(!el)return;
  const spark=[];let timer=null,failures=0;
  const gbs=b=>(b/1073741824).toFixed(1);
  const shortGpu=n=>String(n).replace(/\((R|TM)\)/g,'').replace(/^NVIDIA\s+|GeForce\s+|\s+Laptop GPU|\s+Graphics$/g,'').replace(/\s+/g,' ').trim();
  function roleText(a){
    const r=a.roles||[];if(!r.length)return t('activity.idle');
    return r.map(x=>x.kind==='host'?t(x.state==='running'?'activity.host':'activity.hostLoading',{n:x.devices+1}):x.kind==='memory'?t('activity.memoryFor',{hosts:x.hosts.join(', ')}):x.kind==='tasks'?t('activity.tasksFor',{hosts:x.hosts.join(', ')}):t('activity.distributing',{n:x.n})).join(' · ');
  }
  function render(a){
    const flow=(a.net.up+a.net.down)>2048||a.tps>0;
    spark.push(a.net.up+a.net.down+a.tps*4096);if(spark.length>30)spark.shift();
    const max=Math.max(1,...spark),bars=$('#activitySpark');
    if(bars.children.length!==20)bars.innerHTML='<i></i>'.repeat(20);
    const last=spark.slice(-20);
    [...bars.children].forEach((b,i)=>{const v=last[i-(20-last.length)]||0;b.style.height=Math.max(1,Math.round(v/max*13))+'px';});
    el.classList.toggle('idle',!a.roles.length&&!flow);el.classList.toggle('flow',flow);
    $('#activityRole').textContent=roleText(a);el.title=roleText(a)+' — '+t('activity.open');
    $('#activityRes').textContent=t('activity.cpu',{n:a.cpu})+' · '+t('activity.ram',{used:gbs(a.ram.used),total:gbs(a.ram.total)});
    const g=a.gpus||[];
    $('#activityGpu').textContent=g.map(x=>x.shared?t('activity.gpuShared',{name:x.name}):t('activity.gpu',{name:shortGpu(x.name),used:(x.usedMiB/1024).toFixed(1),total:(x.totalMiB/1024).toFixed(1)})+(x.util!=null?' · '+x.util+'%':'')).join(' · ');
    $('#activityGpu').hidden=!g.length;
    $('#activityNet').textContent=t('activity.net',{up:kvRate(a.net.up),down:kvRate(a.net.down)})+(a.tps?' · '+t('activity.tps',{n:a.tps}):'');
  }
  async function tick(){
    if(document.hidden||!token)return;
    try{render(await api('/api/devices/activity'));failures=0;el.hidden=false;}catch{if(++failures>3)el.hidden=true;}
  }
  el.onclick=()=>{if(!busy)window.openDevices?.();else toast(t('busy.stopFirst'));};
  timer=setInterval(tick,1000);document.addEventListener('visibilitychange',tick);
})();

init();
