import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createArtifactCache} from '../compute/worker/artifacts.mjs';
import {createWorker} from '../compute/worker/worker.mjs';
import {maintainLease} from '../compute/worker/lease.mjs';
import {createGovernor} from '../compute/governor/governor.mjs';
import {sha256} from '../compute/protocol/hash.mjs';
import {tmp} from './compute-helpers.mjs';

test('T01: low memory suppresses claim and keeps the control session alive', async () => {
  const dir=tmp('kc-admission-');
  const gov=createGovernor({stateDir:dir,policy:{only_idle:false,only_ac:false,pause_on_games:false}});
  gov.setEnabled(true);
  gov.setSensors({ram_free_bytes:1.28*2**30});
  const calls=[];
  let paused;
  const pause=new Promise(resolve=>{paused=resolve;});
  const worker=createWorker({
    stateDir:dir, governor:gov, identity:{device_id:'test'},
    link:{endpoint:'https://127.0.0.1:1',project_id:'test',fingerprint:'test'},
    capabilities:()=>({}),
    onState:s=>{if(s.state==='PAUSED')paused(s.reason);},
    makeClient:()=>({
      syncTime:async()=>{},
      bytes:{in:0,out:0},
      post:async route=>{
        calls.push(route);
        return {session_id:'session',state:'active'};
      }
    })
  });
  try{
    worker.start();
    assert.equal(await pause,'low_memory');
    assert.deepEqual(calls,['/v2/devices/session','/v2/devices/heartbeat']);
  }finally{
    await worker.stop();
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('T03/T04: cache deduplicates concurrent fetches, persists across attempts, and repairs corruption', async () => {
  const dir=tmp('kc-artifacts-'),bytes=Buffer.from('immutable adapter'),hash=sha256(bytes);
  let downloads=0;
  const download=async()=>{downloads++;return bytes;};
  const open=()=>createArtifactCache(dir,{limitBytes:()=>1024});
  try{
    const cache=open();
    for(const result of await Promise.all(Array.from({length:100},()=>cache.get(hash,download,bytes.length))))assert.deepEqual(result,bytes);
    assert.deepEqual(await open().get(hash,download,bytes.length),bytes);
    assert.equal(downloads,1);
    fs.writeFileSync(path.join(dir,hash),'damaged');
    assert.deepEqual(await open().get(hash,download,bytes.length),bytes);
    assert.equal(downloads,2);
    const overQuota=Buffer.alloc(1025,3);
    await assert.rejects(open().get(sha256(overQuota),async()=>{throw Error('download must not start');},overQuota.length),/cache disk quota/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('T05/T06: one renewal at a time, expiry extends beyond original TTL and stops at the round deadline',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:8000});
  let renewals=0, complete;
  const lease=maintainLease({
    task:{task_id:'task',lease_expires_at:9000,round_deadline_at:10000},
    mono:Date.now,serverNow:Date.now,onEvent:()=>{},
    renew:()=>{
      renewals++;
      return new Promise(resolve=>{complete=resolve;});
    }
  });
  t.mock.timers.tick(500);
  assert.equal(renewals,1);
  t.mock.timers.tick(200);
  assert.equal(renewals,1);
  complete({lease_expires_at:10000,server_time:Date.now()});
  await Promise.resolve();
  t.mock.timers.tick(600);
  lease.check();
  assert.equal(lease.snapshot.expires_at,10000);
  t.mock.timers.tick(700);
  assert.throws(()=>lease.check(),{code:'LEASE_EXPIRED'});
  assert.equal(renewals,1);
});

test('T19/T20: CPU zero blocks compute and persisted payload usage exhausts the network budget',()=>{
  const dir=tmp('kc-traffic-');
  const policy={only_idle:false,only_ac:false,pause_on_games:false,daily_traffic_mb:10};
  const open=()=>{const g=createGovernor({stateDir:dir,policy});g.setEnabled(true);return g;};
  try{
    const g=open();
    g.setPolicy({cpu_target_pct:0});
    g.setSensors({ram_free_bytes:8*2**30});
    assert.equal(g.decide({phase:'preflight'}).reason,'cpu_zero');
    g.accountTraffic(10000000);
    const restored=open();
    assert.equal(restored.trafficRemaining(),0);
    assert.equal(restored.decide({phase:'network'}).reason,'traffic_cap');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
