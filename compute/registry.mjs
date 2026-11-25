// Model registry helpers: pinned source revisions and optional provenance check against the Hugging Face
// API (explicit user action only; fixed allowlisted host; no redirects followed to other hosts).
import https from 'node:https';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
// Revisions observed through the Hugging Face API on 2026-11-26. They must be re-confirmed by the operator.
export const PINNED={
  'ministral3b-ffa-r8-v1':{
    'cuda-nf4':{source_repo:'mistralai/Ministral-3-3B-Instruct-2512-BF16',source_revision:'ef287ce8b4b5f858eaf679e9d6402265beb8624f',note:'BF16 source; quantized to NF4 at load time by bitsandbytes'},
    'mlx-4bit':{source_repo:'mlx-community/Ministral-3-3B-Instruct-2512-4bit',source_revision:'a962dcb09eee4169c890e544c9eb938f1113fdee',
      note:'community conversion; its model card lists base_model mistralai/Ministral-3-3B-Base-2512, so provenance relative to the Instruct BF16 source is UNVERIFIED. For a research pass convert the pinned BF16 revision yourself with mlx-vlm and register that digest.'}
  }
};
function getJSON(url){
  return new Promise((resolve,reject)=>{
    const u=new URL(url);if(u.hostname!=='huggingface.co'||u.protocol!=='https:')return reject(Error('only https://huggingface.co is allowed'));
    https.get(u,{headers:{'user-agent':'kvalah-compute/0.2'},timeout:20000},res=>{
      if(res.statusCode!==200){res.resume();return reject(Error('Hugging Face API returned HTTP '+res.statusCode));}
      const c=[];let n=0;res.on('data',d=>{n+=d.length;if(n>8e6)res.destroy(Error('response too large'));else c.push(d);});res.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(c)));}catch(e){reject(e);}});
    }).on('error',reject).on('timeout',function(){this.destroy(Error('timeout'));});
  });
}
const gitBlobSha1=file=>{const b=fs.readFileSync(file);return createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex');};
// Compare a verified local file list ({path,size,sha256}) with the published tree of repo@revision.
export async function verifyAgainstHub({repo,revision,files,modelDir}){
  if(!/^[\w.-]+\/[\w.-]+$/.test(repo)||!/^[0-9a-f]{40}$/.test(revision))throw Error('repo and a 40-hex revision are required');
  const tree=await getJSON(`https://huggingface.co/api/models/${repo}/tree/${revision}?recursive=true`);
  const remote=new Map(tree.filter(e=>e.type==='file').map(e=>[e.path,e]));
  const results=[];
  for(const f of files){
    const r=remote.get(f.path);
    if(!r){results.push({path:f.path,status:'not_in_revision'});continue;}
    if(r.lfs?.oid){results.push({path:f.path,status:r.lfs.oid===f.sha256&&r.lfs.size===f.size?'match':'mismatch'});continue;}
    const local=modelDir?gitBlobSha1(path.join(modelDir,f.path)):null;
    results.push({path:f.path,status:local&&local===r.oid?'match':'mismatch'});
  }
  const weights=results.filter(r=>/\.safetensors$/.test(r.path));
  return {repo,revision,results,verified:weights.length>0&&weights.every(r=>r.status==='match')&&results.every(r=>r.status!=='mismatch')};
}
