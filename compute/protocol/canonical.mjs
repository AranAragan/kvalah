// Canonical adapter initialisation on the coordinator (spec §6): A is drawn exactly once, serialised FP32,
// B starts at zero. The generator is a SHA-256 counter stream, so every platform produces identical bytes
// (v0.1 lesson: independent per-node initialisation produced different A hashes for the same seed).
// Distribution: U(-1/sqrt(in), 1/sqrt(in)) — the same bound PEFT's kaiming_uniform(a=sqrt(5)) uses and v0.1 used.
import {createHash} from 'node:crypto';
import {tensorSchema,targetNames} from './schema.mjs';
import {encode} from './safetensors.mjs';
function* stream(seed,key){
  for(let counter=0;;counter++){
    const block=createHash('sha256').update(`kvalah-compute-v2|${seed}|${key}|${counter}`).digest();
    for(let i=0;i<32;i+=4)yield block.readUInt32LE(i);
  }
}
export function canonicalAdapter(profile,seed){
  if(!Number.isSafeInteger(seed)||seed<0)throw Error('seed must be a non-negative integer');
  const schema=tensorSchema(profile,true),out={};
  for(const name of targetNames(profile)){
    const [r,inF]=schema[name+'.A'],bound=1/Math.sqrt(inF),a=new Float32Array(r*inF),g=stream(seed,name+'.A');
    for(let i=0;i<a.length;i++){const u=(g.next().value>>>8)/16777216;a[i]=Math.fround((2*u-1)*bound);}
    out[name+'.A']={shape:[r,inF],data:a};
    const [o,rr]=schema[name+'.B'];out[name+'.B']={shape:[o,rr],data:new Float32Array(o*rr)};
  }
  return out;
}
export const adapterBytes=(t,meta)=>encode(t,meta);
