// Partial updates are bounded, durable, and kept outside the artifact store.
// A validated complete payload still passes through the existing CAS and tensor checks.
import {tx} from './db.mjs';
import {fail} from '../protocol/errors.mjs';
import {sha256} from '../protocol/hash.mjs';
import {chunkSizes} from '../protocol/transfer.mjs';

export function createTransferStore(db,{now,authorize,store,status}){
  const get=id=>db.prepare('SELECT * FROM upload_sessions WHERE update_id=?').get(id);
  const parts=id=>db.prepare('SELECT idx FROM upload_chunks WHERE update_id=? ORDER BY idx').all(id).map(row=>row.idx);
  function clear(id){
    db.prepare('DELETE FROM upload_chunks WHERE update_id=?').run(id);
    db.prepare('DELETE FROM upload_sessions WHERE update_id=?').run(id);
  }
  function state(dev,u,session){
    const received=parts(u.update_id);
    const count=Math.ceil(u.bytes/session.chunk_bytes);
    return {...status(dev,u.update_id),upload_id:u.update_id,chunk_bytes:session.chunk_bytes,received,
      missing:Array.from({length:count},(_,idx)=>idx).filter(idx=>!received.includes(idx))};
  }
  function prune(){
    const expired=db.prepare('SELECT update_id FROM upload_sessions WHERE expires_at<=?').all(now());
    if(expired.length)tx(db,()=>{for(const x of expired)clear(x.update_id);});
  }
  return {
    prune,
    begin(dev,id,body){
      const {update:u,deadline}=authorize(dev,id,body.session_id);
      if(u.state!=='declared')return status(dev,id);
      if(!chunkSizes.includes(body.chunk_bytes))fail('INVALID_SCHEMA','unsupported chunk size');
      prune();
      let session=get(id);
      if(!session){
        const total=db.prepare('SELECT count(*) n FROM upload_sessions').get().n;
        const mine=db.prepare('SELECT count(*) n FROM upload_sessions WHERE device_id=?').get(dev).n;
        if(total>=32||mine>=2)fail('RATE_LIMITED','partial upload quota reached');
        db.prepare('INSERT INTO upload_sessions VALUES(?,?,?,?)').run(id,dev,body.chunk_bytes,deadline);
        session=get(id);
      }
      return state(dev,u,session);
    },
    put(dev,id,idx,hash,bytes,sessionId){
      const {update:u}=authorize(dev,id,sessionId);
      if(u.state!=='declared')return status(dev,id);
      const session=get(id);
      if(!session)fail('INVALID_TRANSITION','begin upload first');
      const size=session.chunk_bytes;
      if(!Number.isSafeInteger(idx)||idx<0||idx>=Math.ceil(u.bytes/size)||bytes.length!==Math.min(size,u.bytes-idx*size))
        fail('INVALID_SCHEMA','invalid update chunk index or length');
      if(sha256(bytes)!==hash)fail('CHUNK_RETRY','chunk digest mismatch');
      const previous=db.prepare('SELECT digest FROM upload_chunks WHERE update_id=? AND idx=?').get(id,idx);
      if(previous&&previous.digest!==hash)fail('DUPLICATE_DIFFERENT','chunk already stored with a different digest');
      if(!previous)db.prepare('INSERT INTO upload_chunks VALUES(?,?,?,?)').run(id,idx,hash,bytes);
      return state(dev,u,session);
    },
    complete(dev,id,body){
      const {update:u}=authorize(dev,id,body.session_id);
      if(u.state!=='declared')return status(dev,id);
      const session=get(id);
      if(!session)fail('INVALID_TRANSITION','begin upload first');
      if(state(dev,u,session).missing.length)fail('INVALID_TRANSITION','upload still has missing chunks');
      const rows=db.prepare('SELECT idx,digest,data FROM upload_chunks WHERE update_id=? ORDER BY idx').all(id);
      const damaged=rows.filter(row=>sha256(row.data)!==row.digest);
      if(damaged.length){
        tx(db,()=>{for(const row of damaged)db.prepare('DELETE FROM upload_chunks WHERE update_id=? AND idx=?').run(id,row.idx);});
        fail('CHUNK_RETRY','saved chunk digest mismatch; request missing chunks');
      }
      const content=Buffer.concat(rows.map(row=>row.data));
      if(sha256(content)!==u.payload_sha){
        tx(db,()=>clear(id));
        fail('HASH_MISMATCH','assembled payload does not match its declaration');
      }
      const result=store(dev,id,content,body.session_id);
      tx(db,()=>clear(id));
      return result;
    }
  };
}
