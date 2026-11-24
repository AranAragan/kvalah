// v0.4 hygiene: a runtime service token was written to <cwd>/.config/kvalah/data/service.token (and committed on the
// local branch) because defaultDataDir() built a RELATIVE path when env had no HOME/USERPROFILE.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {defaultDataDir} from '../compute/lan.mjs';
test('v04 hygiene: default data dir is absolute even without HOME/USERPROFILE', ()=>{
  for(const pl of ['linux','darwin','win32'])assert.ok(path.isAbsolute(defaultDataDir({},pl)),pl+': '+defaultDataDir({},pl));
  assert.equal(defaultDataDir({KVALAH_DATA_DIR:'/x/y'}),'/x/y');
});
test('v04 hygiene: no runtime token/socket files are tracked by git', ()=>{
  let files;try{files=execFileSync('git',['ls-files'],{cwd:new URL('..',import.meta.url).pathname,encoding:'utf8'}).split('\n');}catch{return;}   // not a git checkout (zip)
  assert.deepEqual(files.filter(f=>/(^|\/)\.config\/|\.token$|\.sock$/.test(f)),[]);
});
