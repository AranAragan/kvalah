const {app,BrowserWindow,Menu,dialog,shell,ipcMain,nativeImage,powerMonitor,safeStorage}=require('electron');
const path=require('node:path');
const fs=require('node:fs');
const os=require('node:os');
const net=require('node:net');
const {spawn}=require('node:child_process');
const {createUpdater}=require('./updater.cjs');
app.setName('kvalah');
const TEST_ROOT=process.env.KVALAH_TEST_ROOT?path.resolve(process.env.KVALAH_TEST_ROOT):null;
if(TEST_ROOT){fs.mkdirSync(TEST_ROOT,{recursive:true});app.setPath('userData',TEST_ROOT);}
// Interface language: same dictionaries as the web UI (public/i18n/<lang>.json).
const LANGS=['ru','en','uk','de','fr','es','pt-BR','zh-CN','tr','ja'];
const CHROMIUM_LOCALES={ru:'ru',en:'en-US',uk:'uk',de:'de',fr:'fr',es:'es','pt-BR':'pt-BR','zh-CN':'zh-CN',tr:'tr',ja:'ja'};
function matchLanguage(tags){
  for(const raw of [].concat(tags||[])){
    const tag=String(raw||'').replace('_','-').toLowerCase();if(!tag)continue;
    const exact=LANGS.find(l=>l.toLowerCase()===tag);if(exact)return exact;
    const base=tag.split('-')[0];
    if(base==='pt')return 'pt-BR';
    if(base==='zh')return 'zh-CN';
    if(base==='be'||base==='kk')return 'ru';
    const near=LANGS.find(l=>l.split('-')[0]===base);if(near)return near;
  }
  return 'en';
}
const languageFile=()=>path.join(app.getPath('userData'),'language.json');
function readLanguage(){try{const v=JSON.parse(fs.readFileSync(languageFile(),'utf8'));return LANGS.includes(v.language)?{language:v.language,source:v.source==='user'?'user':'auto'}:null;}catch{return null;}}
let languagePref=readLanguage(),uiLanguage=languagePref?.language||'en',systemLanguages=[];
// Chromium's own strings (context menu, file dialogs) take their locale from --lang, which must be set
// before 'ready': an explicit choice therefore applies to those built-in strings from the next launch.
if(languagePref?.source==='user')app.commandLine.appendSwitch('lang',CHROMIUM_LOCALES[languagePref.language]);
const dictionaries={};
function dictionary(lang){if(!dictionaries[lang]){try{dictionaries[lang]=JSON.parse(fs.readFileSync(path.join(__dirname,'public','i18n',lang+'.json'),'utf8'));}catch{dictionaries[lang]={};}}return dictionaries[lang];}
function L(key,params={}){
  let value=dictionary(uiLanguage)[key]??dictionary('en')[key]??key;
  if(typeof value==='object'){const n=Number(params.n??0);value=value[new Intl.PluralRules(uiLanguage).select(n)]??value.other;}
  return value.replace(/\{(\w+)\}/g,(m,name)=>name in params?String(params[name]):m);
}
app.setAppUserModelId('kvalah.Desktop');
const APP_ID='kvalah.Desktop';
const LOCK=app.requestSingleInstanceLock();
let win=null,backend=null,origin=null,token=null,quitting=false,updates=null;
let pendingComputeInvite=null;
function queueComputeInvite(args){
  for(const value of args){
    if(typeof value!=='string'||!value.startsWith('kvalah-compute://pair?')||value.length>4096)continue;
    try{
      const url=new URL(value);
      if(url.protocol!=='kvalah-compute:'||url.hostname!=='pair'||url.pathname||url.username||url.password||url.hash||url.port)continue;
      if([...url.searchParams].length!==3||!['e','fp','c'].every(k=>url.searchParams.get(k)))continue;
      pendingComputeInvite=value;
      if(win&&!win.webContents.isLoadingMainFrame())win.webContents.send('kvalah:compute-invite-ready');
      break;
    }catch{}
  }
}
queueComputeInvite(process.argv.slice(1));
if(!LOCK){app.quit();}
else{
  app.on('open-url',(event,url)=>{event.preventDefault();queueComputeInvite([url]);});
  app.on('second-instance',(_event,args)=>{queueComputeInvite(args);if(win){if(win.isMinimized())win.restore();win.show();win.focus();}});
  app.whenReady().then(start).catch(e=>{if(TEST_ROOT)fs.writeFileSync(path.join(TEST_ROOT,'smoke-error.txt'),e.stack||e.message);else dialog.showErrorBox(L('desktop.startError'),e.message);app.exit(1);});
}
const iconPath=path.join(__dirname,'public','favicon.ico');
function shortcuts(){
  if(process.platform!=='win32'||TEST_ROOT)return {supported:false};
  const exe=process.execPath;
  const options={target:exe,cwd:path.dirname(exe),description:L('desktop.shortcutDesc'),icon:exe,iconIndex:0,appUserModelId:APP_ID};
  const desktop=path.join(app.getPath('desktop'),'kvalah.lnk');
  const menu=path.join(app.getPath('appData'),'Microsoft','Windows','Start Menu','Programs','kvalah.lnk');
  fs.mkdirSync(path.dirname(menu),{recursive:true});
  const created=[];
  for(const dest of [desktop,menu]){
    if(!shell.writeShortcutLink(dest,'create',options))throw Error(L('desktop.shortcutFailed',{path:dest}));
    created.push(dest);
  }
  return {supported:true,created};
}
async function freePort(){
  const probe=net.createServer();
  return new Promise((resolve,reject)=>{
    probe.once('error',()=>{const fallback=net.createServer();fallback.once('error',reject);fallback.listen(0,'127.0.0.1',()=>{const port=fallback.address().port;fallback.close(()=>resolve(port));});});
    probe.listen(4318,'127.0.0.1',()=>{const port=probe.address().port;probe.close(()=>resolve(port));});
  });
}
async function launchBackend(){
  const userDir=app.getPath('userData');
  const dataDir=path.join(userDir,'data');
  fs.mkdirSync(dataDir,{recursive:true});
  // Migrate portable history only on the first native launch; never overwrite.
  const oldData=path.join(path.dirname(process.execPath),'data');
  if(!fs.existsSync(path.join(dataDir,'chats.json'))&&fs.existsSync(path.join(oldData,'chats.json'))){
    fs.cpSync(oldData,dataDir,{recursive:true,errorOnExist:false,force:false});
  }
  const workspace=TEST_ROOT?path.join(TEST_ROOT,'workspace'):path.join(app.getPath('documents'),'kvalah');
  fs.mkdirSync(workspace,{recursive:true});
  const port=await freePort();
  const logs=path.join(userDir,'logs');fs.mkdirSync(logs,{recursive:true});
  const log=fs.createWriteStream(path.join(logs,'desktop.log'),{flags:'a'});
  backend=spawn(process.execPath,[path.join(__dirname,'server.mjs')],{
    cwd:__dirname,windowsHide:true,
    env:{...process.env,ELECTRON_RUN_AS_NODE:'1',KVALAH_LANG:uiLanguage,LOCAL_CODEX_DATA:dataDir,LOCAL_CODEX_PORT:String(port),KVALAH_WORKSPACE:workspace,KVALAH_DESKTOP:app.getPath('desktop'),KVALAH_DOCUMENTS:app.getPath('documents'),KVALAH_DOWNLOADS:app.getPath('downloads')},
    stdio:['ignore','pipe','pipe','ipc']
  });
  backend.stdout.pipe(log,{end:false});backend.stderr.pipe(log,{end:false});
  // Kvalah Compute: OS sensors for the Resource Governor (null = not available here, never guessed) and the
  // OS credential store (DPAPI / Keychain via safeStorage) for the device key. Plain IPC, no network.
  const sensors=()=>{let thermal=null;try{if(process.platform==='darwin')thermal=powerMonitor.getCurrentThermalState?.()||null;}catch{}
    let battery=null;try{battery=powerMonitor.isOnBatteryPower();}catch{}
    let idle=null;try{idle=powerMonitor.getSystemIdleTime();}catch{}
    return {on_battery:typeof battery==='boolean'?battery:null,idle_s:Number.isFinite(idle)?idle:null,thermal_state:thermal&&thermal!=='unknown'?thermal:null};};
  const sendSensors=()=>{try{if(backend?.connected)backend.send({type:'compute-sensors',sensors:sensors()});}catch{}};
  const sensorTimer=setInterval(sendSensors,5000);sensorTimer.unref?.();
  for(const e of ['on-ac','on-battery','thermal-state-change'])try{powerMonitor.on(e,sendSensors);}catch{}
  const secureStore=()=>{try{if(!safeStorage.isEncryptionAvailable())return false;if(process.platform==='linux'&&safeStorage.getSelectedStorageBackend?.()==='basic_text')return false;return true;}catch{return false;}};
  backend.on('message',m=>{
    if(m?.type!=='compute-secret')return;
    let reply;
    try{
      if(m.op==='available')reply={ok:true,data:secureStore()};
      else if(!secureStore())throw Error('OS secret store unavailable');
      else if(m.op==='seal')reply={ok:true,data:safeStorage.encryptString(String(m.data)).toString('base64')};
      else if(m.op==='open')reply={ok:true,data:safeStorage.decryptString(Buffer.from(String(m.data),'base64'))};
      else throw Error('unknown secret operation');
    }catch(e){reply={ok:false,error:e.message};}
    try{backend.send({type:'compute-secret-reply',id:m.id,...reply});}catch{}
  });
  backend.on('exit',(code)=>{log.end();if(!quitting&&origin){dialog.showErrorBox('kvalah',L('desktop.backendStopped',{code}));app.quit();}});
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error(L('desktop.backendTimeout',{path:logs}))),30000);
    backend.once('error',e=>{clearTimeout(timer);reject(e);});
    backend.once('exit',()=>{clearTimeout(timer);reject(Error(L('desktop.backendExited',{path:logs})));});
    backend.on('message',m=>{if(m?.type==='ready'){clearTimeout(timer);token=m.token;resolve(m.origin);}});
  });
}
function sendAction(action){win?.webContents.send('kvalah:action',action);}
function installMenu(){
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {label:'kvalah',submenu:[
      {label:L('chat.new'),accelerator:'CmdOrCtrl+N',click:()=>sendAction('new-chat')},
      {label:L('sidebar.settings'),accelerator:'CmdOrCtrl+,',click:()=>sendAction('settings')},
      {label:L('desktop.devices'),click:()=>sendAction('devices')},
      {label:L('settings.trash'),click:()=>sendAction('trash')},
      {type:'separator'},
      {label:L('desktop.createShortcuts'),click:()=>{try{shortcuts();dialog.showMessageBox(win,{type:'info',message:L('settings.shortcutsDone'),detail:L('desktop.shortcutsDetail')});}catch(e){dialog.showErrorBox(L('desktop.shortcuts'),e.message);}}},
      {type:'separator'},{label:L('desktop.quit'),accelerator:'Alt+F4',click:()=>win?.close()}
    ]},
    {label:L('desktop.edit'),submenu:[{role:'undo',label:L('desktop.undo')},{role:'redo',label:L('desktop.redo')},{type:'separator'},{role:'cut',label:L('desktop.cut')},{role:'copy',label:L('common.copy')},{role:'paste',label:L('desktop.paste')},{role:'selectAll',label:L('desktop.selectAll')}]},
    {label:L('desktop.view'),submenu:[{label:L('sidebar.history'),accelerator:'CmdOrCtrl+B',click:()=>sendAction('sidebar')},{role:'reload',label:L('desktop.reload')},{type:'separator'},{role:'resetZoom',label:L('desktop.resetZoom')},{role:'zoomIn',label:L('desktop.zoomIn')},{role:'zoomOut',label:L('desktop.zoomOut')},{role:'togglefullscreen',label:L('desktop.fullscreen')},{type:'separator'},
      {label:L('desktop.language'),submenu:[{label:L('lang.auto'),type:'radio',checked:languagePref?.source!=='user',click:()=>sendAction('language:auto')},{type:'separator'},...LANGS.map(l=>({label:dictionary(l)['lang.name']||l,type:'radio',checked:languagePref?.source==='user'&&uiLanguage===l,click:()=>sendAction('language:'+l)}))]}]},
    {label:L('desktop.help'),submenu:[
      {label:L('desktop.openBrowser'),click:()=>shell.openExternal(origin+'/#token='+token)},
      {label:L('desktop.dataFolder'),click:()=>shell.openPath(app.getPath('userData'))},
      ...(updates&&updates.mode!=='off'?[{label:L('desktop.checkUpdates'),click:manualUpdateCheck}]:[]),
      {label:L('desktop.about'),click:()=>dialog.showMessageBox(win,{type:'info',icon:nativeImage.createFromPath(iconPath),message:'kvalah '+app.getVersion(),detail:L('desktop.aboutDetail')})}
    ]}
  ]));
}
function updateLog(level,message){
  try{fs.appendFileSync(path.join(app.getPath('userData'),'logs','updater.log'),new Date().toISOString()+' '+level+' '+message+'\n');}catch{}
}
async function manualUpdateCheck(){
  try{
    const result=await updates.check();
    if(!result.available)await dialog.showMessageBox(win,{type:'info',message:L('desktop.upToDate',{version:app.getVersion()})});
  }catch(e){dialog.showErrorBox('kvalah',L('desktop.updateError',{error:String(e.message).split('\n')[0].slice(0,300)}));}
}
// The NSIS installer and Scoop create their own shortcuts; only a hand-unpacked portable copy creates them on first run.
const managedInstall=()=>process.platform==='win32'&&(fs.existsSync(path.join(path.dirname(process.execPath),'Uninstall kvalah.exe'))||/[\\/]scoop[\\/]apps[\\/]/i.test(process.execPath));
async function start(){
  // macOS self-update: tells a waiting update helper that this version started (see mac-updater.cjs).
  if(process.platform==='darwin'&&app.isPackaged&&!TEST_ROOT)require('./mac-updater.cjs').markLaunched(path.join(app.getPath('userData'),'updates'),app.getVersion());
  // app.getLocale() reflects our own --lang switch, so it only counts as a system hint when no manual choice is active.
  const locale=languagePref?.source==='user'?null:app.getLocale();
  try{systemLanguages=[...app.getPreferredSystemLanguages(),locale];}catch{systemLanguages=[locale];}
  systemLanguages=systemLanguages.filter(l=>l&&!/^(c|posix)$/i.test(l));
  if(languagePref?.source!=='user')uiLanguage=matchLanguage(systemLanguages);
  origin=await launchBackend();
  win=new BrowserWindow({
    width:1280,height:880,minWidth:780,minHeight:580,title:'kvalah',icon:iconPath,backgroundColor:'#ffffff',show:false,
    webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}
  });
  if(process.platform==='win32')win.setAppDetails({appId:APP_ID,appIconPath:process.execPath,appIconIndex:0,relaunchCommand:'"'+process.execPath+'"',relaunchDisplayName:'kvalah'});
  win.webContents.setWindowOpenHandler(({url})=>{if(/^https?:\/\//i.test(url))shell.openExternal(url);return {action:'deny'};});
  win.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!==origin){event.preventDefault();if(/^https?:\/\//i.test(url))shell.openExternal(url);}});
  ipcMain.handle('kvalah:shortcuts',event=>{checkSender(event);return shortcuts();});
  ipcMain.handle('kvalah:quit',event=>{checkSender(event);setTimeout(()=>app.quit(),50);return {ok:true};});
  ipcMain.handle('kvalah:folder',async(event,purpose)=>{checkSender(event);const result=await dialog.showOpenDialog(win,{title:purpose==='other'?L('desktop.chooseFolder'):L(purpose==='project'?'desktop.projectFolder':'desktop.workspaceFolder'),properties:['openDirectory','createDirectory']});return result.canceled?null:result.filePaths[0];});
  ipcMain.handle('kvalah:file',async(event,purpose)=>{checkSender(event);const result=await dialog.showOpenDialog(win,{title:L(purpose==='gguf'?'desktop.ggufFile':'desktop.chooseFile'),properties:['openFile'],filters:purpose==='gguf'?[{name:L('desktop.ggufFilter'),extensions:['gguf']},{name:L('desktop.allFiles'),extensions:['*']}]:undefined});return result.canceled?null:result.filePaths[0];});
  // The API token is handed to the window over IPC instead of an unauthenticated HTTP endpoint.
  ipcMain.handle('kvalah:token',event=>{checkSender(event);return token;});
  ipcMain.handle('kvalah:language',event=>{checkSender(event);return {language:uiLanguage,source:languagePref?.source||'auto',system:systemLanguages};});
  ipcMain.handle('kvalah:set-language',(event,language,source)=>{
    checkSender(event);if(!LANGS.includes(language))throw Error(L('srv.badLanguage'));
    uiLanguage=language;languagePref={language,source:source==='user'?'user':'auto'};
    try{fs.writeFileSync(languageFile(),JSON.stringify(languagePref));}catch(e){console.error('Language:',e.message);}
    installMenu();return {ok:true};
  });
  updates=createUpdater({send:state=>win?.webContents.send('kvalah:update',state),log:updateLog,isTest:!!TEST_ROOT,t:L});
  ipcMain.handle('kvalah:update-state',event=>{checkSender(event);return updates.getState();});
  ipcMain.handle('kvalah:update-install',event=>{checkSender(event);return updates.install();});
  ipcMain.handle('kvalah:update-open',event=>{checkSender(event);const url=updates.getState().url;if(/^https:\/\/github\.com\//.test(url))shell.openExternal(url);return true;});
  ipcMain.handle('kvalah:update-prefs',(event,next)=>{checkSender(event);return next&&typeof next==='object'?updates.setPrefs(next):updates.getPrefs();});
  ipcMain.handle('kvalah:compute-invite',event=>{
    checkSender(event);
    const value=pendingComputeInvite;
    pendingComputeInvite=null;
    return value;
  });
  if(app.isPackaged&&!TEST_ROOT&&process.platform==='win32')app.setAsDefaultProtocolClient('kvalah-compute');
  installMenu();
  win.once('ready-to-show',()=>{if(process.env.KVALAH_SMOKE_TEST!=='1')win.show();});
  win.on('page-title-updated',event=>{event.preventDefault();win.setTitle('kvalah');});
  await win.loadURL(origin);
  if(TEST_ROOT&&process.env.KVALAH_SMOKE_TEST==='1'){
    await new Promise(resolve=>setTimeout(resolve,2000));
    if(process.env.KVALAH_SMOKE_UPDATE)win.webContents.send('kvalah:update',{state:'ready',mode:'install',version:process.env.KVALAH_SMOKE_UPDATE});
    const result=await win.webContents.executeJavaScript(`(async()=>{for(let i=0;i<150&&!document.querySelector('.history-item');i++)await new Promise(r=>setTimeout(r,100));if(document.querySelector('.history-item'))await showProject();return {title:document.title,review:!!document.querySelector('.project-review'),composer:!!document.querySelector('#prompt'),projectPanel:!!document.querySelector('.workflow-phase'),htmlLang:document.documentElement.lang,uiLanguage:kvI18n.lang,missing:document.body.innerText.includes('\u27e6'),body:document.body.innerText.slice(0,1000)};})()`);
    result.desktop={language:uiLanguage,source:languagePref?.source||'auto',system:systemLanguages,chromiumLang:app.commandLine.getSwitchValue('lang'),menu:Menu.getApplicationMenu().items.map(i=>i.label)};
    if(!result.review||!result.composer)throw Error('Native UI did not initialize');
    fs.writeFileSync(path.join(TEST_ROOT,'smoke-result.json'),JSON.stringify(result));
    const screenshot=await win.webContents.capturePage();fs.writeFileSync(path.join(TEST_ROOT,'native.png'),screenshot.toPNG());
    app.quit();return;
  }
  const flag=path.join(app.getPath('userData'),'shortcuts-v02.json');
  updates.start();
  if(process.platform==='win32'&&!TEST_ROOT&&!managedInstall()&&!fs.existsSync(flag)){
    try{shortcuts();fs.writeFileSync(flag,JSON.stringify({createdAt:Date.now()}));}catch(e){console.error('Shortcuts:',e.message);}
  }
}
function checkSender(event){if(!origin||new URL(event.senderFrame.url).origin!==origin)throw Error(L('srv.badOrigin'));}
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',()=>{
  quitting=true;
  if(backend?.pid){
    if(process.platform==='win32'){const stop=spawn('taskkill.exe',['/PID',String(backend.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});stop.on('error',()=>backend?.kill());}
    else backend.kill();
  }
});
