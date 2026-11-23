// llama.cpp on Apple Silicon: the native (arm64) build must be used even when kvalah itself runs under
// Rosetta, because the macOS x64 llama.cpp build has no Metal backend.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as llama from '../llamacpp.mjs';
import {tempDir} from './helpers.mjs';

const macho=cpu=>{const b=Buffer.alloc(64);b.writeUInt32LE(0xfeedfacf,0);b.writeUInt32LE(cpu,4);return b;};
const ARM=macho(0x0100000c),X64=macho(0x01000007);

test('nativeArch: Rosetta and Apple Silicon detection',()=>{
  assert.equal(llama.nativeArch({platform:'darwin',arch:'x64',sysctl:n=>n==='sysctl.proc_translated'?'1':'0'}),'arm64');
  assert.equal(llama.nativeArch({platform:'darwin',arch:'x64',sysctl:n=>n==='hw.optional.arm64'?'1':''}),'arm64');
  assert.equal(llama.nativeArch({platform:'darwin',arch:'x64',sysctl:()=>''}),'x64','Intel Mac');
  assert.equal(llama.nativeArch({platform:'linux',arch:'x64',sysctl:()=>'1'}),'x64');
});

test('pickAssets: Apple Silicon gets the macOS arm64 build (the x64 one has no Metal)',()=>{
  const arm=llama.pickAssets({platform:'darwin',arch:'arm64',backend:'auto'});
  assert.match(arm.files[0].name,/macos-arm64\.tar\.gz$/);assert.equal(arm.backend,'metal');
  assert.match(llama.pickAssets({platform:'darwin',arch:'x64',backend:'auto'}).files[0].name,/macos-x64\.tar\.gz$/);
});

test('machOArch reads the CPU type of an executable',async()=>{
  const dir=await tempDir();
  fs.writeFileSync(path.join(dir,'a'),ARM);fs.writeFileSync(path.join(dir,'x'),X64);
  const fat=Buffer.alloc(16);fat.writeUInt32BE(0xcafebabe,0);fs.writeFileSync(path.join(dir,'u'),fat);
  fs.writeFileSync(path.join(dir,'e'),Buffer.from('\x7fELF....'));
  assert.equal(await llama.machOArch(path.join(dir,'a')),'arm64');
  assert.equal(await llama.machOArch(path.join(dir,'x')),'x64');
  assert.equal(await llama.machOArch(path.join(dir,'u')),'universal');
  assert.equal(await llama.machOArch(path.join(dir,'e')),null);
  assert.equal(await llama.machOArch(path.join(dir,'missing')),null);
});

test('locate/installed flag an Intel llama.cpp on Apple Silicon and prefer a matching build',async()=>{
  const root=await tempDir(),exe=process.platform==='win32'?'.exe':'';
  const put=(name,buf)=>{const d=path.join(root,name,'llama-'+llama.LLAMA_BUILD);fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,'llama-server'+exe),buf);fs.writeFileSync(path.join(d,'ggml-rpc-server'+exe),buf);};
  put(llama.LLAMA_BUILD+'-metal',X64);
  const old=await llama.installed(root,{platform:'darwin',want:'arm64'});
  assert.equal(old.arch,'x64');assert.equal(old.archMismatch,true);assert.equal(old.backend,'metal');
  assert.equal((await llama.installed(root,{platform:'darwin',want:'x64'})).archMismatch,false,'fine on an Intel Mac');
  put(llama.LLAMA_BUILD+'-auto',ARM);
  const good=await llama.installed(root,{platform:'darwin',want:'arm64'});
  assert.equal(good.arch,'arm64');assert.equal(good.archMismatch,false);
  const linux=await llama.installed(root,{platform:'linux',want:'x64'});
  assert.equal(linux.arch,undefined);assert.equal(linux.archMismatch,undefined);
});

test('managedProcess counts output lines (the loading watchdog uses it)',async()=>{
  const p=llama.managedProcess(process.execPath,['-e','for(let i=0;i<5;i++)console.log("line "+i)'],{cwd:process.cwd()});
  for(let i=0;i<100&&p.state.running;i++)await new Promise(r=>setTimeout(r,50));
  await new Promise(r=>setTimeout(r,100));
  assert.equal(p.state.lines,5);
});
