// Auto-update from GitHub Releases.
// - "install": electron-updater downloads in the background and the app offers "Restart and install"
//   (Windows NSIS install, Linux AppImage, macOS only when signed with a Developer ID).
// - "mac": unsigned (ad-hoc signed) macOS builds update themselves with mac-updater.cjs: zip download,
//   checksum, bundle swap by a helper script after quitting, relaunch (Squirrel.Mac needs a Developer ID).
// - "notify": portable zip, .deb: no self-replacement; the app only shows a notice
//   with a link to the release page (GitHub API, no electron-updater involved).
// - "off": development runs, tests, KVALAH_DISABLE_UPDATES=1.
// Loaded lazily so the pure helpers below can be unit-tested in plain Node.
let electronApp=null;
const appRef=()=>electronApp??=require('electron').app;
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');

const OWNER='AranAragan',REPO='kvalah';
const RELEASES_URL=`https://github.com/${OWNER}/${REPO}/releases/latest`;
const FIRST_CHECK_MS=15*1000,INTERVAL_MS=6*60*60*1000;

function parseVersion(v){const m=String(v||'').trim().replace(/^v/i,'').match(/^(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?/);return m?{nums:[+m[1],+m[2],+m[3]],pre:m[4]||''}:null;}
// Semver precedence without build metadata; a prerelease is lower than the same release.
function newerThan(candidate,current){
  const a=parseVersion(candidate),b=parseVersion(current);if(!a||!b)return false;
  for(let i=0;i<3;i++)if(a.nums[i]!==b.nums[i])return a.nums[i]>b.nums[i];
  if(a.pre===b.pre)return false;if(!a.pre)return true;if(!b.pre)return false;
  return a.pre.localeCompare(b.pre,'en',{numeric:true})>0;
}

function macSignedWithDeveloperId(){
  try{
    const bundle=path.resolve(path.dirname(process.execPath),'..','..');
    const out=spawnSync('codesign',['-dv',bundle],{encoding:'utf8'});
    const text=(out.stderr||'')+(out.stdout||'');
    return out.status===0&&/TeamIdentifier=(?!not set)\w+/.test(text);
  }catch{return false;}
}
function detectMode({isTest}){
  if(!appRef().isPackaged||isTest||process.env.KVALAH_DISABLE_UPDATES==='1')return 'off';
  if(process.platform==='win32')return fs.existsSync(path.join(path.dirname(process.execPath),'Uninstall kvalah.exe'))?'install':'notify';
  if(process.platform==='linux')return process.env.APPIMAGE?'install':'notify';
  if(process.platform==='darwin')return macSignedWithDeveloperId()?'install':process.env.KVALAH_MAC_SELF_UPDATE==='0'?'notify':'mac';
  return 'notify';
}

function createUpdater({send,log=()=>{},isTest=false,t=(key,p)=>key}){
  const prefsFile=()=>path.join(appRef().getPath('userData'),'update.json');
  let prefs={autoCheck:true};
  try{prefs={...prefs,...JSON.parse(fs.readFileSync(prefsFile(),'utf8'))};}catch{}
  const mode=detectMode({isTest});
  let state={state:'idle',mode,version:null,url:RELEASES_URL};
  let updater=null,timer=null,checking=null;
  const publish=next=>{state={...state,...next,mode};send(state);};
  let mac=null;
  if(mode==='mac'){
    const {createMacUpdater}=require('./mac-updater.cjs');
    mac=createMacUpdater({owner:OWNER,repo:REPO,currentVersion:appRef().getVersion(),userData:appRef().getPath('userData'),publish,log,
      adminPrompt:version=>t('update.adminPrompt',{version}),quit:()=>appRef().quit()});
  }

  function electronUpdater(){
    if(updater)return updater;
    const {autoUpdater}=require('electron-updater');
    const short=m=>String(m?.message||m).split('\n')[0].slice(0,300);
    autoUpdater.logger={info:m=>log('info',short(m)),warn:m=>log('warn',short(m)),error:m=>log('error',short(m)),debug:()=>{}};
    autoUpdater.autoDownload=true;
    autoUpdater.autoInstallOnAppQuit=true;
    autoUpdater.allowPrerelease=parseVersion(appRef().getVersion())?.pre!=='';
    autoUpdater.on('update-available',info=>publish({state:'downloading',version:info.version}));
    autoUpdater.on('update-not-available',()=>{if(state.state!=='ready')publish({state:'idle'});});
    autoUpdater.on('update-downloaded',info=>publish({state:'ready',version:info.version}));
    autoUpdater.on('error',()=>{if(state.state!=='ready')publish({state:'idle'});}); // details go to the logger
    return updater=autoUpdater;
  }

  async function checkRelease(){
    const res=await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`,{headers:{Accept:'application/vnd.github+json','User-Agent':'kvalah/'+appRef().getVersion()}});
    if(!res.ok)throw Error('GitHub API '+res.status);
    const release=await res.json();
    const version=String(release.tag_name||'').replace(/^v/i,'');
    if(release.draft||!newerThan(version,appRef().getVersion()))return {available:false};
    publish({state:'available',version,url:release.html_url||RELEASES_URL});
    return {available:true,version};
  }

  // Returns {available, version} or throws; never installs anything by itself.
  async function check(){
    if(mode==='off')return {available:false,disabled:true};
    if(checking)return checking;
    checking=(async()=>{
      try{
        if(mode==='notify')return await checkRelease();
        if(mode==='mac')return await mac.check();
        if(state.state==='ready')return {available:true,version:state.version};
        const result=await electronUpdater().checkForUpdates();
        const version=result?.updateInfo?.version;
        return {available:!!version&&newerThan(version,appRef().getVersion()),version};
      }finally{checking=null;}
    })();
    return checking;
  }
  const quiet=()=>check().catch(e=>log('warn','update check failed: '+String(e?.message||e).split('\n')[0].slice(0,300)));

  function schedule(){
    clearInterval(timer);timer=null;
    if(mode==='off'||!prefs.autoCheck)return;
    setTimeout(()=>{if(prefs.autoCheck)quiet();},FIRST_CHECK_MS).unref?.();
    timer=setInterval(()=>{if(prefs.autoCheck)quiet();},INTERVAL_MS);timer.unref?.();
  }
  function setPrefs(next){
    prefs={...prefs,autoCheck:next?.autoCheck!==false};
    try{fs.writeFileSync(prefsFile(),JSON.stringify(prefs));}catch(e){log('error','update prefs: '+e.message);}
    schedule();return getPrefs();
  }
  const getPrefs=()=>({autoCheck:prefs.autoCheck,mode});
  function install(){
    if(mode==='mac')return state.state==='ready'&&mac.install();
    if(mode!=='install'||state.state!=='ready')return false;
    // Silent NSIS run, then relaunch; AppImage/macOS replace the bundle and relaunch.
    setImmediate(()=>electronUpdater().quitAndInstall(true,true));
    return true;
  }
  return {mode,start:schedule,check,install,getState:()=>state,getPrefs,setPrefs,releasesUrl:RELEASES_URL};
}

module.exports={createUpdater,newerThan,parseVersion,RELEASES_URL};
