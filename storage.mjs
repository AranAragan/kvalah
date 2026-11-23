import {tr} from './i18n.mjs';
// Chat storage: one JSON file per chat (DATA/chats/<id>.json) instead of rewriting a single
// chats.json with the whole history after every tool call. Writes are atomic and coalesced.
import fs from 'node:fs/promises';
import path from 'node:path';

const validId=id=>typeof id==='string'&&/^[a-zA-Z0-9-]{1,80}$/.test(id);
async function atomicWrite(dest,data){const tmp=dest+'.'+process.pid+'.tmp';await fs.writeFile(tmp,data);await fs.rename(tmp,dest);}
export async function openStore(dataDir){
  const dir=path.join(dataDir,'chats');
  const chats=[];
  let migrated=false;
  try{await fs.access(dir);}
  catch{
    await fs.mkdir(dir,{recursive:true});
    try{
      const legacy=JSON.parse(await fs.readFile(path.join(dataDir,'chats.json'),'utf8'));
      for(const chat of Array.isArray(legacy)?legacy:[])if(validId(chat?.id))await atomicWrite(path.join(dir,chat.id+'.json'),JSON.stringify(chat));
      await fs.rename(path.join(dataDir,'chats.json'),path.join(dataDir,'chats.json.migrated'));migrated=true;
    }catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}
  }
  for(const name of await fs.readdir(dir)){
    if(!name.endsWith('.json'))continue;
    try{const chat=JSON.parse(await fs.readFile(path.join(dir,name),'utf8'));if(validId(chat?.id))chats.push(chat);}catch{}
  }
  chats.sort((a,b)=>(b.updated||0)-(a.updated||0));
  const state=new Map();
  function save(chat){
    if(!validId(chat?.id))return Promise.reject(Error(tr('srv.badChatId')));
    let s=state.get(chat.id);if(!s){s={running:null,again:false};state.set(chat.id,s);}
    if(s.running){s.again=true;return s.running;}
    const loop=async()=>{
      try{do{s.again=false;await atomicWrite(path.join(dir,chat.id+'.json'),JSON.stringify(chat));}while(s.again);}
      finally{s.running=null;}
    };
    s.running=loop();return s.running;
  }
  async function remove(id){if(!validId(id))throw Error(tr('srv.badChatId'));await state.get(id)?.running?.catch(()=>{});state.delete(id);await fs.unlink(path.join(dir,id+'.json')).catch(e=>{if(e.code!=='ENOENT')throw e;});}
  async function flush(){await Promise.all([...state.values()].map(s=>s.running?.catch(()=>{})));}
  return {chats,save,remove,flush,migrated,dir};
}
export function chatSummary(chat){
  return {id:chat.id,title:chat.title,model:chat.model,created:chat.created,updated:chat.updated,project:chat.project||null,taskStatus:chat.taskStatus,messages:undefined,count:chat.messages?.length||0};
}
