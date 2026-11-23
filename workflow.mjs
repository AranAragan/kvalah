import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {safePath} from './core.mjs';
import {canonicalPath,contains} from './permissions.mjs';
import {walkFiles} from './search.mjs';
import {gitStatus} from './git.mjs';
import {decodeText,encodeText,replaceFragment,unifiedDiff,diffStats,applyHunks,toLF} from './patch.mjs';

export const hash=value=>createHash('sha256').update(value).digest('hex');
const exists=async p=>{try{await fs.access(p);return true;}catch{return false;}};
const limited=async p=>(await fs.readFile(p,'utf8')).slice(0,16000);
export function detectContract(goal){
  return {exe:/\.exe|\bexe\b|исполняем|(?:приложен|программ|калькулятор).*(?:windows|виндовс)|приложен.*(?:рабоч.{0,12}стол|desktop)/i.test(goal),desktop:/рабоч.{0,12}стол|desktop/i.test(goal)};
}
// A workflow describes the CURRENT task. A finished (or fresh) task starts a new workflow for the new
// request; unfinished work keeps its plan but the contract is widened by new requirements.
export function taskFor(chat,goal){
  const w=chat.workflow,contract=detectContract(goal||'');
  if(!w){chat.workflow={id:randomUUID(),goal,phase:'inspect',revision:0,steps:[],changes:[],checks:[],managedFiles:{},note:'',contract,created:Date.now(),history:[]};return chat.workflow;}
  if(w.phase==='completed'){
    (w.history??=[]).push({id:w.id,goal:w.goal,phase:w.phase,finished:Date.now()});w.history=w.history.slice(-20);
    Object.assign(w,{id:randomUUID(),goal,phase:w.inspection?'implement':'inspect',steps:[],checks:[],note:'',contract,created:Date.now()});
    return w;
  }
  w.contract={exe:!!(w.contract?.exe||contract.exe),desktop:!!(w.contract?.desktop||contract.desktop)};
  if(goal&&goal!==w.goal&&!String(w.goal).includes(goal))w.goal=(String(w.goal||'')+'\nДополнение: '+goal).slice(-4000);
  return w;
}
async function managedPath(chat,name){
  const root=chat.project.path,w=chat.workflow;w.managedFiles??={};
  if(!w.managedFiles[name])w.managedFiles[name]=chat.project.existing||await exists(await safePath(root,name))?'.kvalah/'+name:name;
  const p=await safePath(root,w.managedFiles[name]);await fs.mkdir(path.dirname(p),{recursive:true});await safePath(root,w.managedFiles[name]);return p;
}
export async function saveWorkflow(chat){
  if(!chat.workflow||!chat.project)return;
  const w=chat.workflow;
  const plan='# Project plan\n\n'+w.goal+'\n\n'+w.steps.map((s,i)=>`${s.status==='done'?'- [x]':'- [ ]'} ${i+1}. ${s.title} (${s.status})`).join('\n')+'\n';
  const status='# Project status\n\nPhase: '+w.phase+'\nRevision: '+w.revision+'\n\n'+w.note+'\n\nChecks:\n'+w.checks.slice(-8).map(c=>`- ${c.passed?'PASS':'FAIL'} r${c.revision}: ${c.command}\n  ${c.message||''}`).join('\n')+'\n';
  for(const [name,text] of [['PLAN.md',plan],['STATUS.md',status]])await fs.writeFile(await managedPath(chat,name),text,'utf8');
}
// Rules are collected from the workspace root (new projects) or the project/repository root (opened folders).
export function rulesBase(chat,workspace){return chat.project?.existing?(chat.project.rulesRoot||chat.project.path):workspace;}
export async function inspectProject(chat,base,subpath='.'){
  const root=chat.project.path,target=await safePath(root,subpath);
  const {files:walked,truncated}=await walkFiles(root,{start:target,limit:180,maxDepth:3,dirs:true});
  const files=walked.map(f=>({path:path.relative(root,f.full),type:f.dir?'directory':'file'}));
  const configs=[];
  for(const item of files){if(item.type==='file'&&/^(README(?:\.[\w-]+)?|package\.json|pyproject\.toml|requirements\.txt|Cargo\.toml|go\.mod|.*\.csproj|.*\.sln|CMakeLists\.txt|Makefile|tsconfig\.json)$/i.test(path.basename(item.path))){
    const p=await safePath(root,item.path);if((await fs.stat(p)).size<100000)configs.push({path:item.path,content:await limited(p)});if(configs.length>=8)break;
  }}
  const rules=await applicableRules(base,target);
  chat.workflow.seenRules??={};for(const r of rules)chat.workflow.seenRules[r.path]=r.hash;
  const git=await gitStatus(root).catch(()=>({repository:false}));
  const result={root,files,truncated,configs,rules,git};
  chat.workflow.inspection={at:Date.now(),tree:files.slice(0,60),configFiles:configs.map(c=>c.path),rules,git:{repository:git.repository,branch:git.branch,changes:git.changes?.length}};return result;
}
export async function applicableRules(base,target){
  const rules=[],baseReal=await fs.realpath(base);let dir=target,ancestors=[];
  while(contains(baseReal,dir)){ancestors.unshift(dir);if(dir===baseReal)break;dir=path.dirname(dir);}
  for(const ancestor of ancestors)for(const name of ['AGENTS.md','AGENTS.override.md']){
    const candidate=path.join(ancestor,name);
    if(await exists(candidate)){const real=await fs.realpath(candidate);if(contains(baseReal,real)){
      if((await fs.stat(real)).size>256000)throw Error('Instructions file is too large: '+candidate);
      const content=await fs.readFile(real,'utf8');rules.push({path:candidate,hash:hash(content),content});
    }}
  }
  return rules;
}
export async function updatePlan(chat,args){
  if(!chat.workflow.inspection)throw Error('Run inspect_project before planning.');
  chat.workflow.steps=args.steps.map((s,i)=>({id:String(i+1),title:s.title.slice(0,300),status:s.status||'pending'}));
  chat.workflow.note=String(args.note||'').slice(0,3000);if(chat.workflow.phase==='inspect'||chat.workflow.phase==='completed')chat.workflow.phase='implement';await saveWorkflow(chat);return chat.workflow;
}
export function dirty(chat,note){
  if(!chat.workflow)return;
  chat.workflow.revision++;chat.workflow.phase='implement';chat.workflow.note=note;
}
export function assertReadyToEdit(chat){
  if(!chat.workflow?.inspection)throw Error('First call inspect_project to read the project and applicable instructions.');
  if(!chat.workflow.steps.length)throw Error('First call update_plan with concrete steps and acceptance checks.');
}
export const diffText=(before,after,file)=>unifiedDiff(before,after,file||'file');
async function readExisting(file){
  try{return await fs.readFile(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}
}
function editable(buffer,file){
  const info=decodeText(buffer);
  if(!info.utf8)throw Error('File is not valid UTF-8 (possibly a legacy encoding or binary): '+file+'. Refusing to edit it to avoid corruption.');
  return info;
}
// Writes bytes (or deletes when next===null) with a checkpoint for undo. All file tools end here.
export async function changeFile(chat,file,content,dataDir,expectedHash,{bytes,root}={}){
  assertReadyToEdit(chat);
  const beforeBuf=await readExisting(file),before=beforeBuf===null?null:beforeBuf.toString('utf8');
  if(beforeBuf!==null&&!expectedHash)throw Error('Read the full file before replacing it, or use edit_file/apply_patch for exact fragments.');
  if(expectedHash&&hash(beforeBuf??'')!==expectedHash)throw Error('File changed since it was read. Read it again before editing.');
  const deleting=content===null;
  if(deleting&&beforeBuf===null)throw Error('File does not exist: '+file);
  const nextBuf=deleting?null:bytes||Buffer.from(content,'utf8');
  if(!deleting&&beforeBuf&&beforeBuf.equals(nextBuf))return {saved:file,unchanged:true,hash:hash(nextBuf)};
  const id=randomUUID(),snapshot={id,file,before,beforeBase64:beforeBuf&&!decodeText(beforeBuf).utf8?beforeBuf.toString('base64'):undefined,deleted:deleting,afterHash:deleting?null:hash(nextBuf),created:Date.now()};
  const store=path.join(dataDir,'checkpoints');await fs.mkdir(store,{recursive:true});
  await fs.writeFile(path.join(store,id+'.json'),JSON.stringify(snapshot),{flag:'wx'});
  if(!deleting)await fs.mkdir(path.dirname(file),{recursive:true});
  if(await canonicalPath(file)!==file)throw Error('Target path changed during edit.');
  const current=await readExisting(file);
  if(!(current===null&&beforeBuf===null)&&!(current&&beforeBuf&&current.equals(beforeBuf)))throw Error('Concurrent file change detected. Nothing was overwritten.');
  if(deleting)await fs.unlink(file);else await fs.writeFile(file,nextBuf);
  dirty(chat,(deleting?'File deleted: ':'File changed: ')+file);
  const label=root&&contains(root,file)?path.relative(root,file).split(path.sep).join('/'):path.basename(file);
  const diff=diffText(before===null?null:toLF(before),deleting?null:toLF(nextBuf.toString('utf8')),label);
  const change={id,path:file,created:Date.now(),hash:snapshot.afterHash,deleted:deleting,diff,stats:diffStats(diff)};
  chat.workflow.changes.push(change);chat.workflow.changes=chat.workflow.changes.slice(-200);
  await saveWorkflow(chat);return {saved:file,deleted:deleting||undefined,bytes:nextBuf?.length||0,hash:change.hash,changeId:id,diff:change.diff,...change.stats};
}
// Full replacement keeps the file's BOM and line endings.
export async function writeFile(chat,file,content,dataDir,expectedHash,root){
  const beforeBuf=await readExisting(file);
  const info=beforeBuf?editable(beforeBuf,file):{bom:false,eol:/\r\n/.test(content)?'\r\n':'\n'};
  return changeFile(chat,file,'',dataDir,expectedHash,{bytes:encodeText(toLF(content),info),root});
}
export async function editFile(chat,file,args,dataDir,root){
  const beforeBuf=await fs.readFile(file),info=editable(beforeBuf,file);
  const {content,count,strategy}=replaceFragment(info.text,args.old_text,args.new_text,args.replace_all===true);
  const result=await changeFile(chat,file,'',dataDir,args.expectedHash||hash(beforeBuf),{bytes:encodeText(content,info),root});
  return {...result,replacements:count,match:strategy};
}
export async function appendFile(chat,file,text,dataDir,root){
  const beforeBuf=await readExisting(file);
  const info=beforeBuf?editable(beforeBuf,file):{text:'',bom:false,eol:/\r\n/.test(text)?'\r\n':'\n'};
  const joined=info.text+(info.text&&!info.text.endsWith('\n')&&!toLF(text).startsWith('\n')?'\n':'')+toLF(text);
  const result=await changeFile(chat,file,'',dataDir,beforeBuf?hash(beforeBuf):undefined,{bytes:encodeText(joined,info),root});
  return {...result,diff:undefined,appended:Buffer.byteLength(text),totalLines:joined.split('\n').length};
}
// ops: parsed patch operations with absolute paths already permission-checked (path, moveTo).
export async function applyPatch(chat,ops,dataDir,root){
  assertReadyToEdit(chat);
  const plan=[];
  for(const op of ops){
    const beforeBuf=await readExisting(op.path);
    if(op.type==='add'){if(beforeBuf!==null)throw Error('Add File: file already exists: '+op.path+'. Use Update File.');plan.push({file:op.path,bytes:encodeText(op.lines.join('\n')+'\n',{eol:'\n'})});continue;}
    if(beforeBuf===null)throw Error((op.type==='delete'?'Delete':'Update')+' File: not found: '+op.path);
    const info=editable(beforeBuf,op.path);
    if(op.type==='delete'){plan.push({file:op.path,delete:true,expected:hash(beforeBuf)});continue;}
    const next=applyHunks(info.text,op.hunks,path.basename(op.path));
    if(op.moveTo&&op.moveTo!==op.path){if(await readExisting(op.moveTo)!==null)throw Error('Move to: target exists: '+op.moveTo);plan.push({file:op.moveTo,bytes:encodeText(next,info)},{file:op.path,delete:true,expected:hash(beforeBuf)});}
    else plan.push({file:op.path,bytes:encodeText(next,info),expected:hash(beforeBuf)});
  }
  const results=[];
  for(const step of plan){
    const r=step.delete?await changeFile(chat,step.file,null,dataDir,step.expected,{root}):await changeFile(chat,step.file,'',dataDir,step.expected,{bytes:step.bytes,root});
    results.push({path:step.file,deleted:r.deleted,unchanged:r.unchanged,changeId:r.changeId,added:r.added,removed:r.removed,diff:r.diff});
  }
  return {applied:results.length,files:results};
}
export async function undoChange(chat,id,dataDir){
  const change=chat.workflow?.changes.find(c=>c.id===id&&!c.undone);if(!change)throw Error('Change not found.');
  const snapshot=JSON.parse(await fs.readFile(path.join(dataDir,'checkpoints',change.id+'.json'),'utf8'));
  if(await canonicalPath(snapshot.file)!==snapshot.file)throw Error('Path changed; automatic undo refused.');
  const current=await readExisting(snapshot.file);
  if(snapshot.deleted){if(current!==null)throw Error('A file was created at this path after deletion. Undo refused to preserve newer work.');}
  else if(current===null||hash(current)!==snapshot.afterHash)throw Error('File was modified after this change. Undo refused to preserve newer work.');
  if(snapshot.before===null)await fs.unlink(snapshot.file);
  else{await fs.mkdir(path.dirname(snapshot.file),{recursive:true});await fs.writeFile(snapshot.file,snapshot.beforeBase64?Buffer.from(snapshot.beforeBase64,'base64'):snapshot.before,snapshot.beforeBase64?undefined:'utf8');}
  change.undone=true;dirty(chat,'Restored file: '+snapshot.file);await saveWorkflow(chat);return {restored:snapshot.file};
}
export async function inspectArtifacts(paths){
  const results=[];
  for(const a of paths){
    try{
      const stat=await fs.stat(a.path);if(!stat.isFile()||!stat.size)throw Error('File missing or empty');
      const data=await fs.readFile(a.path);
      if(a.kind==='exe'&&(data[0]!==0x4d||data[1]!==0x5a))throw Error('Not a Windows executable (MZ header missing)');
      results.push({...a,size:stat.size,hash:hash(data),exists:true});
    }catch(e){results.push({...a,exists:false,error:e.message});}
  }
  return results;
}
// Fingerprint of project sources: honours .gitignore and skips dependency/build folders.
export async function sourceSnapshot(root){
  const {files,truncated}=await walkFiles(root,{limit:5001});
  if(truncated)throw Error('Project exceeds the verification scan limit (5000 source files after .gitignore); narrow the project folder or extend .gitignore.');
  const entries=[];
  for(const f of files){
    if(f.path==='PLAN.md'||f.path==='STATUS.md')continue;
    if(/\.(exe|dll|pdb|pak|bin|png|jpe?g|gif|ico|zip|7z|so|dylib|o|obj|class|pyc)$/i.test(f.path))continue;
    let stat;try{stat=await fs.stat(f.full);}catch{continue;}if(stat.size>2000000)continue;
    entries.push([f.path,hash(await fs.readFile(f.full))]);
  }
  return hash(JSON.stringify(entries.sort((a,b)=>a[0].localeCompare(b[0]))));
}
export async function finishTask(chat,summary,desktop){
  const w=chat.workflow;if(!w?.steps.length)throw Error('No project plan. Use update_plan first.');
  const evidence=w.checks.filter(c=>c.passed&&c.revision===w.revision);
  if(!evidence.length)throw Error('No successful verification for the current revision. Run verify_project.');
  const artifacts=evidence.flatMap(c=>c.artifacts||[]);
  if(w.contract.exe&&!artifacts.some(a=>a.kind==='exe'&&a.exists))throw Error('The requested EXE was not verified.');
  if(w.contract.desktop&&!artifacts.some(a=>a.exists&&contains(desktop,a.path)))throw Error('The requested desktop artifact was not verified at the desktop path.');
  if(w.contract.exe&&!evidence.some(c=>c.launched))throw Error('The EXE has not passed a launch check.');
  for(const a of artifacts)if(a.exists&&hash(await fs.readFile(a.path))!==a.hash)throw Error('Artifact changed after verification: '+a.path);
  if(await sourceSnapshot(chat.project.path)!==evidence.at(-1).sourceHash)throw Error('Source changed after verification; run verify_project again.');
  w.phase='completed';w.note=summary;w.steps=w.steps.map(s=>({...s,status:'done'}));await saveWorkflow(chat);
  return {completed:true,summary,checks:evidence.map(c=>c.command),artifacts};
}
