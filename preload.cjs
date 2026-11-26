const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('kvalahDesktop',{
  createShortcuts:()=>ipcRenderer.invoke('kvalah:shortcuts'),
  quit:()=>ipcRenderer.invoke('kvalah:quit'),
  chooseFolder:purpose=>ipcRenderer.invoke('kvalah:folder',purpose==='project'?'project':purpose==='other'?'other':'workspace'),
  chooseFile:purpose=>ipcRenderer.invoke('kvalah:file',purpose==='gguf'?'gguf':'any'),
  getToken:()=>ipcRenderer.invoke('kvalah:token'),
  getLanguage:()=>ipcRenderer.invoke('kvalah:language'),
  setLanguage:(language,source)=>ipcRenderer.invoke('kvalah:set-language',String(language),source==='user'?'user':'auto'),
  getUpdate:()=>ipcRenderer.invoke('kvalah:update-state'),
  installUpdate:()=>ipcRenderer.invoke('kvalah:update-install'),
  openUpdatePage:()=>ipcRenderer.invoke('kvalah:update-open'),
  getUpdatePrefs:()=>ipcRenderer.invoke('kvalah:update-prefs',null),
  setUpdatePrefs:autoCheck=>ipcRenderer.invoke('kvalah:update-prefs',{autoCheck:!!autoCheck}),
  onComputeInvitation:callback=>{
    const listener=()=>ipcRenderer.invoke('kvalah:compute-invite').then(value=>{if(typeof value==='string'&&value.length<=4096)callback(value);}).catch(()=>{});
    ipcRenderer.on('kvalah:compute-invite-ready',listener);
    listener();
    return ()=>ipcRenderer.removeListener('kvalah:compute-invite-ready',listener);
  },
  onUpdate:callback=>{
    const listener=(_event,state)=>{if(state&&typeof state==='object')callback({state:String(state.state),mode:String(state.mode),version:state.version==null?null:String(state.version)});};
    ipcRenderer.on('kvalah:update',listener);
    return ()=>ipcRenderer.removeListener('kvalah:update',listener);
  },
  onAction:callback=>{
    const listener=(_event,action)=>{if(['new-chat','settings','devices','trash','sidebar'].includes(action)||/^language:(auto|[a-zA-Z-]{2,5})$/.test(action))callback(action);};
    ipcRenderer.on('kvalah:action',listener);
    return ()=>ipcRenderer.removeListener('kvalah:action',listener);
  }
});
