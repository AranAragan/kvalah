// Self-update for unsigned (ad-hoc signed) macOS builds. electron-updater's Squirrel.Mac needs a
// Developer ID signature, so without one kvalah updates itself:
//   latest-mac.yml → the zip for this CPU → userData/updates (sha512 + SHA256SUMS checked)
//   → `ditto -x -k` → remove quarantine → check/ad-hoc sign → "Restart and install"
//   → a detached bash helper waits for kvalah to quit, swaps the .app bundle in place (atomic renames
//     in the same folder; administrator prompt through osascript if the folder isn't writable),
//     relaunches it with `open`, and rolls back if the new version doesn't start.
// The pure helpers are exported for unit tests (plain Node, any OS).
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {spawn,execFile}=require('node:child_process');

// ---------- pure helpers ----------
// The subset of YAML electron-builder writes into latest-mac.yml.
function parseLatestYml(text){
  const out={version:'',files:[],path:'',sha512:'',releaseDate:''};
  let cur=null,inFiles=false;
  const val=v=>String(v).trim().replace(/^(['"])(.*)\1$/,'$2');
  for(const raw of String(text||'').split(/\r?\n/)){
    if(!raw.trim()||raw.trim().startsWith('#'))continue;
    const top=/^([A-Za-z][\w]*):\s*(.*)$/.exec(raw);
    if(top){inFiles=top[1]==='files'&&!top[2];cur=null;if(!inFiles)out[top[1]]=val(top[2]);continue;}
    if(!inFiles)continue;
    const item=/^\s*-\s+(\w+):\s*(.*)$/.exec(raw);
    if(item){cur={};out.files.push(cur);cur[item[1]]=val(item[2]);continue;}
    const field=/^\s+(\w+):\s*(.*)$/.exec(raw);
    if(field&&cur)cur[field[1]]=val(field[2]);
  }
  out.files=out.files.filter(f=>f.url).map(f=>({url:f.url,sha512:f.sha512||'',size:Number(f.size)||0}));
  return out;
}
// The CPU of the Mac, not of this process: the Intel build under Rosetta reports 'x64' on Apple Silicon.
let nativeCache=null;
function nativeArch({platform=process.platform,arch=process.arch,sysctl}={}){
  if(platform!=='darwin'||arch!=='x64')return arch;
  if(!sysctl&&nativeCache)return nativeCache;
  const read=sysctl||(name=>{try{return require('node:child_process').execFileSync('/usr/sbin/sysctl',['-n',name],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{return '';}});
  const r=read('sysctl.proc_translated')==='1'||read('hw.optional.arm64')==='1'?'arm64':'x64';
  if(!sysctl)nativeCache=r;
  return r;
}
// The zip (not dmg) for this CPU: kvalah-<version>-mac-<arch>.zip.
function pickMacZip(info,arch=nativeArch()){
  const a=arch==='arm64'?'arm64':arch==='x64'?'x64':null;if(!a)return null;
  const re=new RegExp('-mac-'+a+'\\.zip$');
  return (info?.files||[]).find(f=>re.test(f.url)&&/^[\w.-]+$/.test(f.url)&&/^[A-Za-z0-9+/]{80,}={0,2}$/.test(f.sha512))||null;
}
function parseSha256Sums(text){
  const map={};
  for(const line of String(text||'').split(/\r?\n/)){const m=/^([a-f0-9]{64})\s+\*?(.+?)\s*$/i.exec(line);if(m)map[m[2]]=m[1].toLowerCase();}
  return map;
}
async function hashFile(file,algo){
  const h=crypto.createHash(algo);
  await new Promise((resolve,reject)=>fs.createReadStream(file).on('data',c=>h.update(c)).on('error',reject).on('end',resolve));
  return h;
}
// sha512 (base64, as in latest-mac.yml), size, and the SHA256SUMS.txt entry when there is one.
async function verifyDownload(file,{sha512,size,sha256}={}){
  const st=await fsp.stat(file);
  if(size&&st.size!==size)return {ok:false,error:`size ${st.size} ≠ ${size}`};
  if(!sha512)return {ok:false,error:'no sha512'};
  const got=(await hashFile(file,'sha512')).digest('base64');
  if(got!==sha512)return {ok:false,error:'sha512 mismatch'};
  if(sha256){const g=(await hashFile(file,'sha256')).digest('hex');if(g!==sha256.toLowerCase())return {ok:false,error:'sha256 mismatch'};}
  return {ok:true};
}
// .../kvalah.app/Contents/MacOS/kvalah → .../kvalah.app
const bundleFromExec=execPath=>path.posix.resolve(path.posix.dirname(execPath),'..','..');
// Where the app runs from decides whether it can replace itself.
function macInstallLocation(bundle,{home=os.homedir()}={}){
  const b=String(bundle||'');
  if(!/\.app$/i.test(b))return {ok:false,reason:'notBundle'};
  if(/\/AppTranslocation\//.test(b))return {ok:false,reason:'translocated'};
  // A mounted disk image: the app sits at the root of /Volumes/<name>/ (an external drive's Applications folder is fine).
  if(/^\/Volumes\/[^/]+\/[^/]+\.app$/i.test(b))return {ok:false,reason:'dmg'};
  const dl=path.posix.join(home,'Downloads')+'/';
  if(b.startsWith(dl))return {ok:false,reason:'downloads'};
  if(b.startsWith('/private/var/folders/')||b.startsWith('/var/folders/')||b.startsWith('/tmp/')||b.startsWith('/private/tmp/'))return {ok:false,reason:'temporary'};
  return {ok:true};
}
const shellQuote=s=>"'"+String(s).replace(/'/g,"'\\''")+"'";
// The detached helper. All values are single-quoted; nothing from the network reaches it except the
// version, which is validated before.
function helperScript({pid,app,newApp,version,updates,exe='kvalah',prompt='kvalah wants to install an update.',uid=process.getuid?.()??501,openCmd='/usr/bin/open',copyCmd='/usr/bin/ditto',launchTimeout=120,quitTimeout=60,suffix=crypto.randomBytes(4).toString('hex')}){
  if(!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(String(version)))throw Error('bad version');
  if(!Number.isInteger(pid)||pid<=0)throw Error('bad pid');
  if(!/^[\w.-]+$/.test(exe))throw Error('bad executable name');
  const dir=path.posix.dirname(app),name=path.posix.basename(app);
  const v={PID:pid,APP:app,NEW:newApp,VERSION:version,UPDATES:updates,EXE:exe,PROMPT:prompt,OWNER_UID:uid,
    STAGE:path.posix.join(dir,'.'+name+'.update-'+suffix),BACKUP:path.posix.join(dir,'.'+name+'.old-'+suffix),SAVED:path.posix.join(updates,'previous.app'),
    LOG:path.posix.join(updates,'install.log'),RESULT:path.posix.join(updates,'result.json'),MARKER:path.posix.join(updates,'launched-'+version),
    OPEN:openCmd,COPY:copyCmd,LAUNCH_TIMEOUT:launchTimeout,QUIT_TIMEOUT:quitTimeout};
  const vars=Object.entries(v).map(([k,x])=>k+'='+shellQuote(x)).join('\n');
  return `#!/bin/bash
# kvalah macOS update helper (generated by mac-updater.cjs). Log: $LOG
${vars}
DIR=$(dirname "$APP")
exec >>"$LOG" 2>&1
log(){ echo "$(date '+%Y-%m-%dT%H:%M:%S') [$$] $*"; }
result(){ printf '{"ok":%s,"version":"%s","error":"%s","at":%s}\\n' "$1" "$VERSION" "$2" "$(date +%s)" > "$RESULT"; }
# Copy the new bundle next to the old one, then two renames in the same folder.
swap(){
  rm -rf "$STAGE"
  if ! $COPY "$NEW" "$STAGE"; then log "copy failed"; rm -rf "$STAGE"; return 1; fi
  if [ ! -x "$STAGE/Contents/MacOS/$EXE" ]; then log "new bundle has no executable"; rm -rf "$STAGE"; return 1; fi
  if ! mv "$APP" "$BACKUP"; then log "cannot move the old app"; rm -rf "$STAGE"; return 1; fi
  if ! mv "$STAGE" "$APP"; then log "cannot move the new app, restoring"; mv "$BACKUP" "$APP"; rm -rf "$STAGE"; return 1; fi
  if [ "$(id -u)" = 0 ]; then
    chown -R "$(stat -f %u:%g "$BACKUP")" "$APP" 2>/dev/null || true
    # Keep the backup where the user (not only root) can restore or delete it.
    rm -rf "$SAVED"; mv "$BACKUP" "$SAVED" && chown -R "$OWNER_UID" "$SAVED"
  fi
  return 0
}
rollback(){
  local from="$BACKUP"; [ -d "$from" ] || from="$SAVED"
  [ -d "$from" ] || { log "no backup to restore"; return 1; }
  rm -rf "$APP" && mv "$from" "$APP"
}
as_admin(){
  /usr/bin/osascript -e 'on run argv' -e 'do shell script "/bin/bash " & quoted form of (item 1 of argv) & " " & (item 2 of argv) with prompt (item 3 of argv) with administrator privileges' -e 'end run' "$0" "$1" "$PROMPT"
}
case "\${1:-}" in
  --swap) swap; exit $?;;
  --rollback) rollback; exit $?;;
esac

log "update to $VERSION: waiting for pid $PID to quit"
i=0
while kill -0 "$PID" 2>/dev/null; do
  i=$((i+1)); if [ $i -gt $((QUIT_TIMEOUT*10)) ]; then log "kvalah did not quit"; result false "the app did not quit"; exit 1; fi
  sleep 0.1
done
ADMIN=0
if [ -w "$DIR" ] && [ -w "$APP" ]; then swap; rc=$?
else log "$DIR is not writable: asking for an administrator password"; ADMIN=1; as_admin --swap; rc=$?
fi
if [ $rc -ne 0 ]; then
  log "swap failed ($rc); the old version stays"; result false "swap failed"
  "$OPEN" "$APP"; exit 1
fi
log "swapped; launching"
rm -f "$MARKER"
"$OPEN" "$APP"
i=0
while [ ! -e "$MARKER" ]; do
  i=$((i+1))
  if [ $i -gt $((LAUNCH_TIMEOUT*2)) ]; then
    if /usr/bin/pgrep -f "$APP/Contents/MacOS/$EXE" >/dev/null 2>&1; then log "no marker but the new app is running"; break; fi
    log "the new version did not start: rolling back"
    if [ $ADMIN = 1 ]; then as_admin --rollback; else rollback; fi
    result false "the new version did not start"
    "$OPEN" "$APP"; exit 1
  fi
  sleep 0.5
done
log "update to $VERSION done"
result true ""
if [ $ADMIN = 1 ]; then rm -rf "$SAVED"; else rm -rf "$BACKUP"; fi
rm -rf "$NEW"
exit 0
`;
}
// The running app writes this so the helper knows the new version started.
function markLaunched(updatesDir,version){
  try{fs.mkdirSync(updatesDir,{recursive:true});fs.writeFileSync(path.join(updatesDir,'launched-'+version),String(Date.now()));}catch{}
}

// ---------- controller (Electron main process, macOS) ----------
const run=(cmd,args,opts={})=>new Promise((resolve,reject)=>execFile(cmd,args,{timeout:10*60*1000,maxBuffer:4<<20,...opts},(err,stdout,stderr)=>err?reject(Object.assign(err,{stderr:String(stderr||'')})):resolve(String(stdout||''))));
async function findApp(dir){
  for(const e of await fsp.readdir(dir,{withFileTypes:true}))if(e.isDirectory()&&e.name.endsWith('.app'))return path.join(dir,e.name);
  return null;
}
// Unzips a verified update and makes it launchable: version check, no quarantine, a valid (ad-hoc) signature.
async function prepareBundle(zipFile,staging,version,{log=()=>{}}={}){
  await fsp.rm(staging,{recursive:true,force:true});await fsp.mkdir(staging,{recursive:true});
  await run('/usr/bin/ditto',['-x','-k',zipFile,staging]);
  const app=await findApp(staging);if(!app)throw Error('no .app in '+path.basename(zipFile));
  const got=(await run('/usr/bin/plutil',['-extract','CFBundleShortVersionString','raw','-o','-',path.join(app,'Contents','Info.plist')])).trim();
  if(got!==version)throw Error('bundle version '+got+' ≠ '+version);
  await run('/usr/bin/xattr',['-dr','com.apple.quarantine',app]).catch(()=>{});
  try{await run('/usr/bin/codesign',['--verify','--deep','--strict',app]);}
  catch{log('info','signature check failed, ad-hoc signing');await run('/usr/bin/codesign',['--force','--deep','-s','-',app]);await run('/usr/bin/codesign',['--verify','--deep','--strict',app]);}
  return app;
}
function createMacUpdater({owner,repo,currentVersion,userData,execPath=process.execPath,arch=nativeArch(),runningArch=process.arch,publish,log=()=>{},adminPrompt=v=>'kvalah wants to install update '+v+'.',fetchImpl=fetch,quit}){
  const updates=path.join(userData,'updates');
  const bundle=bundleFromExec(execPath);
  const base=`https://github.com/${owner}/${repo}/releases`;
  let ready=null,busy=null,lastResult=null;
  try{lastResult=JSON.parse(fs.readFileSync(path.join(updates,'result.json'),'utf8'));fs.rmSync(path.join(updates,'result.json'),{force:true});
    log(lastResult.ok?'info':'warn','previous install: '+JSON.stringify(lastResult));}catch{}
  // Leftovers of finished updates (keep install.log).
  // A helper that just relaunched us may still be finishing, so only entries older than an hour go.
  try{const hour=Date.now()-3600e3;for(const f of fs.readdirSync(updates)){const full=path.join(updates,f);if(f==='install.log')continue;if(fs.statSync(full).mtimeMs<hour)fs.rmSync(full,{recursive:true,force:true});}}catch{}
  const manual=(version,reason)=>publish({state:'available',version,url:base+'/tag/v'+version,manual:true,reason,progress:null});

  async function text(url){const r=await fetchImpl(url,{redirect:'follow',headers:{'User-Agent':'kvalah/'+currentVersion}});if(!r.ok)throw Error(url.split('/').pop()+': HTTP '+r.status);return r.text();}
  async function download(url,dest,{size,onProgress}){
    const r=await fetchImpl(url,{redirect:'follow',headers:{'User-Agent':'kvalah/'+currentVersion}});
    if(!r.ok||!r.body)throw Error('download: HTTP '+r.status);
    const total=size||Number(r.headers.get('content-length'))||0;
    const out=fs.createWriteStream(dest);let got=0,last=0;
    try{
      for await(const chunk of r.body){
        got+=chunk.length;
        if(!out.write(chunk))await new Promise(res=>out.once('drain',res));
        const now=Date.now();if(total&&now-last>500){last=now;onProgress(got/total);}
      }
    }finally{await new Promise(res=>out.end(res));}
  }
  async function prepare(version){
    const loc=macInstallLocation(bundle);
    if(!loc.ok){manual(version,'location');return {available:true,version,manual:true};}
    if(lastResult&&!lastResult.ok&&lastResult.version===version){manual(version,'failed');return {available:true,version,manual:true};}
    const info=parseLatestYml(await text(base+'/download/v'+version+'/latest-mac.yml'));
    const zip=pickMacZip(info,arch);if(!zip)throw Error('no zip for '+arch);
    let sha256=null;
    try{sha256=parseSha256Sums(await text(base+'/download/v'+version+'/SHA256SUMS.txt'))[zip.url]||null;}catch(e){log('warn','SHA256SUMS: '+e.message);}
    await fsp.mkdir(updates,{recursive:true});
    const file=path.join(updates,zip.url),part=file+'.part';
    let check=fs.existsSync(file)?await verifyDownload(file,{...zip,sha256}):{ok:false};
    if(!check.ok){
      publish({state:'downloading',version,progress:0});
      await fsp.rm(part,{force:true});
      await download(base+'/download/v'+version+'/'+zip.url,part,{size:zip.size,onProgress:p=>publish({state:'downloading',version,progress:Math.min(0.99,p)})});
      check=await verifyDownload(part,{...zip,sha256});
      if(!check.ok){await fsp.rm(part,{force:true});throw Error('checksum: '+check.error);}
      await fsp.rename(part,file);
    }
    const app=await prepareBundle(file,path.join(updates,'staging-'+version),version,{log});
    await fsp.rm(file,{force:true});
    ready={version,app};
    publish({state:'ready',version,progress:null,manual:false});
    return {available:true,version};
  }
  // Returns {available, version}. Downloads and prepares in the background of the check.
  async function check(){
    if(busy)return busy;
    busy=(async()=>{
      try{
        if(ready)return {available:true,version:ready.version};
        const info=parseLatestYml(await text(base+'/latest/download/latest-mac.yml'));
        const {newerThan}=require('./updater.cjs');
        // The Intel build running on Apple Silicon (Rosetta) also "updates" to the same version for arm64:
        // under Rosetta the app is slower and llama.cpp would pick the Intel build without Metal.
        const switchArch=arch!==runningArch&&info.version===currentVersion;
        if(switchArch)log('info','switching from '+runningArch+' to the '+arch+' build');
        if(!info.version||!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(info.version)||!(newerThan(info.version,currentVersion)||switchArch))return {available:false};
        try{return await prepare(info.version);}
        catch(e){log('error','mac update failed: '+String(e.message).split('\n')[0].slice(0,300));manual(info.version,'failed');return {available:true,version:info.version,manual:true};}
      }finally{busy=null;}
    })();
    return busy;
  }
  function install(){
    if(!ready)return false;
    const script=path.join(updates,'install-'+ready.version+'.sh');
    fs.writeFileSync(script,helperScript({pid:process.pid,app:bundle,newApp:ready.app,version:ready.version,updates,exe:path.basename(execPath),prompt:adminPrompt(ready.version)}),{mode:0o700});
    log('info','installing '+ready.version+' over '+bundle);
    const child=spawn('/bin/bash',[script],{detached:true,stdio:'ignore'});child.unref();
    setTimeout(()=>quit(),300);
    return true;
  }
  return {check,install,bundle,location:()=>macInstallLocation(bundle)};
}

module.exports={nativeArch,prepareBundle,parseLatestYml,pickMacZip,parseSha256Sums,verifyDownload,bundleFromExec,macInstallLocation,shellQuote,helperScript,markLaunched,createMacUpdater};
