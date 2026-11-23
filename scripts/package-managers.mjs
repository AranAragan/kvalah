// Writes winget manifests and the Scoop manifest for a release.
// Usage:
//   node scripts/package-managers.mjs --version 0.7.0 [--sums dist/SHA256SUMS.txt] [--date 2026-11-23]
// Without --sums the hashes stay zero placeholders (to prepare manifests before a release exists).
import fs from 'node:fs';
import path from 'node:path';
const arg=name=>{const i=process.argv.indexOf('--'+name);return i>0?process.argv[i+1]:undefined;};
const version=(arg('version')||JSON.parse(fs.readFileSync('package.json','utf8')).version).replace(/^v/,'');
const date=arg('date')||new Date().toISOString().slice(0,10);
const ZERO='0'.repeat(64);
const setup=`kvalah-${version}-win-x64-setup.exe`,portable=`kvalah-${version}-win-x64-portable.zip`;
const base=`https://github.com/AranAragan/kvalah/releases/download/v${version}/`;
const sums={};
if(arg('sums'))for(const line of fs.readFileSync(arg('sums'),'utf8').split('\n')){const m=line.match(/^([0-9a-f]{64})\s+\*?(.+)$/i);if(m)sums[m[2].trim()]=m[1].toUpperCase();}
if(arg('sums')&&(!sums[setup]||!sums[portable]))throw Error(`SHA256SUMS lacks ${setup} or ${portable}`);

// winget: copy the newest existing version folder as a template.
const root='packaging/winget/manifests/a/AranAragan/Kvalah';
const cmp=(a,b)=>a.split('.').map(Number).reduce((r,n,i)=>r||n-(b.split('.').map(Number)[i]||0),0);
const versions=fs.readdirSync(root).filter(v=>/^\d+\.\d+\.\d+$/.test(v)).sort(cmp);
const template=path.join(root,versions.at(-1)),target=path.join(root,version);
fs.mkdirSync(target,{recursive:true});
for(const file of fs.readdirSync(template)){
  let text=fs.readFileSync(path.join(template,file),'utf8');
  text=text.replace(/^PackageVersion: .*$/m,`PackageVersion: ${version}`)
    .replace(/^ReleaseDate: .*$/m,`ReleaseDate: ${date}`)
    .replace(/(InstallerUrl: ).*$/m,`$1${base}${setup}`)
    .replace(/(InstallerSha256: ).*$/m,`$1${sums[setup]||"'"+ZERO+"'"}`)
    .replace(/(ReleaseNotesUrl: ).*$/m,`$1https://github.com/AranAragan/kvalah/releases/tag/v${version}`);
  fs.writeFileSync(path.join(target,file),text);
}
console.log('winget:',target);

// Scoop (this repository is also a bucket: scoop bucket add kvalah https://github.com/AranAragan/kvalah).
const scoopPath='bucket/kvalah.json',scoop=JSON.parse(fs.readFileSync(scoopPath,'utf8'));
scoop.version=version;
scoop.architecture['64bit'].url=base+portable;
scoop.architecture['64bit'].hash=(sums[portable]||ZERO).toLowerCase();
fs.writeFileSync(scoopPath,JSON.stringify(scoop,null,4)+'\n');
console.log('scoop:',scoopPath);
