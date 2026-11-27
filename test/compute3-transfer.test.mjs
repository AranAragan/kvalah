import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmp} from './compute-helpers.mjs';
import {createOutbox} from '../compute/worker/outbox.mjs';
import {createTransferStore} from '../compute/coordinator/transfer.mjs';
import {openDB} from '../compute/coordinator/db.mjs';
import {sha256} from '../compute/protocol/hash.mjs';
import {ComputeError} from '../compute/protocol/errors.mjs';
import {createGovernor} from '../compute/governor/governor.mjs';

test('partial upload survives restart, validates checksums and only needs the final missing chunk',()=>{
  const directory=tmp('kc-transfer-'),dbFile=path.join(directory,'coordinator.sqlite');
  const size=262144,body=Buffer.alloc(size*9+67,0xab);
  const update={update_id:'upd-test',bytes:body.length,payload_sha:sha256(body),state:'declared'};
  let observed=null,db=openDB(dbFile);
  const open=()=>createTransferStore(db,{
    now:()=>1,authorize:(dev,id,sid)=>{
      if(dev!=='owner')throw new ComputeError('NOT_OWNER','owner mismatch');
      assert.equal(id,update.update_id);assert.equal(sid,'session');
      return {update,deadline:10000};
    },status:()=>({...update}),store:(_dev,_id,bytes)=>{
      observed=Buffer.from(bytes);update.state='uploaded';return {...update};
    }
  });
  try{
    let s=open(),config={session_id:'session',chunk_bytes:size};
    assert.equal(s.begin('owner',update.update_id,config).missing.length,10);
    const put=(i,bytes=body.subarray(i*size,(i+1)*size),hash=sha256(bytes))=>
      s.put('owner',update.update_id,i,hash,bytes,'session');
    for(let i=0;i<9;i++)put(i);
    assert.deepEqual(put(8).missing,[9],'duplicate ACK reads the same progress');
    assert.throws(()=>s.complete('owner',update.update_id,config),{code:'INVALID_TRANSITION'});
    db.close();db=openDB(dbFile);s=open();
    assert.deepEqual(s.begin('owner',update.update_id,config).missing,[9]);
    assert.throws(()=>s.begin('other',update.update_id,config),{code:'NOT_OWNER'});
    const tail=body.subarray(9*size);
    assert.throws(()=>put(9,Buffer.alloc(tail.length),sha256(tail)),{code:'CHUNK_RETRY'});
    assert.deepEqual(s.begin('owner',update.update_id,config).missing,[9]);
    put(9);
    db.prepare('update upload_chunks set data=? where update_id=? and idx=?').run(Buffer.alloc(tail.length),update.update_id,9);
    assert.throws(()=>s.complete('owner',update.update_id,config),{code:'CHUNK_RETRY'});
    assert.deepEqual(s.begin('owner',update.update_id,config).missing,[9]);
    put(9);assert.equal(s.complete('owner',update.update_id,config).state,'uploaded');
    assert.deepEqual(observed,body);
    assert.equal(s.complete('owner',update.update_id,config).state,'uploaded');
    assert.equal(db.prepare('select count(*) n from upload_chunks').get().n,0);
  }finally{db.close();}
});

test('outbox survives interrupted metadata and keeps the same payload and ACK history',()=>{
  const dir=tmp('kc-outbox3-'),b=createOutbox(dir);
  const data=Buffer.from('weights');
  const original=b.put({task_id:'task-x',lease_id:'lease-x'},data,{supervised_tokens:12},{scope:'scope'});
  b.update(original.key,{state:'uploading',confirmed_chunks:[0]});
  fs.writeFileSync(path.join(dir,original.key,'meta.json'),'{');
  const revived=createOutbox(dir);
  assert.equal(revived.pending()[0].key,original.key);
  assert.deepEqual(revived.bytes(original.key),data);
  revived.update(original.key,{state:'accepted',result:{update_id:'upd-x'}});
  assert.equal(revived.pending().length,0);
  assert.equal(revived.accepted().length,1);
});

test('LAN and WAN limits are independent and strict mode fails closed without an operation bound',()=>{
  const g=createGovernor({});
  g.setEnabled(true);
  g.setPolicy({only_idle:false,only_ac:false,pause_on_games:false,min_free_ram_gib:0,
    lan_traffic_mb:20,wan_traffic_mb:10,daily_traffic_mb:100});
  g.accountTraffic(10e6,'out','wan');
  assert.equal(g.decide({phase:'network',scope:'wan'}).reason,'traffic_cap');
  assert.equal(g.trafficRemaining('lan'),20e6);
  g.accountTraffic(2e6,'in','lan');
  assert.equal(g.budget().bytes_out,10e6);assert.equal(g.budget().bytes_in,2e6);
  g.setPolicy({wan_traffic_mb:15,activity_mode:'strict'});
  assert.equal(g.decide({phase:'network',scope:'wan'}).run,true);
  assert.equal(g.decide({phase:'compute'}).reason,'strict_operation_unbounded');
});
