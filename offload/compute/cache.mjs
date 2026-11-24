// Two-tier cache: in-memory LRU in front of a file cache (one JSON file per key).
// v0.3 (CACHE-01):
//   * atomic writes through unique temp files (pid + random), rename into place; concurrent writers are safe;
//   * strict disk quota: an index of entry sizes is built at startup (and refreshed periodically to see other
//     processes' writes); every write evicts until the total is ≤ maxBytes; entries larger than the quota are not written;
//   * eviction policy: TTL first, then LRU — a disk hit bumps the file's mtime (utimes), so "least recently used" is real;
//   * private permissions: directories 0700 (also fixed on existing dirs), files 0600;
//   * entries record their workspace scope: clear({workspace}) removes one workspace, clear() everything;
//   * corrupt or unreadable entries are a miss and are removed.
// v0.4 CACHE-02: the quota holds across processes: every write updates a shared usage ledger (<dir>/.quota/usage) under
//   an exclusive lock file (<dir>/.quota/lock, O_EXCL, stale locks of dead pids broken); when the ledger exceeds
//   maxBytes the writer rescans the directory and evicts under the lock. The ledger can only over-estimate (removals
//   outside the lock), which costs an extra scan, never a quota breach.
// v0.4 CACHE-03: every entry carries h = sha256(key, at, ws, value); a modified, truncated or moved (other key's)
//   entry fails the check and is removed. Protects against corruption and accidental edits, not against an attacker
//   who can write the 0700 cache directory (same OS user). v0.3 entries (no h) are treated as corrupt once.
import {mkdir,readFile,writeFile,rename,readdir,stat,unlink,utimes,chmod,open} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import path from 'node:path';
export function createCache({dir=null,memoryEntries=64,ttlMs=7*24*3600*1000,maxBytes=64*1024*1024,now=Date.now,rescanEvery=50}={}){
  const mem=new Map();let ready=null;const stats={hits:0,diskHits:0,misses:0,writes:0,evictions:0,expired:0,errors:0,corrupt:0,skippedTooLarge:0,quotaScans:0,lockTimeouts:0};
  const file=k=>path.join(dir,k.slice(0,2),k+'.json');
  const digest=(k,e)=>createHash('sha256').update(JSON.stringify([k,e.at,e.ws??null,e.value])).digest('hex');
  const touchMem=(k,v)=>{mem.delete(k);mem.set(k,v);while(mem.size>memoryEntries)mem.delete(mem.keys().next().value);};
  const index=new Map(); // file path -> {size, used}
  let total=0,writesSinceScan=0;
  const idxSet=(p,size,used)=>{const o=index.get(p);if(o)total-=o.size;index.set(p,{size,used});total+=size;};
  const idxDel=p=>{const o=index.get(p);if(o){total-=o.size;index.delete(p);}};
  async function scan(){
    index.clear();total=0;
    for(const sub of await readdir(dir).catch(()=>[])){const d=path.join(dir,sub);
      for(const f of await readdir(d).catch(()=>[])){const p=path.join(d,f);
        if(f.endsWith('.tmp')){const s=await stat(p).catch(()=>null);if(s&&now()-s.mtimeMs>60000)await unlink(p).catch(()=>{});continue;} // stale temp from a crashed writer
        if(!f.endsWith('.json'))continue;const s=await stat(p).catch(()=>null);if(s)idxSet(p,s.size,s.mtimeMs);}}
  }
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  async function withLock(fn){
    await mkdir(path.join(dir,'.quota'),{recursive:true,mode:0o700});const lock=path.join(dir,'.quota','lock');const deadline=now()+3000;let got=false;
    while(!got){
      try{const fh=await open(lock,'wx',0o600);await fh.writeFile(String(process.pid)).finally(()=>fh.close());got=true;break;}
      catch(e){if(e.code!=='EEXIST')throw e;}
      let txt='';try{txt=(await readFile(lock,'utf8')).trim();}catch{}
      const pid=Number.parseInt(txt,10);let stale=false;
      if(pid>0){try{process.kill(pid,0);}catch(e){stale=e.code!=='EPERM';}}
      else{const st=await stat(lock).catch(()=>null);stale=!!st&&Date.now()-st.mtimeMs>10_000;}
      if(stale){const aside=`${lock}.${process.pid}.${randomBytes(4).toString('hex')}.stale`;
        try{await rename(lock,aside);const again=(await readFile(aside,'utf8')).trim();if(again!==txt)await rename(aside,lock).catch(()=>{});else await unlink(aside).catch(()=>{});}catch{}continue;}
      if(Date.now()>deadline){stats.lockTimeouts++;break;}   // degrade: run unlocked rather than block the engine
      await sleep(3+Math.floor(Math.random()*10));
    }
    try{return await fn();}finally{if(got)await unlink(lock).catch(()=>{});}
  }
  async function readLedger(){try{const n=Number((await readFile(path.join(dir,'.quota','usage'),'utf8')).trim());return Number.isFinite(n)&&n>=0?n:null;}catch{return null;}}
  async function writeLedger(n){const f=path.join(dir,'.quota','usage'),tmp=`${f}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try{await writeFile(tmp,String(Math.max(0,Math.round(n))),{mode:0o600});await rename(tmp,f);}catch{await unlink(tmp).catch(()=>{});}}
  async function rescanAndEnforce(){stats.quotaScans++;await scan();await enforce();await writeLedger(total);}
  const ensure=()=>ready??=(async()=>{await mkdir(dir,{recursive:true,mode:0o700});if(process.platform!=='win32')await chmod(dir,0o700).catch(()=>{});await withLock(rescanAndEnforce);})();
  async function remove(p){await unlink(p).catch(()=>{});idxDel(p);stats.evictions++;}
  async function enforce(){
    const list=[...index.entries()].sort((a,b)=>a[1].used-b[1].used);
    for(const [p,o] of list){if(now()-o.used>ttlMs){await remove(p);continue;}if(total<=maxBytes)break;await remove(p);}
  }
  return {
    stats:()=>({...stats,memoryEntries:mem.size,dir,diskBytes:dir?total:0,maxBytes,policy:'ttl+lru (access refreshes mtime)'}),
    async get(k){
      const m=mem.get(k);
      if(m){if(now()-m.at<=ttlMs){touchMem(k,m);stats.hits++;return m.value;}mem.delete(k);stats.expired++;}
      if(dir){
        await ensure().catch(()=>{});
        const p=file(k);let raw=null;try{raw=await readFile(p,'utf8');}catch{}
        if(raw!==null){
          let d=null;try{d=JSON.parse(raw);}catch{}
          if(!d||typeof d!=='object'||!('value' in d)||!Number.isFinite(d.at)||typeof d.h!=='string'||d.h!==digest(k,d)){stats.corrupt++;await remove(p);}
          else if(now()-d.at<=ttlMs){touchMem(k,d);stats.diskHits++;const t=new Date(now());await utimes(p,t,t).catch(()=>{});const o=index.get(p);if(o)o.used=now();return d.value;}
          else{stats.expired++;await remove(p);}
        }
      }
      stats.misses++;return undefined;
    },
    // opts.disk=false keeps the entry in memory only (sensitive tasks); opts.workspace scopes clear()
    async set(k,value,{disk=true,workspace=null}={}){
      const e={at:now(),ws:workspace,value};touchMem(k,e);
      if(!dir||!disk)return;
      try{
        await ensure();const p=file(k);const body=JSON.stringify({...e,h:digest(k,e)});const size=Buffer.byteLength(body);
        if(size>maxBytes){stats.skippedTooLarge++;return;}
        await mkdir(path.dirname(p),{recursive:true,mode:0o700});
        const tmp=`${p}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
        try{await writeFile(tmp,body,{mode:0o600,flag:'wx'});}catch(err){await unlink(tmp).catch(()=>{});throw err;}
        await withLock(async()=>{
          const old=(await stat(p).catch(()=>null))?.size||0;
          try{await rename(tmp,p);}catch(err){await unlink(tmp).catch(()=>{});throw err;}
          {const t=new Date(now());await utimes(p,t,t).catch(()=>{});}   // mtime = cache clock (LRU order survives rescans)
          stats.writes++;idxSet(p,size,now());
          let used=await readLedger();
          if(used===null||++writesSinceScan>=rescanEvery){writesSinceScan=0;await rescanAndEnforce();return;}
          used+=size-old;
          if(used>maxBytes)await rescanAndEnforce();else await writeLedger(used);
        });
      }catch{stats.errors++;}
    },
    async prune(){if(dir){await ensure();await withLock(rescanAndEnforce);}},
    async clear({workspace}={}){
      for(const [k,v] of [...mem])if(!workspace||v.ws===workspace)mem.delete(k);
      if(!dir)return;await ensure();await scan();
      for(const p of [...index.keys()]){
        if(workspace){let d=null;try{d=JSON.parse(await readFile(p,'utf8'));}catch{}if(d&&d.ws!==workspace)continue;}
        await remove(p);
      }
      await withLock(async()=>writeLedger(total));
    },
    clearMemory(){mem.clear();}
  };
}
