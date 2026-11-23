// Recomputes sha512/size in electron-updater feeds (latest*.yml) after artifacts were changed
// post-build, e.g. signed by SignPath. Usage: node scripts/refresh-latest-yml.mjs release
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const yaml=createRequire(import.meta.url)('js-yaml');
const dir=path.resolve(process.argv[2]||'release');
const sha512=file=>crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
let changed=0;
for(const name of fs.readdirSync(dir).filter(f=>/^latest.*\.yml$/.test(f))){
  const feedPath=path.join(dir,name),feed=yaml.load(fs.readFileSync(feedPath,'utf8'));
  for(const entry of feed.files||[]){
    const file=path.join(dir,entry.url);
    if(!fs.existsSync(file)){console.warn(`${name}: ${entry.url} not found, left as is`);continue;}
    const hash=sha512(file),size=fs.statSync(file).size;
    if(hash!==entry.sha512){entry.sha512=hash;entry.size=size;delete entry.blockMapSize;changed++;}
    if(feed.path===entry.url)feed.sha512=hash;
  }
  fs.writeFileSync(feedPath,yaml.dump(feed,{lineWidth:-1}));
  console.log(`${name}: ok`);
}
console.log(`updated entries: ${changed}`);
