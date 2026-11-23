// Git helpers: read-only inspection, explicit commits, and a private "shadow" repository per chat
// that snapshots the project before every agent turn (covers edits made by shell commands too).
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';

const BASE=['-c','core.fsmonitor=false','-c','core.autocrlf=false','-c','core.quotepath=false','-c','user.name=kvalah','-c','user.email=kvalah@localhost','-c','commit.gpgsign=false'];
export function runGit(args,cwd,{gitDir,workTree,timeout=30000,maxBytes=2000000}={}){
  return new Promise(resolve=>{
    const extra=[...(gitDir?['--git-dir='+gitDir]:[]),...(workTree?['--work-tree='+workTree]:[])];
    let child;
    try{child=spawn('git',[...BASE,...extra,...args],{cwd,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0'}});}
    catch(e){resolve({code:-1,stdout:'',stderr:e.message,unavailable:true});return;}
    let stdout='',stderr='',done=false;
    const timer=setTimeout(()=>{child.kill();finish(-1,'git timeout');},timeout);
    function finish(code,err){if(done)return;done=true;clearTimeout(timer);resolve({code,stdout,stderr:err||stderr});}
    child.stdout.on('data',c=>{if(stdout.length<maxBytes)stdout+=c;});child.stderr.on('data',c=>{if(stderr.length<20000)stderr+=c;});
    child.on('error',e=>{done=true;clearTimeout(timer);resolve({code:-1,stdout:'',stderr:e.message,unavailable:true});});
    child.on('close',code=>finish(code));
  });
}
export async function repoRoot(dir){
  const r=await runGit(['rev-parse','--show-toplevel'],dir,{timeout:10000});
  return r.code===0?path.resolve(r.stdout.trim()):null;
}
export async function gitStatus(dir){
  const root=await repoRoot(dir);if(!root)return {repository:false};
  const r=await runGit(['status','--short','--branch','--untracked-files=normal'],dir);
  const lines=r.stdout.split('\n').filter(Boolean);
  return {repository:true,root,branch:lines[0]?.replace(/^## /,'')||'',changes:lines.slice(1,301),truncated:lines.length>301};
}
export async function gitDiff(dir,{file,staged=false,maxChars=30000}={}){
  if(!await repoRoot(dir))return {repository:false};
  const args=['diff','--no-color','--no-ext-diff',...(staged?['--cached']:[]),'--',...(file?[file]:[])];
  const r=await runGit(args,dir);const stat=await runGit(['diff','--stat','--no-color',...(staged?['--cached']:[]),'--',...(file?[file]:[])],dir);
  const untracked=(await runGit(['ls-files','--others','--exclude-standard'],dir)).stdout.split('\n').filter(Boolean).slice(0,100);
  return {repository:true,staged,stat:stat.stdout.trim().slice(0,4000),diff:r.stdout.slice(0,maxChars),truncated:r.stdout.length>maxChars,untracked};
}
export async function gitLog(dir,limit=15){
  if(!await repoRoot(dir))return {repository:false};
  const r=await runGit(['log','--no-color','-n',String(Math.min(50,limit)),'--pretty=format:%h %ad %an %s','--date=short'],dir);
  return {repository:true,log:r.stdout.split('\n').filter(Boolean)};
}
export async function gitCommit(dir,{message,files}){
  if(!await repoRoot(dir))throw Error('Not a Git repository. Run "git init" first if the user wants version control.');
  const add=await runGit(['add','--',...(files?.length?files:['.'])],dir);
  if(add.code!==0)throw Error('git add failed: '+add.stderr.slice(0,1000));
  const r=await runGit(['commit','-m',message],dir);
  if(r.code!==0)throw Error(/nothing to commit/.test(r.stdout+r.stderr)?'Nothing to commit.':'git commit failed: '+(r.stderr||r.stdout).slice(0,1500));
  const head=await runGit(['rev-parse','--short','HEAD'],dir);
  return {committed:true,commit:head.stdout.trim(),output:r.stdout.slice(0,2000)};
}
// Keeps kvalah's private files out of the user's repository without touching .gitignore.
export async function excludeKvalah(dir){
  const root=await repoRoot(dir);if(!root)return false;
  const r=await runGit(['rev-parse','--git-path','info/exclude'],root);if(r.code!==0)return false;
  const file=path.resolve(root,r.stdout.trim());
  let text='';try{text=await fs.readFile(file,'utf8');}catch{}
  if(/^\/?\.kvalah\/?$/m.test(text))return true;
  await fs.mkdir(path.dirname(file),{recursive:true});await fs.appendFile(file,(text&&!text.endsWith('\n')?'\n':'')+'.kvalah/\n');return true;
}

async function shadowRepo(dataDir,chatId,workTree){
  if(!/^[a-zA-Z0-9-]{1,80}$/.test(chatId))throw Error('bad chat id');
  const gitDir=path.join(dataDir,'shadow',chatId+'.git');
  try{await fs.access(path.join(gitDir,'HEAD'));}
  catch{
    await fs.mkdir(gitDir,{recursive:true});
    const r=await runGit(['init','--bare','-q',gitDir],dataDir);if(r.code!==0)throw Error(r.unavailable?'Git is not installed':'git init failed: '+r.stderr);
    await fs.mkdir(path.join(gitDir,'info'),{recursive:true});
    await fs.writeFile(path.join(gitDir,'info','exclude'),'.kvalah/\nnode_modules/\n.venv/\nvenv/\n__pycache__/\n');
  }
  return {gitDir,workTree};
}
// Snapshot the working tree; returns a commit id or null when Git is unavailable.
export async function snapshot(dataDir,chatId,workTree,label){
  const repo=await shadowRepo(dataDir,chatId,workTree);
  const add=await runGit(['add','-A','--ignore-errors','.'],workTree,{...repo,timeout:90000});
  if(add.code!==0&&add.code!==1)throw Error('snapshot add failed: '+add.stderr.slice(0,500));
  const commit=await runGit(['commit','-q','--allow-empty','--no-verify','-m',label||'kvalah checkpoint'],workTree,{...repo,timeout:60000});
  if(commit.code!==0)throw Error('snapshot commit failed: '+commit.stderr.slice(0,500));
  const head=await runGit(['rev-parse','HEAD'],workTree,repo);
  return head.stdout.trim();
}
// Lists files changed since the checkpoint (without modifying anything).
export async function changedSince(dataDir,chatId,workTree,commit){
  const repo=await shadowRepo(dataDir,chatId,workTree);
  await runGit(['add','-A','--ignore-errors','.'],workTree,{...repo,timeout:90000});
  const r=await runGit(['diff','--cached','--name-status','--no-renames',commit],workTree,repo);
  return r.stdout.split('\n').filter(Boolean).map(l=>{const [status,...rest]=l.split('\t');return {status,path:rest.join('\t')};});
}
// Restores the working tree to a checkpoint. Files created later are removed; ignored files stay.
export async function restore(dataDir,chatId,workTree,commit){
  if(!/^[0-9a-f]{7,64}$/.test(commit))throw Error('bad checkpoint');
  const repo=await shadowRepo(dataDir,chatId,workTree);
  const before=await snapshot(dataDir,chatId,workTree,'before rewind to '+commit.slice(0,10));
  const diff=await runGit(['diff','--name-status','--no-renames',commit,before],workTree,repo);
  const r=await runGit(['restore','--source='+commit,'--staged','--worktree','--','.'],workTree,{...repo,timeout:90000});
  if(r.code!==0)throw Error('restore failed: '+r.stderr.slice(0,800));
  return {restored:commit,safety:before,files:diff.stdout.split('\n').filter(Boolean).slice(0,300)};
}
