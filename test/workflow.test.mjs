import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {taskFor,editFile,writeFile,appendFile,applyPatch,undoChange,sourceSnapshot,hash} from '../workflow.mjs';
import {parsePatch} from '../patch.mjs';
import {tempDir} from './helpers.mjs';

async function setup(){
  const root=await tempDir(),data=path.join(root,'.data');await fs.mkdir(data);
  const project=path.join(root,'p');await fs.mkdir(project);
  const chat={project:{path:project,existing:true},workflow:null};taskFor(chat,'goal');chat.workflow.inspection={};chat.workflow.steps=[{title:'s'}];
  return {root,data,project,chat};
}
test('contract is no longer frozen on the first message',()=>{
  const chat={};taskFor(chat,'посчитай');assert.equal(chat.workflow.contract.exe,false);
  taskFor(chat,'собери exe для windows');assert.equal(chat.workflow.contract.exe,true,'unfinished task widens contract');
  chat.workflow.phase='completed';taskFor(chat,'теперь просто поправь README');
  assert.equal(chat.workflow.contract.exe,false);assert.equal(chat.workflow.goal,'теперь просто поправь README');assert.equal(chat.workflow.history.length,1);
});
test('edit_file keeps CRLF and BOM, refuses non-UTF-8 files',async()=>{
  const {data,project,chat}=await setup();const f=path.join(project,'a.cs');
  await fs.writeFile(f,Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from('class A\r\n{\r\n    int x = 1;\r\n}\r\n')]));
  const r=await editFile(chat,f,{old_text:'int x = 1;',new_text:'int x = 2;'},data,project);
  assert.match(r.diff,/^\+    int x = 2;$/m);
  const bytes=await fs.readFile(f);assert.deepEqual([...bytes.subarray(0,3)],[0xef,0xbb,0xbf]);assert.equal(bytes.subarray(3).toString(),'class A\r\n{\r\n    int x = 2;\r\n}\r\n');
  const legacy=path.join(project,'old.txt');await fs.writeFile(legacy,Buffer.from([0xcf,0xf0,0xe8,0xe2,0xe5,0xf2]));
  await assert.rejects(editFile(chat,legacy,{old_text:'a',new_text:'b'},data,project),/not valid UTF-8/);
});
test('write_file requires a full read hash; append_file builds files in parts',async()=>{
  const {data,project,chat}=await setup();const f=path.join(project,'b.txt');
  await appendFile(chat,f,'part1',data,project);await appendFile(chat,f,'part2\n',data,project);
  assert.equal(await fs.readFile(f,'utf8'),'part1\npart2\n');
  await assert.rejects(writeFile(chat,f,'new',data,undefined,project),/Read the full file/);
  await writeFile(chat,f,'new\n',data,hash(await fs.readFile(f)),project);assert.equal(await fs.readFile(f,'utf8'),'new\n');
});
test('apply_patch is validated before writing and every file can be undone',async()=>{
  const {data,project,chat}=await setup();
  await fs.writeFile(path.join(project,'a.js'),'one\ntwo\n');await fs.writeFile(path.join(project,'gone.js'),'bye\n');
  const abs=ops=>ops.map(o=>({...o,path:path.join(project,o.path),moveTo:o.moveTo&&path.join(project,o.moveTo)}));
  const bad=abs(parsePatch('*** Begin Patch\n*** Add File: new.js\n+x\n*** Update File: a.js\n@@\n-missing\n+y\n*** End Patch'));
  await assert.rejects(applyPatch(chat,bad,data,project),/did not match/);
  await assert.rejects(fs.access(path.join(project,'new.js')),'nothing written when a later hunk fails');
  const good=abs(parsePatch('*** Begin Patch\n*** Add File: new.js\n+x\n*** Update File: a.js\n@@\n one\n-two\n+TWO\n*** Delete File: gone.js\n*** End Patch'));
  const r=await applyPatch(chat,good,data,project);assert.equal(r.applied,3);
  assert.equal(await fs.readFile(path.join(project,'a.js'),'utf8'),'one\nTWO\n');await assert.rejects(fs.access(path.join(project,'gone.js')));
  const del=chat.workflow.changes.find(c=>c.deleted);await undoChange(chat,del.id,data);
  assert.equal(await fs.readFile(path.join(project,'gone.js'),'utf8'),'bye\n');
});
test('source fingerprint honours .gitignore and heavy folders',async()=>{
  const {project}=await setup();
  await fs.writeFile(path.join(project,'main.py'),'print(1)\n');await fs.writeFile(path.join(project,'.gitignore'),'*.log\ncache/\n');
  const before=await sourceSnapshot(project);
  await fs.mkdir(path.join(project,'.venv','lib'),{recursive:true});await fs.writeFile(path.join(project,'.venv','lib','x.py'),'x');
  await fs.mkdir(path.join(project,'cache'));await fs.writeFile(path.join(project,'cache','c.bin'),'x');await fs.writeFile(path.join(project,'run.log'),'x');
  await fs.mkdir(path.join(project,'obj'));await fs.writeFile(path.join(project,'obj','a.cs'),'x');
  assert.equal(await sourceSnapshot(project),before);
  await fs.writeFile(path.join(project,'main.py'),'print(2)\n');assert.notEqual(await sourceSnapshot(project),before);
});
