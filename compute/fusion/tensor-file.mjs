// Safetensors F32 operations that retain at most one numeric block per file in memory.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fail} from '../protocol/errors.mjs';
import {hashFile,MAX_STREAM_BYTES} from './stream.mjs';
import {MAX_HEADER} from '../protocol/safetensors.mjs';

const BLOCK=256*1024;
const NAME=/^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*$/;
const count=shape=>shape.reduce((a,b)=>a*b,1);
const checkName=name=>typeof name==='string'&&NAME.test(name)&&!name.split('.').some(k=>['constructor','prototype','__proto__'].includes(k));

function read(fd,range){
  const bytes=Buffer.allocUnsafe(range.bytes);
  let got=0;
  while(got<bytes.length){
    const n=fs.readSync(fd,bytes,got,bytes.length-got,range.start+got);
    if(!n)fail('INVALID_TENSOR','unexpected end of tensor file');
    got+=n;
  }
  return bytes;
}

function write(fd,buffer){
  let sent=0;
  while(sent<buffer.length){
    const n=fs.writeSync(fd,buffer,sent,buffer.length-sent);
    if(!n)fail('DISK_SPACE','incomplete tensor write');
    sent+=n;
  }
}

function normal(schema){
  if(!Array.isArray(schema)||!schema.length||schema.length>8192)fail('INVALID_SCHEMA','invalid streamed tensor schema');
  const out=new Map();
  for(const t of [...schema].sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
    if(!checkName(t.name)||out.has(t.name)||!Array.isArray(t.shape)||t.shape.length<1||t.shape.length>4||
      !t.shape.every(n=>Number.isSafeInteger(n)&&n>0)||!Number.isSafeInteger(count(t.shape)*4)||count(t.shape)*4>MAX_STREAM_BYTES||t.dtype!=='F32')
      fail('INVALID_SCHEMA','invalid streamed tensor');
    out.set(t.name,t);
  }
  return out;
}

function header(schema){
  const data=Object.create(null);
  let byte=0;
  for(const [key,t] of schema){
    const length=count(t.shape)*4;
    data[key]={dtype:'F32',shape:t.shape,data_offsets:[byte,byte+length]};
    byte+=length;
  }
  const json=JSON.stringify(data),body=Buffer.from(json+' '.repeat((8-json.length%8)%8),'utf8');
  if(body.length>MAX_HEADER||body.length+byte+8>MAX_STREAM_BYTES)fail('TOO_LARGE','tensor file exceeds streaming profile');
  const prefix=Buffer.alloc(8);
  prefix.writeBigUInt64LE(BigInt(body.length));
  return Buffer.concat([prefix,body]);
}

function openTensor(file,schema){
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size<10||stat.size>MAX_STREAM_BYTES)fail('INVALID_TENSOR','invalid tensor file');
  const fd=fs.openSync(file,'r');
  try{
    const n=Number(read(fd,{start:0,bytes:8}).readBigUInt64LE());
    if(!Number.isSafeInteger(n)||n<2||n>MAX_HEADER||8+n>stat.size)fail('INVALID_TENSOR','invalid safetensors header length');
    let parsed;
    try{parsed=JSON.parse(read(fd,{start:8,bytes:n}).toString('utf8'));}catch{fail('INVALID_TENSOR','tensor header is not JSON');}
    if(!parsed||Array.isArray(parsed)||typeof parsed!=='object')fail('INVALID_TENSOR','invalid tensor header');
    const ranges=new Map();
    for(const [name,t] of Object.entries(parsed)){
      if(name==='__metadata__'){
        if(!t||Array.isArray(t)||typeof t!=='object'||Object.values(t).some(v=>typeof v!=='string'))fail('INVALID_TENSOR','incorrect tensor metadata');
        continue;
      }
      const spec=schema.get(name);
      if(!spec||t?.dtype!=='F32'||!Array.isArray(t.shape)||t.shape.length!==spec.shape.length||!t.shape.every((d,i)=>d===spec.shape[i])||
        !Array.isArray(t.data_offsets)||t.data_offsets.length!==2)fail('INVALID_TENSOR','incorrect tensor schema for '+name);
      const [a,b]=t.data_offsets,bytes=count(spec.shape)*4;
      if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||a<0||b-a!==bytes||b>stat.size-8-n)fail('INVALID_TENSOR','incorrect range for '+name);
      ranges.set(name,{start:a+8+n,bytes});
    }
    if(ranges.size!==schema.size)fail('INVALID_TENSOR','missing streamed tensor');
    let end=8+n;
    for(const r of [...ranges.values()].sort((a,b)=>a.start-b.start)){
      if(r.start!==end)fail('INVALID_TENSOR','overlapping or sparse tensor ranges');
      end+=r.bytes;
    }
    if(end!==stat.size)fail('INVALID_TENSOR','trailing tensor data');
    return {fd,ranges,close:()=>fs.closeSync(fd)};
  }catch(error){fs.closeSync(fd);throw error;}
}

function eachBlock(range,visit){
  for(let offset=0;offset<range.bytes;offset+=BLOCK)visit(offset,Math.min(BLOCK,range.bytes-offset));
}

function values(buffer){return new Float32Array(buffer.buffer,buffer.byteOffset,buffer.byteLength/4);}
const checkFinite=arr=>{for(const v of arr)if(!Number.isFinite(v))fail('NONFINITE','non-finite streamed tensor');};

export function verifyTensorFile(file,rawSchema,{verifyFrozen=true}={}){
  const schema=normal(rawSchema),source=openTensor(file,schema);
  const frozen=new Map([...schema].filter(([,s])=>s.trainable===false));
  const hash=createHash('sha256');
  if(verifyFrozen)hash.update(header(frozen));
  try{
    for(const [key] of schema){
      const range=source.ranges.get(key);
      eachBlock(range,(offset,bytes)=>{
        const part=read(source.fd,{start:range.start+offset,bytes});
        checkFinite(values(part));
        if(verifyFrozen&&frozen.has(key))hash.update(part);
      });
    }
    return {frozen:verifyFrozen?hash.digest('hex'):null,sha256:hashFile(file)};
  }finally{source.close();}
}

export function createTensorFile(output,rawSchema,fill){
  const schema=normal(rawSchema),temp=path.join(path.dirname(output),'.'+randomUUID()+'.partial');
  let fd;
  try{
    fd=fs.openSync(temp,'wx',0o600);write(fd,header(schema));
    for(const [name,t] of schema)eachBlock({bytes:count(t.shape)*4},(offset,bytes)=>{
      const buffer=Buffer.alloc(bytes),block=values(buffer);
      fill(name,block,offset/4);checkFinite(block);write(fd,buffer);
    });
    fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    fs.linkSync(temp,output);
  }finally{if(fd!==undefined)fs.closeSync(fd);fs.rmSync(temp,{force:true});}
}

export function checkUpdateFile(base,file,rawSchema,maxNorm=1024){
  if(!Number.isFinite(maxNorm)||maxNorm<=0)fail('INVALID_SCHEMA','invalid update norm');
  const schema=normal(rawSchema),active=new Map([...schema].filter(([,t])=>t.trainable!==false));
  const prior=openTensor(base,schema);
  let next,norm=0;
  try{
    next=openTensor(file,active);
    for(const [key] of active){
      const a=prior.ranges.get(key),b=next.ranges.get(key);
      eachBlock(a,(offset,bytes)=>{
        const before=values(read(prior.fd,{start:a.start+offset,bytes})),after=values(read(next.fd,{start:b.start+offset,bytes}));
        checkFinite(before);checkFinite(after);
        for(let i=0;i<before.length;i++)norm+=(before[i]-after[i])**2;
        if(norm>maxNorm**2)fail('UPDATE_NORM_LIMIT','streamed update exceeds norm limit');
      });
    }
    return Math.sqrt(norm);
  }finally{next?.close();prior.close();}
}

// File-backed absolute-parameter FedAvg. IDs stabilize summation order and weights are
// supplied by the coordinator's verified supervised-token assignments.
export function aggregateTensorFiles({base,updates,output,schema:rawSchema,maxNorm=1024,minDevices=1}){
  if(!Array.isArray(updates)||!Number.isSafeInteger(minDevices)||minDevices<1||updates.length<minDevices||updates.length>16||!Number.isFinite(maxNorm)||maxNorm<=0)
    fail('INVALID_SCHEMA','invalid streamed reduction configuration');
  if(updates.some(u=>typeof u.id!=='string'||!u.id||typeof u.device!=='string'||!u.device||!Number.isSafeInteger(u.tokens)||u.tokens<=0)||
    new Set(updates.map(u=>u.id)).size!==updates.length||new Set(updates.map(u=>u.device)).size!==updates.length)
    fail('CONFLICT','duplicate or invalid streamed update');
  const total=updates.reduce((a,u)=>a+u.tokens,0);
  if(!Number.isSafeInteger(total))fail('INVALID_SCHEMA','token weight overflow');
  const schema=normal(rawSchema),active=new Map([...schema].filter(([,t])=>t.trainable!==false));
  if(!active.size)fail('INVALID_SCHEMA','missing trainable tensor');
  const reference=openTensor(base,schema),sources=[];
  let fd;
  const temp=path.join(path.dirname(output),'.'+randomUUID()+'.partial');
  try{
    for(const u of [...updates].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0))sources.push({...u,...openTensor(u.file,active),normSquared:0});
    fd=fs.openSync(temp,'wx',0o600);
    write(fd,header(schema));
    for(const [name] of schema){
      const orig=reference.ranges.get(name);
      eachBlock(orig,(offset,bytes)=>{
        const source=read(reference.fd,{start:orig.start+offset,bytes});
        const prior=values(source);
        checkFinite(prior);
        if(!active.has(name)){write(fd,source);return;}
        const sum=new Float64Array(prior.length);
        for(const update of sources){
          const loc=update.ranges.get(name);
          const incoming=values(read(update.fd,{start:loc.start+offset,bytes}));
          checkFinite(incoming);
          for(let i=0;i<sum.length;i++){
            update.normSquared+=(incoming[i]-prior[i])**2;
            sum[i]+=incoming[i]*update.tokens;
          }
          if(update.normSquared>maxNorm**2)fail('UPDATE_NORM_LIMIT','streamed update exceeds norm limit');
        }
        for(let i=0;i<prior.length;i++)prior[i]=sum[i]/total;
        write(fd,source);
      });
    }
    fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    const identity=verifyTensorFile(temp,rawSchema);
    fs.linkSync(temp,output);
    return {...identity,tokens:total,updates:sources.map(u=>u.id)};
  }finally{
    if(fd!==undefined)fs.closeSync(fd);
    reference.close();for(const u of sources)u.close();
    fs.rmSync(temp,{force:true});
  }
}
