import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {LANGS} from '../i18n.mjs';
import {extractAttachment} from '../extract.mjs';

const ROOT=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url);
const pkg=JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'),'utf8'));

test('updater version comparison follows semver precedence',()=>{
  const {newerThan,parseVersion}=require('../updater.cjs');
  assert.equal(newerThan('0.7.1','0.7.0'),true);
  assert.equal(newerThan('v1.0.0','0.9.9'),true);
  assert.equal(newerThan('0.7.0','0.7.0'),false);
  assert.equal(newerThan('0.6.9','0.7.0'),false);
  assert.equal(newerThan('0.7.0','0.7.0-beta.1'),true);
  assert.equal(newerThan('0.7.0-beta.2','0.7.0'),false);
  assert.equal(newerThan('0.7.0-beta.10','0.7.0-beta.2'),true);
  assert.equal(newerThan('garbage','0.7.0'),false);
  assert.deepEqual(parseVersion('v0.7.0'),{nums:[0,7,0],pre:''});
});

test('packaging config is consistent with the app and the release channels',()=>{
  const config=require('../electron-builder.cjs');
  assert.equal(config.appId,'kvalah.Desktop');
  assert.match(fs.readFileSync(path.join(ROOT,'desktop.cjs'),'utf8'),/APP_ID='kvalah\.Desktop'/,'AppUserModelID matches appId');
  assert.equal(config.productName,'kvalah');
  assert.equal(config.nsis.perMachine,false,'per-user install in %LOCALAPPDATA%\\Programs\\kvalah');
  assert.deepEqual(config.publish[0],{provider:'github',owner:'AranAragan',repo:'kvalah',releaseType:'release'});
  const updater=fs.readFileSync(path.join(ROOT,'updater.cjs'),'utf8');
  assert.match(updater,/OWNER='AranAragan',REPO='kvalah'/);
  // Every UI language keeps its Chromium pack (Windows/Linux names).
  const chromium={ru:'ru',en:'en-US',uk:'uk',de:'de',fr:'fr',es:'es','pt-BR':'pt-BR','zh-CN':'zh-CN',tr:'tr',ja:'ja'};
  for(const lang of LANGS)assert.ok(config.electronLanguages.includes(chromium[lang]),lang);
  assert.ok(fs.existsSync(path.join(ROOT,config.nsis.include)));
  // Package manager manifests point at this version's release assets.
  const scoop=JSON.parse(fs.readFileSync(path.join(ROOT,'bucket/kvalah.json'),'utf8'));
  assert.equal(scoop.version,pkg.version);
  assert.ok(scoop.architecture['64bit'].url.includes(`/v${pkg.version}/kvalah-${pkg.version}-win-x64-portable.zip`));
  const dir=path.join(ROOT,'packaging/winget/manifests/a/AranAragan/Kvalah',pkg.version);
  const installer=fs.readFileSync(path.join(dir,'AranAragan.Kvalah.installer.yaml'),'utf8');
  assert.match(installer,new RegExp(`PackageVersion: ${pkg.version.replace(/\./g,'\\.')}`));
  assert.ok(installer.includes(`/v${pkg.version}/kvalah-${pkg.version}-win-x64-setup.exe`));
  assert.match(installer,/InstallerType: nullsoft/);
  const changelog=fs.readFileSync(path.join(ROOT,'CHANGELOG.md'),'utf8');
  assert.ok(changelog.includes(`## [${pkg.version}]`),'CHANGELOG has an entry for this version');
});

test('PDF text extraction works with pdfjs-dist from npm',async()=>{
  const stream='BT /F1 12 Tf 20 100 Td (Hello kvalah PDF) Tj ET';
  const objs=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf='%PDF-1.4\n';const offsets=[];
  objs.forEach((o,i)=>{offsets.push(pdf.length);pdf+=`${i+1} 0 obj\n${o}\nendobj\n`;});
  const xref=pdf.length;
  pdf+=`xref\n0 ${objs.length+1}\n0000000000 65535 f \n`+offsets.map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${objs.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const text=await extractAttachment('sample.pdf','application/pdf',Buffer.from(pdf,'latin1'));
  assert.match(text,/Hello kvalah PDF/);
});
