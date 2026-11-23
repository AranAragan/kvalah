// macOS CI smoke test of the self-update path on a real build (see mac-updater.cjs):
// checksum from latest-mac.yml → ditto/plutil/xattr/codesign → helper swaps an "installed" copy in a
// temporary Applications folder → relaunch with the real `open` → the new app writes its launch marker.
// Usage: node scripts/mac-update-smoke.mjs [release-dir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const mac=require('../mac-updater.cjs');
const pkg=require('../package.json');
if(process.platform!=='darwin'){console.log('macOS only');process.exit(0);}
const dir=path.resolve(process.argv[2]||'release'),version=pkg.version,arch=process.arch;
const step=m=>console.log('▶ '+m);
const yml=mac.parseLatestYml(fs.readFileSync(path.join(dir,'latest-mac.yml'),'utf8'));
const zip=mac.pickMacZip(yml,arch);if(!zip)throw Error('latest-mac.yml has no zip for '+arch);
const zipFile=path.join(dir,zip.url);
step('verify '+zip.url);
const v=await mac.verifyDownload(zipFile,zip);if(!v.ok)throw Error('checksum: '+v.error);

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'kvalah update '));
const apps=path.join(tmp,'Applications');fs.mkdirSync(apps);
const updates=path.join(os.homedir(),'Library','Application Support','kvalah','updates');fs.mkdirSync(updates,{recursive:true});
step('install the "old" copy into '+apps);
execFileSync('/usr/bin/ditto',['-x','-k',zipFile,apps]);
const app=path.join(apps,'kvalah.app');
fs.writeFileSync(path.join(app,'Contents','old-marker'),'old');
step('prepare the update bundle');
const newApp=await mac.prepareBundle(zipFile,path.join(updates,'staging-'+version),version,{log:(l,m)=>console.log(l,m)});
console.log(execFileSync('/usr/bin/codesign',['-dv',newApp],{encoding:'utf8',stdio:['ignore','pipe','pipe']})||'signed');

step('run the helper');
const sleeper=spawn('sleep',['60']);
const script=path.join(updates,'install-smoke.sh');
fs.rmSync(path.join(updates,'result.json'),{force:true});
fs.writeFileSync(script,mac.helperScript({pid:sleeper.pid,app,newApp,version,updates,launchTimeout:90}),{mode:0o700});
const helper=spawn('/bin/bash',[script],{stdio:'inherit'});
setTimeout(()=>sleeper.kill(),1000);
const code=await new Promise(r=>helper.on('exit',r));
console.log(fs.readFileSync(path.join(updates,'install.log'),'utf8'));
const result=JSON.parse(fs.readFileSync(path.join(updates,'result.json'),'utf8'));
try{execFileSync('/usr/bin/pkill',['-f',path.join(app,'Contents','MacOS','kvalah')]);}catch{}
if(code!==0||!result.ok)throw Error('helper failed: '+JSON.stringify(result));
if(fs.existsSync(path.join(app,'Contents','old-marker')))throw Error('the bundle was not replaced');
const left=fs.readdirSync(apps);if(left.join()!=='kvalah.app')throw Error('leftovers: '+left);
execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',app]);
console.log('✔ macOS self-update smoke test passed ('+arch+', '+version+')');
fs.rmSync(tmp,{recursive:true,force:true});
