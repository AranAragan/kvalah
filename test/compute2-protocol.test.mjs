// Kvalah Compute v0.2 — protocol, tensors, aggregation, legacy reproduction (spec M01, M02, M05, M07).
import './compute-helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {decode,encode,parseHeader} from '../compute/protocol/safetensors.mjs';
import {getProfile,tensorSchema,schemaHash,verifyTensors,frozenAHash,sameA,onlyB,trainableCount,frozenCount,listProfiles} from '../compute/protocol/schema.mjs';
import {canonicalAdapter} from '../compute/protocol/canonical.mjs';
import {fedavg} from '../compute/protocol/aggregate.mjs';
import {normalizeConfig,configHash} from '../compute/protocol/config.mjs';
import {sha256,canonicalJSON} from '../compute/protocol/hash.mjs';
import {newKeyPair,signJSON,verifyJSON,requestPayload,signBytes,verifyBytes} from '../compute/protocol/sign.mjs';
import {readZip,writeZip} from '../compute/zip.mjs';
import {importLegacy} from '../compute/legacy.mjs';
import {python,skipNoPy,PY_ROOT,tmp,v01Zip} from './compute-helpers.mjs';

const P=getProfile('ministral3b-ffa-r8-v1'),T=getProfile('tiny-test-ffa-r4');
test('production profile matches the v0.1 tensor schema (26 layers, q 3072→4096, v 3072→1024, r=8, α=16)',()=>{
  const s=tensorSchema(P,true);
  assert.equal(Object.keys(s).length,104);
  assert.deepEqual(s['layers.0.self_attn.q_proj.A'],[8,3072]);assert.deepEqual(s['layers.0.self_attn.q_proj.B'],[4096,8]);
  assert.deepEqual(s['layers.25.self_attn.v_proj.A'],[8,3072]);assert.deepEqual(s['layers.25.self_attn.v_proj.B'],[1024,8]);
  assert.equal(trainableCount(P),26*(4096+1024)*8);assert.equal(trainableCount(P),1064960);
  assert.equal(frozenCount(P),26*2*8*3072);
  assert.match(schemaHash(P),/^[0-9a-f]{64}$/);
});
test('test-only profile is hidden without KVALAH_COMPUTE_TEST',()=>{
  const prev=process.env.KVALAH_COMPUTE_TEST;delete process.env.KVALAH_COMPUTE_TEST;
  try{assert.throws(()=>getProfile('tiny-test-ffa-r4'));assert.ok(!listProfiles().some(p=>p.test_only));}finally{process.env.KVALAH_COMPUTE_TEST=prev;}
});
test('M02 canonical init is deterministic, B=0, A uniform in ±1/sqrt(in)',()=>{
  const a=canonicalAdapter(T,42),b=canonicalAdapter(T,42),c=canonicalAdapter(T,43);
  assert.equal(sha256(encode(a)),sha256(encode(b)));
  assert.notEqual(frozenAHash(a),frozenAHash(c));
  for(const [k,t] of Object.entries(a)){
    if(k.endsWith('.B'))assert.ok(t.data.every(v=>v===0));
    else{const lim=1/Math.sqrt(t.shape[1]);assert.ok(t.data.every(v=>Math.abs(v)<=lim));}
  }
  // Pinned digest: any change to the init stream must be intentional (it changes every experiment's A).
  assert.equal(sha256(encode(canonicalAdapter(T,20261126))),'66834252641e74d2378f1e025413eb57ff4906a897839803ba0a06901662c3dc');
  assert.equal(frozenAHash(canonicalAdapter(P,20261126)),'2792a76f54aad26dca51e1d18e7a25a898549df9148695549ce11648bd100cdc');
});
test('M05 safetensors validation rejects bad dtype, shape, key, NaN, header and size',()=>{
  const good=canonicalAdapter(T,1),buf=encode(good);
  assert.deepEqual(Object.keys(decode(buf).tensors).sort(),Object.keys(good).sort());
  const bad=(fn,re)=>assert.throws(fn,re);
  // header length beyond file
  const b1=Buffer.from(buf);b1.writeBigUInt64LE(10n**9n,0);bad(()=>decode(b1),/header/i);
  // dtype
  const h=JSON.parse(buf.subarray(8,8+Number(buf.readBigUInt64LE(0))).toString());const k0=Object.keys(h).find(k=>k!=='__metadata__');
  const mk=hdr=>{const j=Buffer.from(JSON.stringify(hdr));const len=Buffer.alloc(8);len.writeBigUInt64LE(BigInt(j.length));return Buffer.concat([len,j,buf.subarray(8+Number(buf.readBigUInt64LE(0)))]);};
  bad(()=>decode(mk({...h,[k0]:{...h[k0],dtype:'F16'}})),/dtype|F32/i);
  bad(()=>decode(mk({...h,[k0]:{...h[k0],data_offsets:[0,999999999]}})),/offset|range|bounds/i);
  // schema: wrong key / wrong shape / NaN / missing / extra
  const t=decode(buf).tensors;
  bad(()=>verifyTensors({...t,'layers.9.self_attn.q_proj.B':t['layers.0.self_attn.q_proj.B']},T,true),/unexpected|extra|key/i);
  const {['layers.0.self_attn.q_proj.B']:_,...missing}=t;bad(()=>verifyTensors(missing,T,true),/keys differ|missing/i);
  const nan={...t,'layers.0.self_attn.q_proj.B':{...t['layers.0.self_attn.q_proj.B'],data:new Float32Array(t['layers.0.self_attn.q_proj.B'].data)}};nan['layers.0.self_attn.q_proj.B'].data[3]=NaN;
  bad(()=>verifyTensors(nan,T,true),/finite|NaN/i);
  const shp={...t,'layers.0.self_attn.v_proj.B':{shape:[T.rank,32],data:new Float32Array(T.rank*32)}};bad(()=>verifyTensors(shp,T,true),/shape/i);
  bad(()=>decode(Buffer.alloc(4)),/short|header|small/i);
  assert.throws(()=>parseHeader(buf,{maxBytes:10}),/large|exceed/i);
});
test('M07 FedAvg weights by supervised tokens, FP64 accumulation, deterministic order, A untouched',()=>{
  const base=canonicalAdapter(T,7);
  const mkU=(id,val,w)=>({id,weight:w,tensors:Object.fromEntries(Object.entries(onlyB(base)).map(([k,v])=>[k,{shape:v.shape,data:new Float32Array(v.data.length).fill(val)}]))});
  const r=fedavg(base,[mkU('task-b',3,30),mkU('task-a',1,10)],T);
  const k=Object.keys(onlyB(base))[0];
  assert.equal(r.tensors[k].data[0],(1*10+3*30)/40);
  assert.ok(sameA(base,r.tensors));
  assert.deepEqual(r.order,['task-a','task-b']);
  const r2=fedavg(base,[mkU('task-a',1,10),mkU('task-b',3,30)],T);
  assert.equal(sha256(encode(r.tensors)),sha256(encode(r2.tensors)));
  assert.throws(()=>fedavg(base,[mkU("x",1,0)],T),/weight|supervised tokens/i);
  assert.throws(()=>fedavg(base,[],T),/no updates|empty|at least/i);
});
test('config validation: presets, limits, research confirmation, immutable hash',()=>{
  const c=normalizeConfig({preset:'smoke',name:'s',profile_id:T.id,dataset_id:'d@1'});
  assert.equal(c.rounds,2);assert.equal(c.local_steps,3);assert.deepEqual(c.quorum,{mode:'all',target:3,min:3});
  assert.equal(configHash(c),configHash(normalizeConfig({preset:'smoke',name:'s',profile_id:T.id,dataset_id:'d@1'})));
  assert.throws(()=>normalizeConfig({preset:'research',name:'r',profile_id:T.id,dataset_id:'d@1'}),/research confirmation/);
  assert.throws(()=>normalizeConfig({preset:'smoke',name:'s',profile_id:T.id,dataset_id:'d@1',rounds:5}),/smoke/);
  assert.throws(()=>normalizeConfig({preset:'pilot',name:'p',profile_id:T.id,dataset_id:'d@1',max_length:512}),/memory preflight/);
  assert.throws(()=>normalizeConfig({preset:'pilot',name:'p',profile_id:T.id,dataset_id:''}),/dataset/);
  assert.throws(()=>normalizeConfig({preset:'pilot',name:'p',profile_id:T.id,dataset_id:'d',optimizer:{name:'lion'}}),/optimizer/);
});
test('Ed25519 request signatures bind method, path, body and nonce',()=>{
  const k=newKeyPair(),pl={method:'POST',path:'/v2/tasks/claim',bodySha:sha256('{}'),ts:1,nonce:'n',deviceId:'dev-x'};
  const s=signBytes(k.privateKey,requestPayload(pl));
  assert.ok(verifyBytes(k.publicKey,requestPayload(pl),s));
  for(const ch of [{path:'/v2/tasks/x/abandon'},{bodySha:sha256('{"a":1}')},{nonce:'m'},{deviceId:'dev-y'},{method:'GET'}])assert.equal(verifyBytes(k.publicKey,requestPayload({...pl,...ch}),s),false);
  const obj={b:1,a:[1,2]};assert.ok(verifyJSON(k.publicKey,{a:[1,2],b:1},signJSON(k.privateKey,obj)));
  assert.equal(canonicalJSON({b:1,a:{d:1,c:2}}),'{"a":{"c":2,"d":1},"b":1}');
});
test('zip reader rejects traversal and absolute paths; round-trips stored entries',()=>{
  const z=writeZip([['a/b.json',Buffer.from('{}')],['c.txt',Buffer.from('hi')]]);
  const r=readZip(z);assert.equal(r.get('c.txt').toString(),'hi');
  for(const evil of ['../x','/etc/passwd','C:/x','a/../../x']){
    const zz=writeZip([['ok',Buffer.from('1')]]);const i=zz.indexOf(Buffer.from('ok'));
    // craft entries by hand: writeZip itself refuses unsafe names
    assert.throws(()=>writeZip([[evil,Buffer.from('1')]]),/unsafe/);void i;
  }
  const bs=writeZip([['dir/x',Buffer.from('1')]]);let s=Buffer.from(bs);let j;while((j=s.indexOf('dir/x'))>=0){s.write('..\\x\0'.slice(0,5),j);}
  assert.throws(()=>readZip(s),/unsafe/);
});
test('M01 v0.1 legacy archive: both aggregations reproduce bit-exactly, A frozen',{skip:v01Zip()?false:'set KVALAH_V01_ZIP to experiment-v01.zip'},()=>{
  const r=importLegacy(v01Zip());
  assert.equal(r.verified_all,true);
  assert.equal(r.aggregation.length,2);
  for(const a of r.aggregation){assert.equal(a.bitwise_equal,true);assert.equal(a.mismatched_values,0);assert.equal(a.A_unchanged,true);}
  assert.deepEqual(r.aggregation[0].updates.map(u=>[u.node,u.weight]),[['msi',41],['rog',38],['mac',38]]);
  assert.equal(r.frozen_A_constant,true);
  assert.equal(r.legacy_unverified_identity,true);assert.equal(r.legacy_unverified_model_revision,true);
});
test('Python canonical encoder is byte-identical to Node (cross-runtime tensor format)',{skip:skipNoPy()},()=>{
  const d=tmp(),t=canonicalAdapter(T,5),f=path.join(d,'a.safetensors');fs.writeFileSync(f,encode(t));
  const code=`import sys,json;from kvalah_compute.canonical import decode,encode,frozen_a_hash
b=open(sys.argv[1],'rb').read();t=decode(b);print(json.dumps({"same":encode(t)==b,"fa":frozen_a_hash(t)}))`;
  const r=spawnSync(python(),['-c',code,f],{encoding:'utf8',env:{...process.env,PYTHONPATH:PY_ROOT}});
  assert.equal(r.status,0,r.stderr);const o=JSON.parse(r.stdout);
  assert.equal(o.same,true);assert.equal(o.fa,frozenAHash(t));
});
