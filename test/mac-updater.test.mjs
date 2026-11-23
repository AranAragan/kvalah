// macOS self-update for unsigned builds (mac-updater.cjs). Runs on any OS: the helper script is
// exercised with stand-ins for `open` and `ditto`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {tempDir} from './helpers.mjs';

const require=createRequire(import.meta.url);
const mac=require('../mac-updater.cjs');
const YML=`version: 0.8.2
files:
  - url: kvalah-0.8.2-mac-x64.zip
    sha512: ${'A'.repeat(86)}==
    size: 124944300
  - url: kvalah-0.8.2-mac-arm64.zip
    sha512: ${'B'.repeat(86)}==
    size: 117800076
  - url: kvalah-0.8.2-mac-x64.dmg
    sha512: ${'C'.repeat(86)}==
    size: 128355925
  - url: kvalah-0.8.2-mac-arm64.dmg
    sha512: ${'D'.repeat(86)}==
    size: 121204361
path: kvalah-0.8.2-mac-x64.zip
sha512: ${'A'.repeat(86)}==
releaseDate: '2026-11-23T16:37:02.505Z'
`;

test('latest-mac.yml parsing and the zip for this CPU',()=>{
  const info=mac.parseLatestYml(YML);
  assert.equal(info.version,'0.8.2');assert.equal(info.releaseDate,'2026-11-23T16:37:02.505Z');
  assert.equal(info.files.length,4);assert.deepEqual(info.files[1],{url:'kvalah-0.8.2-mac-arm64.zip',sha512:'B'.repeat(86)+'==',size:117800076});
  assert.equal(mac.pickMacZip(info,'arm64').url,'kvalah-0.8.2-mac-arm64.zip');
  assert.equal(mac.pickMacZip(info,'x64').url,'kvalah-0.8.2-mac-x64.zip');
  assert.equal(mac.pickMacZip(info,'ia32'),null);
  assert.equal(mac.pickMacZip({files:info.files.filter(f=>!f.url.endsWith('.zip'))},'arm64'),null,'never a dmg');
  assert.equal(mac.pickMacZip({files:[{url:'../evil-mac-arm64.zip',sha512:'B'.repeat(86)+'==',size:1}]},'arm64'),null);
  assert.equal(mac.pickMacZip({files:[{url:'kvalah-0.8.2-mac-arm64.zip',sha512:'',size:1}]},'arm64'),null,'no checksum, no update');
  assert.deepEqual(mac.parseLatestYml('').files,[]);
  // CRLF and quoted values.
  assert.equal(mac.parseLatestYml("version: '0.9.0'\r\nfiles:\r\n  - url: \"a-mac-x64.zip\"\r\n    size: 3\r\n").files[0].url,'a-mac-x64.zip');
});

test('download verification: size, sha512 (latest-mac.yml) and SHA256SUMS.txt',async()=>{
  const dir=await tempDir(),file=path.join(dir,'kvalah-0.8.2-mac-arm64.zip'),data=crypto.randomBytes(5000);
  fs.writeFileSync(file,data);
  const sha512=crypto.createHash('sha512').update(data).digest('base64'),sha256=crypto.createHash('sha256').update(data).digest('hex');
  assert.deepEqual(await mac.verifyDownload(file,{sha512,size:5000}),{ok:true});
  assert.deepEqual(await mac.verifyDownload(file,{sha512,size:5000,sha256}),{ok:true});
  assert.equal((await mac.verifyDownload(file,{sha512,size:4999})).ok,false);
  assert.equal((await mac.verifyDownload(file,{sha512:'x'+sha512.slice(1),size:5000})).error,'sha512 mismatch');
  assert.equal((await mac.verifyDownload(file,{sha512,size:5000,sha256:'0'.repeat(64)})).error,'sha256 mismatch');
  assert.equal((await mac.verifyDownload(file,{size:5000})).ok,false,'a checksum is required');
  const sums=mac.parseSha256Sums(`${sha256}  kvalah-0.8.2-mac-arm64.zip\n${'f'.repeat(64)} *kvalah-0.8.2-win-x64-setup.exe\nnoise\n`);
  assert.equal(sums['kvalah-0.8.2-mac-arm64.zip'],sha256);assert.equal(sums['kvalah-0.8.2-win-x64-setup.exe'],'f'.repeat(64));
});

test('install location: App Translocation, disk image, Downloads need a move to Applications',()=>{
  const home='/Users/enver';
  assert.equal(mac.bundleFromExec('/Applications/kvalah.app/Contents/MacOS/kvalah'),'/Applications/kvalah.app');
  assert.deepEqual(mac.macInstallLocation('/Applications/kvalah.app',{home}),{ok:true});
  assert.deepEqual(mac.macInstallLocation('/Users/enver/Applications/kvalah.app',{home}),{ok:true});
  assert.deepEqual(mac.macInstallLocation('/Volumes/SSD/Applications/kvalah.app',{home}),{ok:true});
  assert.equal(mac.macInstallLocation('/private/var/folders/x1/abc/T/AppTranslocation/1A2B-3C/d/kvalah.app',{home}).reason,'translocated');
  assert.equal(mac.macInstallLocation('/Volumes/kvalah 0.8.1-arm64/kvalah.app',{home}).reason,'dmg');
  assert.equal(mac.macInstallLocation('/Users/enver/Downloads/kvalah.app',{home}).reason,'downloads');
  assert.equal(mac.macInstallLocation('/Users/enver/Downloads/kvalah-0.8.1-mac-arm64/kvalah.app',{home}).reason,'downloads');
  assert.equal(mac.macInstallLocation('/private/var/folders/x1/abc/T/kvalah.app',{home}).reason,'temporary');
  assert.equal(mac.macInstallLocation('/opt/kvalah/kvalah',{home}).reason,'notBundle');
});

test('helper script: values are quoted, inputs validated',()=>{
  const s=mac.helperScript({pid:4242,app:"/Applications/it's kvalah.app",newApp:'/Users/e/Library/Application Support/kvalah/updates/staging-0.8.2/kvalah.app',version:'0.8.2',updates:'/Users/e/Library/Application Support/kvalah/updates',prompt:'kvalah "wants" $(rm -rf /)',suffix:'abcd'});
  assert.match(s,/^#!\/bin\/bash\n/);
  assert.ok(s.includes(`APP='/Applications/it'\\''s kvalah.app'`));
  assert.ok(s.includes(`PROMPT='kvalah "wants" $(rm -rf /)'`),'the prompt is data, not code');
  assert.ok(s.includes(`STAGE='/Applications/.it'\\''s kvalah.app.update-abcd'`));
  assert.match(s,/with administrator privileges/);assert.match(s,/quoted form of \(item 1 of argv\)/);
  assert.equal(spawnSync('bash',['-n'],{input:s}).status,0,'valid bash');
  assert.throws(()=>mac.helperScript({pid:1,app:'/A.app',newApp:'/B.app',version:'1.0.0; rm -rf ~',updates:'/u'}),/bad version/);
  assert.throws(()=>mac.helperScript({pid:0,app:'/A.app',newApp:'/B.app',version:'1.0.0',updates:'/u'}),/bad pid/);
  assert.throws(()=>mac.helperScript({pid:1,app:'/A.app',newApp:'/B.app',version:'1.0.0',updates:'/u',exe:'a b'}),/bad executable/);
});

// Fake bundles + stand-ins for `open` (writes the launch marker like the new app would) and `ditto`.
async function scenario({launches=true,newHasExe=true}={}){
  const root=await tempDir('kvalah mac '),apps=path.join(root,'Apps'),updates=path.join(root,'updates');
  const bundle=(dir,ver,exe=true)=>{fs.mkdirSync(path.join(dir,'Contents','MacOS'),{recursive:true});fs.writeFileSync(path.join(dir,'Contents','version'),ver);if(exe)fs.writeFileSync(path.join(dir,'Contents','MacOS','kvalah'),'#!/bin/sh\n',{mode:0o755});};
  const app=path.join(apps,'kvalah.app'),newApp=path.join(updates,'staging-0.8.2','kvalah.app');
  bundle(app,'0.8.1');bundle(newApp,'0.8.2',newHasExe);
  const opened=path.join(root,'opened.txt'),open=path.join(root,'fake-open.sh');
  fs.writeFileSync(open,`#!/bin/bash\necho "$1 $(cat "$1/Contents/version")" >> "${opened}"\n`+(launches?`[ "$(cat "$1/Contents/version")" = 0.8.2 ] && touch "${path.join(updates,'launched-0.8.2')}"\n`:''),{mode:0o755});
  const app0=spawn('sleep',['30']);
  const script=path.join(updates,'install-0.8.2.sh');
  fs.writeFileSync(script,mac.helperScript({pid:app0.pid,app,newApp,version:'0.8.2',updates,openCmd:open,copyCmd:'cp -R',launchTimeout:2,quitTimeout:10,suffix:'t1'}),{mode:0o700});
  const helper=spawn('/bin/bash',[script],{stdio:'ignore'});
  await new Promise(r=>setTimeout(r,400));
  assert.equal(fs.readFileSync(path.join(app,'Contents','version'),'utf8'),'0.8.1','nothing changes while kvalah runs');
  app0.kill();
  const code=await new Promise(r=>helper.on('exit',r));
  const read=f=>{try{return fs.readFileSync(f,'utf8');}catch{return null;}};
  return {code,root,apps,app,updates,version:read(path.join(app,'Contents','version')),opened:read(opened),result:JSON.parse(read(path.join(updates,'result.json'))),log:read(path.join(updates,'install.log')),left:fs.readdirSync(apps)};
}

test('helper script: waits for quit, swaps the bundle in place, relaunches, cleans up',{skip:process.platform==='win32'},async()=>{
  const r=await scenario();
  assert.equal(r.code,0,r.log);assert.equal(r.version,'0.8.2');
  assert.equal(r.result.ok,true);assert.equal(r.result.version,'0.8.2');
  assert.equal(r.opened.trim(),r.app+' 0.8.2');
  assert.deepEqual(r.left,['kvalah.app'],'no stage or backup left');
  assert.equal(fs.existsSync(path.join(r.updates,'staging-0.8.2')),true);assert.equal(fs.existsSync(path.join(r.updates,'staging-0.8.2','kvalah.app')),false);
});

test('helper script: rolls back when the new version does not start',{skip:process.platform==='win32',timeout:30000},async()=>{
  const r=await scenario({launches:false});
  assert.equal(r.code,1);assert.equal(r.version,'0.8.1','old version restored');
  assert.equal(r.result.ok,false);assert.match(r.result.error,/did not start/);
  assert.deepEqual(r.opened.trim().split('\n'),[r.app+' 0.8.2',r.app+' 0.8.1']);
  assert.deepEqual(r.left,['kvalah.app']);
});

test('helper script: a broken new bundle is never swapped in',{skip:process.platform==='win32'},async()=>{
  const r=await scenario({newHasExe:false});
  assert.equal(r.code,1);assert.equal(r.version,'0.8.1');assert.match(r.result.error,/swap failed/);
  assert.equal(r.opened.trim(),r.app+' 0.8.1','the old app is reopened');assert.deepEqual(r.left,['kvalah.app']);
});

test('controller: newer release outside Applications asks to move; bad checksum falls back to the download link',async()=>{
  const userData=await tempDir(),zip=crypto.randomBytes(2048);
  const yml=`version: 0.8.2\nfiles:\n  - url: kvalah-0.8.2-mac-arm64.zip\n    sha512: ${crypto.createHash('sha512').update(Buffer.from('other')).digest('base64')}\n    size: ${zip.length}\n`;
  const fetchImpl=async url=>{
    if(url.endsWith('latest-mac.yml'))return new Response(yml);
    if(url.endsWith('SHA256SUMS.txt'))return new Response('',{status:404});
    if(url.endsWith('.zip'))return new Response(zip,{headers:{'content-length':String(zip.length)}});
    return new Response('',{status:404});
  };
  const states=[];
  const moved=mac.createMacUpdater({owner:'o',repo:'r',currentVersion:'0.8.1',userData,execPath:'/private/var/folders/a/T/AppTranslocation/X/d/kvalah.app/Contents/MacOS/kvalah',arch:'arm64',publish:s=>states.push(s),fetchImpl,quit:()=>{}});
  assert.deepEqual(await moved.check(),{available:true,version:'0.8.2',manual:true});
  assert.deepEqual(states.at(-1),{state:'available',version:'0.8.2',url:'https://github.com/o/r/releases/tag/v0.8.2',manual:true,reason:'location',progress:null});
  states.length=0;
  const inApps=mac.createMacUpdater({owner:'o',repo:'r',currentVersion:'0.8.1',userData,execPath:'/Applications/kvalah.app/Contents/MacOS/kvalah',arch:'arm64',publish:s=>states.push(s),fetchImpl,quit:()=>{}});
  assert.deepEqual(await inApps.check(),{available:true,version:'0.8.2',manual:true});
  assert.equal(states[0].state,'downloading');assert.equal(states.at(-1).reason,'failed');
  assert.deepEqual(fs.readdirSync(path.join(userData,'updates')),[],'a bad download is deleted');
  assert.equal(inApps.install(),false,'nothing to install');
  const same=mac.createMacUpdater({owner:'o',repo:'r',currentVersion:'0.8.2',userData,execPath:'/Applications/kvalah.app/Contents/MacOS/kvalah',arch:'arm64',publish:()=>{},fetchImpl,quit:()=>{}});
  assert.deepEqual(await same.check(),{available:false});
});

test('controller: a failed install of the same version is not retried in a loop',async()=>{
  const userData=await tempDir();fs.mkdirSync(path.join(userData,'updates'));
  fs.writeFileSync(path.join(userData,'updates','result.json'),JSON.stringify({ok:false,version:'0.8.2',error:'swap failed'}));
  let fetched=[];const states=[];
  const fetchImpl=async url=>{fetched.push(url);return new Response('version: 0.8.2\nfiles:\n');};
  const u=mac.createMacUpdater({owner:'o',repo:'r',currentVersion:'0.8.1',userData,execPath:'/Applications/kvalah.app/Contents/MacOS/kvalah',arch:'arm64',publish:s=>states.push(s),fetchImpl,quit:()=>{}});
  await u.check();
  assert.equal(states.at(-1).reason,'failed');assert.deepEqual(fetched,['https://github.com/o/r/releases/latest/download/latest-mac.yml']);
  assert.equal(fs.existsSync(path.join(userData,'updates','result.json')),false);
});

test('markLaunched writes the marker the helper waits for',async()=>{
  const dir=path.join(await tempDir(),'updates');mac.markLaunched(dir,'0.8.2');
  assert.ok(fs.existsSync(path.join(dir,'launched-0.8.2')));
});
