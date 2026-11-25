// `node --check` for every source file that ships in the app (CI runs this before tests).
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const roots=['.','public','test','scripts','compute','compute/protocol','compute/coordinator','compute/worker','compute/governor','compute/datasets'];
const files=roots.flatMap(dir=>fs.readdirSync(dir).filter(f=>/\.(mjs|cjs|js)$/.test(f)).map(f=>path.join(dir,f)));
let failed=0;
for(const file of files){
  const r=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
  if(r.status!==0){failed++;process.stderr.write(file+'\n'+r.stderr);}
}
console.log(`node --check: ${files.length-failed}/${files.length} ok`);
process.exit(failed?1:0);
