import {randomUUID} from 'node:crypto';
import {fail} from '../protocol/errors.mjs';
import {canonicalJSON,hashJSON} from '../protocol/hash.mjs';

export function compositionJobs({db,transaction},now=Date.now){
  db.exec(`CREATE TABLE IF NOT EXISTS fusion_composition_runs (
    id TEXT PRIMARY KEY,spec TEXT NOT NULL, spec_hash TEXT NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL,candidate TEXT);
    CREATE TABLE IF NOT EXISTS fusion_composition_stages (
    run TEXT NOT NULL REFERENCES fusion_composition_runs(id),ordinal INTEGER NOT NULL,stage TEXT NOT NULL,state TEXT NOT NULL,
    result TEXT,failure TEXT,PRIMARY KEY(run,ordinal));`);
  transaction(()=>{
    db.exec("UPDATE fusion_composition_stages SET state='QUEUED' WHERE state='RUNNING'; UPDATE fusion_composition_runs SET state='QUEUED' WHERE state='RUNNING'");
  });
  const get=id=>db.prepare('SELECT * FROM fusion_composition_runs WHERE id=?').get(id);
  const stages=id=>db.prepare('SELECT * FROM fusion_composition_stages WHERE run=? ORDER BY ordinal').all(id)
    .map(r=>({...r,result:r.result?JSON.parse(r.result):null}));
  const view=r=>({...r,spec:JSON.parse(r.spec),stages:stages(r.id)});
  function mark(id,state,candidate=null){db.prepare('UPDATE fusion_composition_runs SET state=?,candidate=coalesce(?,candidate) WHERE id=?').run(state,candidate,id);}
  return {
    list:()=>db.prepare('SELECT * FROM fusion_composition_runs ORDER BY created DESC,rowid DESC LIMIT 25').all().map(view),
    add(spec){return transaction(()=>{
      const hash=hashJSON(spec),existing=db.prepare("SELECT * FROM fusion_composition_runs WHERE spec_hash=? AND state IN ('QUEUED','RUNNING','PAUSED','DONE') ORDER BY created DESC LIMIT 1").get(hash);
      if(existing)return view(existing);
      const id=randomUUID();
      db.prepare("INSERT INTO fusion_composition_runs VALUES (?,?,?,'QUEUED',?,NULL)").run(id,canonicalJSON(spec),hash,now());
      const sequence=[...(spec.router.mode==='token'?['router']:[]),...(spec.fitLoop?['loop']:[]),'validation'];
      sequence.forEach((stage,i)=>db.prepare("INSERT INTO fusion_composition_stages VALUES (?,?,?,'QUEUED',NULL,NULL)").run(id,i,stage));
      return view(get(id));
    });},
    next(digest){
      for(const row of db.prepare("SELECT * FROM fusion_composition_runs WHERE state='QUEUED' ORDER BY created LIMIT 128").all()){
        const run=view(row);
        if(run.spec.base.backbone_sha256!==digest)continue;
        const stage=run.stages.find(s=>s.state!=='DONE');
        if(stage?.state==='QUEUED')return {run,stage};
      }
      return null;
    },
    begin(id,ordinal){return transaction(()=>{
      const changed=db.prepare("UPDATE fusion_composition_stages SET state='RUNNING',failure=NULL WHERE run=? AND ordinal=? AND state='QUEUED'").run(id,ordinal);
      if(changed.changes!==1||get(id)?.state!=='QUEUED')fail('STALE','composition stage is no longer queued');
      mark(id,'RUNNING');
    });},
    runnable(id){return get(id)?.state==='RUNNING';},
    finish(id,ordinal,result){return transaction(()=>{
      if(get(id)?.state!=='RUNNING')return false;
      db.prepare("UPDATE fusion_composition_stages SET state='DONE',result=? WHERE run=? AND ordinal=? AND state='RUNNING'")
        .run(canonicalJSON(result),id,ordinal);
      mark(id,result.candidate?'DONE':'QUEUED',result.candidate??null);
      return true;
    });},
    fail(id,ordinal,code,retry){return transaction(()=>{
      if(get(id)?.state!=='RUNNING')return;
      db.prepare("UPDATE fusion_composition_stages SET state=?,failure=? WHERE run=? AND ordinal=? AND state='RUNNING'")
        .run(retry?'QUEUED':'FAILED',code,id,ordinal);
      mark(id,retry?'QUEUED':'FAILED');
    });},
    control(id,action){return transaction(()=>{
      const state=get(id)?.state;
      const next=action==='pause'&&['QUEUED','RUNNING'].includes(state)?'PAUSED':action==='resume'&&state==='PAUSED'?'QUEUED':
        action==='stop'&&['QUEUED','RUNNING','PAUSED'].includes(state)?'STOPPED':null;
      if(!next)fail('INVALID_TRANSITION','invalid composition job command');
      if(next==='STOPPED')db.prepare("UPDATE fusion_composition_stages SET state='CANCELLED' WHERE run=? AND state<>'DONE'").run(id);
      else if(next==='PAUSED')db.prepare("UPDATE fusion_composition_stages SET state='QUEUED' WHERE run=? AND state='RUNNING'").run(id);
      mark(id,next);
      return view(get(id));
    });}
  };
}
