// Minimal ZIP reader/writer (stored + deflate read, stored write) with traversal and size limits.
import zlib from 'node:zlib';
import {fail} from './protocol/errors.mjs';
export function normalizeEntry(name){
  const n=String(name).replace(/\\/g,'/');
  if(!n||n.startsWith('/')||/^[A-Za-z]:/.test(n)||n.split('/').some(p=>p==='..'))fail('INVALID_SCHEMA','unsafe path in archive: '+n.slice(0,80));
  return n;
}
export function readZip(buf,{maxEntries=1000,maxTotal=512*2**20,maxRatio=200}={}){
  let eocd=-1;for(let i=buf.length-22;i>=Math.max(0,buf.length-65557);i--)if(buf.readUInt32LE(i)===0x06054b50){eocd=i;break;}
  if(eocd<0)fail('INVALID_SCHEMA','not a zip archive');
  const count=buf.readUInt16LE(eocd+10),cdOff=buf.readUInt32LE(eocd+16);
  if(count>maxEntries)fail('TOO_LARGE','too many archive entries');
  const out=new Map();let p=cdOff,total=0;
  for(let i=0;i<count;i++){
    if(buf.readUInt32LE(p)!==0x02014b50)fail('INVALID_SCHEMA','bad central directory');
    const method=buf.readUInt16LE(p+10),csize=buf.readUInt32LE(p+20),usize=buf.readUInt32LE(p+24),nl=buf.readUInt16LE(p+28),el=buf.readUInt16LE(p+30),cl=buf.readUInt16LE(p+32),lho=buf.readUInt32LE(p+42);
    const name=buf.subarray(p+46,p+46+nl).toString('utf8');p+=46+nl+el+cl;
    if(name.endsWith('/')||name.endsWith('\\'))continue;
    const n=normalizeEntry(name);
    total+=usize;if(total>maxTotal)fail('TOO_LARGE','archive expands beyond the limit');
    if(csize>0&&usize/csize>maxRatio)fail('TOO_LARGE','suspicious compression ratio (zip bomb?)');
    const l=lho+30+buf.readUInt16LE(lho+26)+buf.readUInt16LE(lho+28),data=buf.subarray(l,l+csize);
    let bytes;
    if(method===0)bytes=Buffer.from(data);
    else if(method===8)bytes=zlib.inflateRawSync(data,{maxOutputLength:usize+1});
    else fail('INVALID_SCHEMA','unsupported compression method '+method);
    if(bytes.length!==usize)fail('INVALID_SCHEMA','size mismatch for '+n);
    if((zlib.crc32(bytes)>>>0)!==buf.readUInt32LE(p-46-nl-el-cl+16)>>>0)fail('HASH_MISMATCH','CRC mismatch for '+n);
    out.set(n,bytes);
  }
  return out;
}
export function writeZip(entries){
  const locals=[],central=[];let off=0;
  const dosTime=0,dosDate=(2026-1980)<<9|1<<5|1;
  for(const [name,data] of entries){
    const n=Buffer.from(normalizeEntry(name)),crc=zlib.crc32(data)>>>0;
    const h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50,0);h.writeUInt16LE(20,4);h.writeUInt16LE(0x0800,6);h.writeUInt16LE(0,8);h.writeUInt16LE(dosTime,10);h.writeUInt16LE(dosDate,12);
    h.writeUInt32LE(crc,14);h.writeUInt32LE(data.length,18);h.writeUInt32LE(data.length,22);h.writeUInt16LE(n.length,26);h.writeUInt16LE(0,28);
    locals.push(h,n,data);
    const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50,0);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x0800,8);c.writeUInt16LE(0,10);c.writeUInt16LE(dosTime,12);c.writeUInt16LE(dosDate,14);
    c.writeUInt32LE(crc,16);c.writeUInt32LE(data.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(n.length,28);c.writeUInt32LE(off,42);
    central.push(c,n);off+=30+n.length+data.length;
  }
  const cd=Buffer.concat(central),e=Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50,0);e.writeUInt16LE(entries.length,8);e.writeUInt16LE(entries.length,10);e.writeUInt32LE(cd.length,12);e.writeUInt32LE(off,16);
  return Buffer.concat([...locals,cd,e]);
}
