// Prints the CHANGELOG.md section for a version (used as GitHub Release notes).
// Usage: node scripts/release-notes.mjs 0.7.0
import fs from 'node:fs';
const version=(process.argv[2]||JSON.parse(fs.readFileSync('package.json','utf8')).version).replace(/^v/,'');
const text=fs.readFileSync('CHANGELOG.md','utf8');
const start=text.indexOf(`## [${version}]`);
if(start<0){console.error(`CHANGELOG.md has no section for ${version}`);process.exit(1);}
const rest=text.slice(start).split('\n').slice(1);
const end=rest.findIndex(line=>/^## \[/.test(line));
const body=(end<0?rest:rest.slice(0,end)).join('\n').replace(/\n\[[^\]]+\]: .*$/gm,'').trim();
// SignPath Foundation asks for a "Code signing policy" link on every download/release page.
process.stdout.write(body+`\n\n---\n**Checksums:** \`SHA256SUMS.txt\` in the release assets · [Code signing policy](https://github.com/AranAragan/kvalah#code-signing-policy) · [Privacy policy](https://github.com/AranAragan/kvalah#privacy-policy)\n`);
