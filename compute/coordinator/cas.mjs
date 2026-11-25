// Content-addressed artifact store: path derived only from a validated sha256, atomic promote, no overwrite.
import fs from 'node:fs';
import path from 'node:path';
import {sha256,isHex64} from '../protocol/hash.mjs';
import {fail} from '../protocol/errors.mjs';
export function createCAS(root){
  fs.mkdirSync(path.join(root,'tmp'),{recursive:true});
  const file=h=>{if(!isHex64(h))fail('INVALID_SCHEMA','bad artifact hash');return path.join(root,h.slice(0,2),h);};
  return {
    root,file,
    has:h=>isHex64(h)&&fs.existsSync(file(h)),
    put(bytes){
      const h=sha256(bytes),dest=file(h);
      if(fs.existsSync(dest))return h;
      fs.mkdirSync(path.dirname(dest),{recursive:true});
      const tmp=path.join(root,'tmp',h+'.'+process.pid+'.'+Date.now());
      const fd=fs.openSync(tmp,'wx');try{fs.writeSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      if(sha256(fs.readFileSync(tmp))!==h){fs.rmSync(tmp,{force:true});fail('HASH_MISMATCH','artifact changed while writing');}
      try{fs.linkSync(tmp,dest);}catch(e){if(e.code!=='EEXIST')throw e;}
      fs.rmSync(tmp,{force:true});
      return h;
    },
    get(h){
      const f=file(h);if(!fs.existsSync(f))fail('NOT_FOUND','artifact not found');
      const b=fs.readFileSync(f);if(sha256(b)!==h)fail('HASH_MISMATCH','artifact '+h.slice(0,12)+' is corrupt');
      return b;
    }
  };
}
