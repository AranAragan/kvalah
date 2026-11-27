import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeZip} from '../../compute/zip.mjs';
import {sha256} from '../../compute/protocol/hash.mjs';

const output=process.argv[2];
if(!output)throw Error('Usage: node scripts/compute-v03/audit-archive.mjs output.zip');
const root=fileURLToPath(new URL('../../',import.meta.url));
const doc=path.join(root,'docs','compute','v0.3'),scripts=path.join(root,'scripts','compute-v03');
const data=path.join(doc,'measurements');
const entries=[['CHANGELOG.md',fs.readFileSync(path.join(root,'CHANGELOG.md'))]];
for(const [dir,name,types] of [[doc,'reports',/\.(?:md|json)$/],[scripts,'scripts',/\.(?:mjs|py)$/],[data,'measurements',/\.(?:json|jsonl|csv|png)$/]]){
  if(!fs.existsSync(dir))continue;
  for(const file of fs.readdirSync(dir,{withFileTypes:true})){
    if(file.isFile()&&/^[\w.-]+$/.test(file.name)&&types.test(file.name))
      entries.push([name+'/'+file.name,fs.readFileSync(path.join(dir,file.name))]);
  }
}
entries.push(['SHA256SUMS',Buffer.from(entries.map(([n,b])=>sha256(b)+'  '+n).join('\n')+'\n')]);
const zip=writeZip(entries);
if(zip.length>30e6)throw Error('Audit ZIP exceeds 30 MB');
fs.mkdirSync(path.dirname(output),{recursive:true});
fs.writeFileSync(output,zip,{flag:'wx'});
console.log(JSON.stringify({files:entries.length,bytes:zip.length,sha256:sha256(zip)}));
