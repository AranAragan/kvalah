// SEC-02 regression: safe workspace. Each case must not disclose data outside the allowed area.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,symlink,link,open,appendFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import * as F from '../compute/files.mjs';
const {createFileReader,isDenied}=F;const lexicalCheck=(...a)=>{if(!F.lexicalCheck)throw Error('lexicalCheck missing (v0.2 has no Windows lexical check)');return F.lexicalCheck(...a);};
import {walk} from '../compute/deterministic/walk.mjs';
import {buildServer} from '../mcp/server.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {smartMock} from './helpers.mjs';

const OUTSIDE='TOP-SECRET-OUTSIDE-ROOT';
const UNSUPPORTED=new Set();
async function setup(){
  const base=await mkdtemp(path.join(tmpdir(),'kvo3-sec02-'));
  const root=path.join(base,'ws'),out=path.join(base,'outside');
  await mkdir(root);await mkdir(out);
  await writeFile(path.join(out,'secret.txt'),OUTSIDE);
  await writeFile(path.join(root,'ok.txt'),'hello\n');
  await mkdir(path.join(root,'.GIT'));await writeFile(path.join(root,'.GIT','config'),OUTSIDE);
  await mkdir(path.join(root,'.SSH'));await writeFile(path.join(root,'.SSH','known'),OUTSIDE);
  await writeFile(path.join(root,'.ENV'),OUTSIDE);
  await writeFile(path.join(root,'.Env.Local'),OUTSIDE);
  // Symlinks may need privileges on Windows and FIFOs are POSIX-only: cases that cannot be created are not asserted (UNSUPPORTED).
  await symlink(path.join(out,'secret.txt'),path.join(root,'link.txt')).catch(()=>UNSUPPORTED.add('link.txt'));
  await symlink(out,path.join(root,'dirlink'),'junction').catch(()=>UNSUPPORTED.add('dirlink/secret.txt'));
  await link(path.join(out,'secret.txt'),path.join(root,'hard.txt')); // hardlink to a file outside
  if(process.platform!=='win32')execFileSync('mkfifo',[path.join(root,'pipe')]);else UNSUPPORTED.add('pipe');
  await writeFile(path.join(root,'bin.dat'),Buffer.from([1,2,0,3,4]));
  return {base,root,out};
}
const noLeak=(v)=>assert.ok(!JSON.stringify(v??'').includes(OUTSIDE),'leaked: '+JSON.stringify(v).slice(0,200));
async function expectReject(fn){let r;try{r=await fn();}catch(e){noLeak(e.message);return e;}noLeak(r);assert.fail('expected rejection, got '+JSON.stringify(r).slice(0,200));}

test('SEC-02: traversal, absolute, symlink (file + intermediate dir), hardlink, case-variant deny, FIFO, binary', async()=>{
  const {root,out}=await setup();
  const r=createFileReader({root});
  for(const p of ['../outside/secret.txt',path.join(out,'secret.txt'),'link.txt','dirlink/secret.txt','hard.txt','.GIT/config','.SSH/known','.ENV','.Env.Local','pipe','ok.txt\0x']){
    await expectReject(()=>r.read([p]));
    await expectReject(()=>r.readText(p));
    await expectReject(()=>r.sizes([p]));
  }
  await expectReject(()=>r.read(['bin.dat']));
  const bt=await r.readText('bin.dat');assert.equal(bt.skipped,'binary');
  assert.equal((await r.read(['ok.txt']))[0].text,'hello\n');
});

test('SEC-02: deny rules are case-insensitive; Windows lexical forms (UNC, device, ADS, drive) refused', ()=>{
  for(const p of ['.GIT/config','.Git/HEAD','.SSH/id_rsa','.ENV','.ENV.production','X/.AWS/credentials','.GNUPG/x','.NPMRC','NODE_MODULES/a.js'])assert.ok(isDenied(p),p);
  assert.ok(!isDenied('src/environment.ts'));assert.ok(!isDenied('docs/gitignore-guide.md'));
  for(const p of ['\\\\server\\share\\x.txt','//server/share/x.txt','\\\\?\\C:\\x.txt','\\\\.\\pipe\\x','file.txt:stream','file.txt::$DATA','C:\\Windows\\win.ini','C:x.txt','CON','nul.txt'])
    assert.throws(()=>lexicalCheck(p,'win32'),/rejected|outside|Invalid/i,p);
  assert.doesNotThrow(()=>lexicalCheck('src\\a.js','win32'));assert.doesNotThrow(()=>lexicalCheck('src/a.js','linux'));
});

test('SEC-02: bytes actually read are bounded even if the file grows after stat (readText and read)', async()=>{
  const {root}=await setup();
  await writeFile(path.join(root,'grow.log'),'a'.repeat(100));
  const r=createFileReader({root,maxBytesPerFile:150});
  // simulate growth between stat and read: the descriptor's stat reports the old size
  const probe=await open(path.join(root,'ok.txt'));const proto=Object.getPrototypeOf(probe);await probe.close();
  const orig=proto.stat;
  proto.stat=async function(...a){const st=await orig.apply(this,a);if(st.size===100){await appendFile(path.join(root,'grow.log'),'b'.repeat(10000));}return st;};
  try{
    const t=await r.readText('grow.log');
    assert.ok(t.skipped==='changed'||((t.text?.length??0)<=150),'readText read '+(t.text?.length)+' bytes past the limit');
  }finally{proto.stat=orig;}
  await writeFile(path.join(root,'grow.log'),'a'.repeat(100));
  proto.stat=async function(...a){const st=await orig.apply(this,a);if(st.size===100){await appendFile(path.join(root,'grow.log'),'b'.repeat(10000));}return st;};
  try{
    let res;try{res=await r.read(['grow.log']);}catch(e){assert.match(e.message,/changed|grew/i);res=null;}
    if(res)assert.ok(res[0].bytes<=150);
  }finally{proto.stat=orig;}
});

test('SEC-02: number of files bounded in sizes() and walk; root cannot be changed from MCP args', async()=>{
  const {root}=await setup();
  const r=createFileReader({root,maxFiles:8});
  await assert.rejects(()=>r.sizes(Array.from({length:50},()=>'ok.txt')),/Expected|paths|too many/i);
  const many=await mkdtemp(path.join(tmpdir(),'kvo3-walk-'));
  for(let i=0;i<30;i++)await writeFile(path.join(many,`f${i}.txt`),'x');
  const w=await walk(many,{maxFiles:10});assert.equal(w.files.length,10);assert.equal(w.truncated,true);
  // .GIT directory is never walked
  const w2=await walk(root,{});assert.ok(!w2.files.some(f=>/\.git\//i.test(f)),JSON.stringify(w2.files));
  const {server,app}=await buildServer({env:{KVALAH_MODEL:'mock',KVALAH_WORKSPACE:root,KVALAH_CACHE:'off'},provider:smartMock(),log:()=>{}});
  const [a,b]=InMemoryTransport.createLinkedPair();const c=new Client({name:'t',version:'1'});
  await Promise.all([server.connect(a),c.connect(b)]);
  try{
    for(const [name,args] of [['kvalah_compute',{op:'search',pattern:'SECRET',root:path.dirname(root)}],['kvalah_delegate',{task:'summarize',paths:['../outside/secret.txt']}],['kvalah_delegate',{task:'summarize',paths:['ok.txt'],workspace:'/'}]]){
      const res=await c.callTool({name,arguments:args});noLeak(res);assert.equal(res.isError,true,name+' '+JSON.stringify(res).slice(0,200));
    }
  }finally{await c.close();await app?.close();}
});
