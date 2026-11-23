import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {walkFiles,searchCode,findFiles,outline,parseIgnore,ignored} from '../search.mjs';
import {tempDir} from './helpers.mjs';

test('gitignore rules: anchors, directories, negation, nesting',async()=>{
  const rules=parseIgnore('*.log\n!keep.log\n/build\ndocs/**/*.tmp\nlogs/\n');
  assert.equal(ignored(rules,'a.log',false),true);assert.equal(ignored(rules,'keep.log',false),false);
  assert.equal(ignored(rules,'build',true),true);assert.equal(ignored(rules,'src/build',true),false);
  assert.equal(ignored(rules,'docs/a/b/x.tmp',false),true);assert.equal(ignored(rules,'logs',true),true);assert.equal(ignored(rules,'logs',false),false);
  const root=await tempDir();
  await fs.mkdir(path.join(root,'src/node_modules/x'),{recursive:true});await fs.mkdir(path.join(root,'sub'),{recursive:true});
  await fs.writeFile(path.join(root,'src/a.ts'),'export function alpha(){}\n');await fs.writeFile(path.join(root,'src/node_modules/x/i.js'),'alpha');
  await fs.writeFile(path.join(root,'sub/.gitignore'),'secret.txt\n');await fs.writeFile(path.join(root,'sub/secret.txt'),'alpha');await fs.writeFile(path.join(root,'sub/ok.md'),'# Alpha title\n');
  const files=(await walkFiles(root)).files.map(f=>f.path);
  assert.deepEqual(files.sort(),['src/a.ts','sub/.gitignore','sub/ok.md']);
  for(const useRipgrep of [true,false]){
    const r=await searchCode(root,{pattern:'alpha',useRipgrep});
    assert.deepEqual(r.matches.map(m=>m.path).sort(),['src/a.ts','sub/ok.md'],r.engine);
  }
  assert.deepEqual((await findFiles(root,{pattern:'*.ts'})).files,['src/a.ts']);
  assert.deepEqual((await findFiles(root,{pattern:'src/**/*.{ts,js}'})).files,['src/a.ts']);
  const regex=await searchCode(root,{pattern:'function\\s+al',regex:true,useRipgrep:false});assert.equal(regex.matches[0].line,1);
});
test('outline finds symbols in several languages',()=>{
  assert.deepEqual(outline('a.py','class A:\n    def run(self):\n        pass\nasync def main():\n').symbols.map(s=>s.name),['A','run','main']);
  assert.deepEqual(outline('a.cs','public class Program\n{\n    public static void Main(string[] args)\n    {\n').symbols.map(s=>s.name),['Program','Main']);
  assert.deepEqual(outline('a.go','func (s *S) Do() {}\ntype S struct{}\n').symbols.map(s=>s.name),['Do','S']);
  assert.equal(outline('a.bin','x').supported,false);
});
