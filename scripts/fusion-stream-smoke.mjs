import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {once} from 'node:events';
import {createCoordinatorService} from '../compute/coordinator/service.mjs';
import {openFusion} from '../compute/fusion/registry.mjs';
import {putArtifact,putArtifactFile,createGrantStore,createStreamingProvisionStore,signAssignment} from '../compute/fusion/provision.mjs';
import {hashFile,STREAM_CHUNK} from '../compute/fusion/stream.mjs';
import {createClient} from '../compute/worker/client.mjs';
import {pairWithCoordinator} from '../compute/worker/pair.mjs';
import {newKeyPair} from '../compute/protocol/sign.mjs';
import {encode} from '../compute/protocol/safetensors.mjs';

const [output,mode]=process.argv.slice(2);
if(!output||!['short','full'].includes(mode))throw Error('node scripts/fusion-stream-smoke.mjs <output.jsonl> short|full');
const sizes=mode==='full'?[4300000,100000000,324*1024**2,1024**3]:[4300000,17000000];
const parent=fs.realpathSync(os.tmpdir());
const scratch=fs.mkdtempSync(path.join(parent,'kvalah-fusion-stream-'));
assert.equal(path.dirname(scratch),parent);
const out=fs.openSync(output,'wx',0o600);
try{
  for(const bytes of sizes){
    const setup=fs.mkdtempSync(path.join(scratch,'case-'));
    const started=performance.now();
    const fusion=path.join(setup,'fusion');
    fs.mkdirSync(fusion);
    fs.writeFileSync(path.join(fusion,'serve-grants'),'1');
    const registry=openFusion(fusion);
    const service=createCoordinatorService({dir:path.join(setup,'coordinator')});
    let proxy,client,dropNext=false,drops=0,written=0;
    const sockets=new Set();
    try{
      const lab=await service.start({bindIp:'127.0.0.1',port:0});
      proxy=net.createServer(down=>{
        const up=net.connect(lab.port,'127.0.0.1');
        sockets.add(down);sockets.add(up);
        for(const [a,b] of [[down,up],[up,down]]){
          a.on('error',()=>b.destroy());a.on('close',()=>{sockets.delete(a);b.destroy();});
        }
        down.pipe(up);
        let relayed=0;
        up.on('data',block=>{
          if(dropNext){
            relayed+=block.length;
            if(relayed>=16*1024){dropNext=false;drops++;down.destroy();up.destroy();return;}
          }else relayed=0;
          if(!down.write(block)){up.pause();down.once('drain',()=>up.resume());}
        });
      }).listen(0,'127.0.0.1');
      await once(proxy,'listening');
      const endpoint='https://127.0.0.1:'+proxy.address().port;
      const kp=newKeyPair(),identity={device_id:'dev-'+'a'.repeat(32),private_key:kp.privateKey,public_key:kp.publicKey};
      await pairWithCoordinator({pairing:service.createPairing().pairing,identity,alias:'Stream fixture'});
      service.coord.approveDevice(identity.device_id);
      client=createClient({endpoint,fingerprint:lab.fingerprint,identity,onTraffic:(n,direction)=>{if(direction==='in')written+=n;}});
      await client.syncTime();
      const source=path.join(setup,'source.bin');
      const fd=fs.openSync(source,'wx');
      try{
        const chunk=Buffer.alloc(STREAM_CHUNK,0x21);
        for(let start=0;start<bytes;start+=STREAM_CHUNK){
          chunk.writeBigUInt64LE(BigInt(start),0);
          fs.writeSync(fd,chunk,0,Math.min(chunk.length,bytes-start));
        }
        fs.fsyncSync(fd);
      }finally{fs.closeSync(fd);}
      const large=await putArtifactFile(registry.cas,'backbone',source,'synthetic transport fixture',{quotaBytes:bytes+16*1024**2});
      const A='layers.0.mlp.A',B='layers.0.mlp.B';
      const weights=encode({[A]:{shape:[1,2],data:new Float32Array([1,2])},[B]:{shape:[2,1],data:new Float32Array([0,0])}});
      const hash=ch=>ch.repeat(64);
      const entry=registry.create({key:'code',name:'Stream test',domain:'code',kind:'ffa-lora',rank:1,alpha:2,layers:[0],
        base:{revision:'stream-fixture',backbone_sha256:large.sha256,tokenizer_sha256:hash('1'),architecture_sha256:hash('2'),layers:1,width:2,parameters:16},
        tensors:[{name:A,shape:[1,2],dtype:'F32'},{name:B,shape:[2,1],dtype:'F32'}],dataset_sha256:hash('3'),license:'CC0-1.0',
        training:{optimizer:'sgd',lr:.1,local_steps:1,grad_accum:1,clip:1}});
      registry.change(entry.id,'CREATED','PROVISIONING');
      const expert=registry.checkpoint(entry.id,weights);
      const arts=[large,putArtifact(registry.cas,'expert',weights,'fixture'),putArtifact(registry.cas,'train',Buffer.from('fixture train'),'fixture')];
      const grant=signAssignment(registry,{device:identity.device_id,expert,artifacts:arts});
      createGrantStore(registry,path.join(fusion,'grants')).grant(grant);
      const get=await client.get('/v2/fusion/assignment');
      let requests=0,peakRss=process.memoryUsage().rss,onceDropped=false,peakArrayBuffers=process.memoryUsage().arrayBuffers;
      const countMemory=()=>{const m=process.memoryUsage();peakRss=Math.max(peakRss,m.rss);peakArrayBuffers=Math.max(peakArrayBuffers,m.arrayBuffers);};
      const arg={publicKey:registry.publicKey,device:identity.device_id,consented:true,permit:()=>bytes+16*1024**2-written,
        async fetchCoordinator(m,p,opts){
          requests++;
          if(requests===2&&!onceDropped){onceDropped=true;dropNext=true;}
          for(let attempt=0;;attempt++){
            try{return (await client.get(`/v2/fusion/parts/${m.id}/${p.sha256}`,{payload:true,json:false,maxPayload:opts.maxBytes})).bytes;}
            catch(error){if(error.code!=='RATE_LIMITED'||attempt>=3)throw error;await delay(1050);}
          }
        }};
      const cache=()=>createStreamingProvisionStore({root:path.join(setup,'worker'),quotaBytes:bytes+1024**2,onEvent:countMemory});
      const startReceive=performance.now();
      await assert.rejects(cache().provision(get.envelope,arg),{code:'UNAVAILABLE'});
      assert.equal(drops,1);
      const result=await cache().provision(get.envelope,arg);
      const model=result.items[0];
      assert.equal(model.reused,1);
      assert.equal(model.received,large.parts.length-1);
      assert.equal(hashFile(model.file),large.sha256);
      assert.equal(written>=bytes,true);
      fs.writeSync(out,JSON.stringify({classification:'MEASURED',transport:'pinned TLS over interrupted loopback TCP',bytes,parts:large.parts.length,
        verified_sha256:large.sha256,stored_chunks_reused:model.reused,disconnections:drops,download_requests:requests,charged_bytes:written,
        receive_ms:Math.round(performance.now()-startReceive),wall_ms:Math.round(performance.now()-started),peak_rss_bytes:peakRss,
        peak_array_buffers_bytes:peakArrayBuffers})+'\n');
    }finally{
      client?.close();for(const socket of sockets)socket.destroy();proxy?.close();await service.close();registry.close();
      fs.rmSync(setup,{recursive:true,force:true});
    }
  }
}finally{fs.closeSync(out);fs.rmSync(scratch,{recursive:true,force:true});}
