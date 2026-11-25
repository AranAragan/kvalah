// Minimal, bounded safetensors reader/writer for FP32 adapters (no pickle, no arbitrary dtypes).
// Header and every offset are validated before any tensor data is touched, so a hostile file cannot
// make us allocate or read outside its own byte range (spec §9.2, test M05).
import {fail} from './errors.mjs';
export const MAX_HEADER=1<<20;            // 1 MiB of JSON is far beyond 104 tensors
const LE=new Uint8Array(new Uint16Array([1]).buffer)[0]===1;
if(!LE)throw Error('Kvalah Compute requires a little-endian host');

export function parseHeader(buf,{maxBytes=Infinity}={}){
  if(!Buffer.isBuffer(buf))fail('INVALID_TENSOR','payload must be bytes');
  if(buf.length>maxBytes)fail('TOO_LARGE','payload exceeds '+maxBytes+' bytes');
  if(buf.length<8)fail('INVALID_TENSOR','payload shorter than the header length');
  const n=buf.readBigUInt64LE(0);
  if(n<2n||n>BigInt(MAX_HEADER)||Number(n)+8>buf.length)fail('INVALID_TENSOR','bad header length');
  let header;
  try{header=JSON.parse(buf.subarray(8,8+Number(n)).toString('utf8'));}catch{fail('INVALID_TENSOR','header is not JSON');}
  if(!header||typeof header!=='object'||Array.isArray(header))fail('INVALID_TENSOR','header must be an object');
  const base=8+Number(n),dataLen=buf.length-base,tensors={};
  const spans=[];
  for(const [name,info] of Object.entries(header)){
    if(name==='__metadata__'){
      if(!info||typeof info!=='object'||Object.values(info).some(v=>typeof v!=='string'))fail('INVALID_TENSOR','metadata must map strings to strings');
      continue;
    }
    if(!info||typeof info!=='object')fail('INVALID_TENSOR','bad tensor entry '+name);
    if(info.dtype!=='F32')fail('INVALID_TENSOR','tensor '+name+' must be F32, got '+info.dtype);
    const shape=info.shape,off=info.data_offsets;
    if(!Array.isArray(shape)||shape.length>4||shape.some(d=>!Number.isSafeInteger(d)||d<0))fail('INVALID_TENSOR','bad shape for '+name);
    if(!Array.isArray(off)||off.length!==2||!off.every(Number.isSafeInteger)||off[0]<0||off[1]<off[0]||off[1]>dataLen)fail('INVALID_TENSOR','bad offsets for '+name);
    const count=shape.reduce((a,b)=>a*b,1);
    if((off[1]-off[0])!==count*4)fail('INVALID_TENSOR','size/shape mismatch for '+name);
    tensors[name]={shape,start:base+off[0],end:base+off[1]};spans.push([off[0],off[1],name]);
  }
  spans.sort((a,b)=>a[0]-b[0]);
  let cursor=0;
  for(const [s,e,name] of spans){if(s!==cursor)fail('INVALID_TENSOR','overlapping or sparse data near '+name);cursor=e;}
  if(cursor!==dataLen)fail('INVALID_TENSOR','trailing bytes after tensor data');
  return {metadata:header.__metadata__||null,tensors};
}
// Returns {name:{shape,data:Float32Array}} — the data is a copy (aligned), never a view into the payload.
export function decode(buf,opts){
  const {metadata,tensors}=parseHeader(buf,opts),out={};
  for(const [name,t] of Object.entries(tensors)){
    const bytes=Buffer.from(buf.subarray(t.start,t.end));
    out[name]={shape:t.shape,data:new Float32Array(bytes.buffer,bytes.byteOffset,bytes.length/4)};
  }
  return {metadata,tensors:out};
}
// Canonical encoding: keys sorted, contiguous little-endian F32, header padded with spaces to 8 bytes
// (same layout the reference safetensors library writes), optional string metadata.
export function encode(tensors,metadata){
  const names=Object.keys(tensors).sort();
  const header={};let off=0;
  if(metadata)header.__metadata__=Object.fromEntries(Object.entries(metadata).map(([k,v])=>[k,String(v)]));
  for(const name of names){const t=tensors[name],len=t.data.length*4;header[name]={dtype:'F32',shape:t.shape,data_offsets:[off,off+len]};off+=len;}
  let json=JSON.stringify(header);const pad=(8-(json.length+8)%8)%8;json+=' '.repeat(pad);
  const head=Buffer.from(json,'utf8'),out=Buffer.alloc(8+head.length+off);
  out.writeBigUInt64LE(BigInt(head.length),0);head.copy(out,8);
  let p=8+head.length;
  for(const name of names){const d=tensors[name].data;Buffer.from(d.buffer,d.byteOffset,d.length*4).copy(out,p);p+=d.length*4;}
  return out;
}
