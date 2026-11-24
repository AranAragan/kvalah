// Read-only, root-scoped file access with TOCTOU-safe opening.
// Open first (O_NOFOLLOW|O_NONBLOCK), then validate the *opened descriptor*: its real path (Linux
// /proc/self/fd, else realpath + dev/ino match) must be inside the workspace and it must be a regular file.
// A path swapped for a symlink between check and use can therefore not leak data outside the root.
import {realpath,stat,lstat,open,readlink} from 'node:fs/promises';
import {constants,existsSync} from 'node:fs';
import path from 'node:path';

// v0.3 (SEC-02): every rule is case-insensitive (case-insensitive file systems on Windows/macOS: .GIT == .git)
const DENY=[/(^|\/)\.env(\.|$)/i,/(^|\/)\.git(\/|$)/i,/(^|\/)node_modules(\/|$)/i,/(^|\/)\.ssh(\/|$)/i,/(^|\/)\.aws(\/|$)/i,/(^|\/)\.gnupg(\/|$)/i,
  /\.(pem|key|p12|pfx|keystore|jks|kdbx|der|crt)$/i,/(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,/(^|\/)\.(npmrc|pypirc|netrc|git-credentials|docker\/config\.json)$/i];
const DENY_NAME=/secret|credential|passw(or)?d|\.kdbx$/i;
export const isDenied=rel=>{const r=rel.split(path.sep).join('/').replace(/\\/g,'/');return DENY.some(x=>x.test(r))||DENY_NAME.test(path.posix.basename(r));};
// Lexical checks before touching the file system. On Windows: UNC/device namespaces, alternate data streams,
// drive-relative/absolute paths and reserved device names are refused (default-deny for mechanisms we cannot verify).
const WIN_RESERVED=/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;
export function lexicalCheck(p,platform=process.platform){
  if(typeof p!=='string'||!p||p.includes('\0')||p.length>4096)throw Error('Invalid path');
  if(platform==='win32'){
    if(/^[\\/]{2}/.test(p))throw Error('UNC/device path rejected: '+p);
    if(/^[a-z]:/i.test(p))throw Error('Drive path rejected (paths must be relative to the workspace): '+p);
    if(p.includes(':'))throw Error('Alternate data stream path rejected: '+p);
    if(p.split(/[\\/]/).some(seg=>WIN_RESERVED.test(seg)||/[. ]$/.test(seg)&&seg!=='.'&&seg!=='..'))throw Error('Reserved/ambiguous Windows name rejected: '+p);
  }
  return p;
}
const PROC=process.platform==='linux'&&existsSync('/proc/self/fd');
const FLAGS=constants.O_RDONLY|(constants.O_NOFOLLOW||0)|(constants.O_NONBLOCK||0);

// Read at most `limit` bytes starting at `pos` in bounded blocks: loops over partial reads, checks the
// signal between blocks and detects a file that changed (size/mtime) while it was being read.
const BLOCK=64*1024;
async function readBounded(fh,st,{pos=0,limit,signal}={}){
  const buf=Buffer.alloc(limit);let off=0;
  while(off<limit){
    signal?.throwIfAborted();
    const {bytesRead}=await fh.read(buf,off,Math.min(BLOCK,limit-off),pos+off);
    if(!bytesRead)break;off+=bytesRead;
  }
  const after=await fh.stat();
  const changed=after.size!==st.size||after.mtimeMs!==st.mtimeMs;
  return {data:buf.subarray(0,off),changed};
}
const LINECOUNT_CAP=64*1024*1024;
async function countNewlines(fh,end,signal){
  const buf=Buffer.alloc(BLOCK);let n=0,off=0;
  while(off<end){signal?.throwIfAborted();const {bytesRead}=await fh.read(buf,0,Math.min(BLOCK,end-off),off);if(!bytesRead)break;
    for(let i=0;i<bytesRead;i++)if(buf[i]===10)n++;off+=bytesRead;}
  return n;
}
export function createFileReader({root,maxFiles=32,maxBytesPerFile=2_000_000,maxTotalBytes=8_000_000,allowHardlinks=false}={}){
  if(!root)return null;
  let rootReal;
  const inside=p=>{const rel=path.relative(rootReal,p);return rel===''||(!rel.startsWith('..')&&!path.isAbsolute(rel));};
  async function openSafe(p){
    rootReal??=await realpath(root);
    lexicalCheck(p);
    const abs=path.resolve(rootReal,p);
    if(!inside(abs))throw Error('Path outside workspace: '+p);
    if(isDenied(path.relative(rootReal,abs)))throw Error('Path denied by secret/VCS filter: '+p); // lexical deny before open
    if(!constants.O_NOFOLLOW){ // no O_NOFOLLOW (Windows): refuse a final-component symlink/junction explicitly
      const l=await lstat(abs).catch(()=>null);if(l?.isSymbolicLink())throw Error('Symlinked file rejected: '+p);}
    let fh;
    try{fh=await open(abs,FLAGS);}
    catch(e){if(e.code==='ELOOP'||e.code==='EMLINK')throw Error('Symlinked file rejected: '+p);if(e.code==='ENOENT')throw Error('File not found: '+p);throw Error(`Cannot open ${p}: ${e.code||e.message}`);}
    try{
      const st=await fh.stat();
      if(!st.isFile())throw Error('Not a regular file: '+p);
      let real;
      if(PROC){real=await readlink(`/proc/self/fd/${fh.fd}`);}
      else{real=await realpath(abs);const s2=await stat(real);if(s2.ino!==st.ino||s2.dev!==st.dev)throw Error('File changed while opening (race): '+p);}
      if(!inside(real))throw Error('Path outside workspace (resolved): '+p);
      if(st.nlink>1&&!allowHardlinks)throw Error('Hard-linked file rejected (could alias a file outside the workspace): '+p);
      const rel=path.relative(rootReal,real);
      if(isDenied(rel))throw Error('Path denied by secret/VCS filter: '+p);
      return {fh,st,rel:rel.split(path.sep).join('/')};
    }catch(e){await fh.close();throw e;}
  }
  return {
    root,
    get rootReal(){return rootReal;},
    async resolveRoot(){return rootReal??=await realpath(root);},
    async read(paths,{tailBytes,signal}={}){
      if(!Array.isArray(paths)||!paths.length||paths.length>maxFiles)throw Error(`Expected 1–${maxFiles} paths`);
      const out=[];let total=0;
      for(const p of paths){
        const {fh,st,rel}=await openSafe(p);
        try{
          const want=tailBytes?Math.min(st.size,tailBytes):st.size;
          if(want>maxBytesPerFile)throw Error(`${p} is ${st.size} bytes (> ${maxBytesPerFile} per file). Use tailBytes or kvalah_compute search to narrow it.`);
          if(total+want>maxTotalBytes)throw Error(`Total input would exceed ${maxTotalBytes} bytes; pass fewer paths`);
          let pos=st.size-want;
          let {data,changed}=await readBounded(fh,st,{pos,limit:want,signal});
          if(changed&&!tailBytes)throw Error(`File changed while reading: ${p}; retry`);
          if(data.includes(0))throw Error('Binary file rejected: '+p);
          // v0.3 (CTX-02): a tail starts at the next line boundary (never inside a UTF-8 sequence or a line) and
          // knows its absolute position: byteOffset and the number of lines before it (null if the prefix is too big to count)
          let lineOffset=0;
          if(pos>0){
            const nl=data.indexOf(10);
            if(nl>=0&&nl<data.length-1){data=data.subarray(nl+1);pos+=nl+1;}
            lineOffset=pos<=LINECOUNT_CAP?await countNewlines(fh,pos,signal):null;
          }
          const bytesRead=data.length;total+=bytesRead;
          out.push({path:rel,bytes:bytesRead,truncated:bytesRead<st.size,source:'file',text:data.toString('utf8'),sourceBytes:st.size,byteOffset:pos,lineOffset});
        }finally{await fh.close();}
      }
      return out;
    },
    // sizes without reading content (router planning)
    async sizes(paths,{signal}={}){if(!Array.isArray(paths)||paths.length>maxFiles)throw Error(`Expected at most ${maxFiles} paths`);const out=[];for(const p of paths){signal?.throwIfAborted();const {fh,st,rel}=await openSafe(p);await fh.close();out.push({path:rel,bytes:st.size});}return out;},
    // single-file text read for deterministic ops (same safety checks)
    async readText(p,{maxBytes=maxBytesPerFile,signal}={}){
      const {fh,st,rel}=await openSafe(p);
      try{
        if(st.size>maxBytes)return {path:rel,skipped:'too-large',size:st.size};
        const {data,changed}=await readBounded(fh,st,{limit:st.size,signal}); // never more than the checked size
        if(changed)return {path:rel,skipped:'changed',size:st.size};
        if(data.includes(0))return {path:rel,skipped:'binary',size:st.size};
        return {path:rel,text:data.toString('utf8'),size:data.length,mtimeMs:st.mtimeMs};
      }finally{await fh.close();}
    }
  };
}
