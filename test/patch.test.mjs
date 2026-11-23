import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeText,encodeText,replaceFragment,unifiedDiff,parsePatch,applyHunks} from '../patch.mjs';

test('decode/encode preserves BOM and CRLF',()=>{
  const raw=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from('a\r\nb\r\n')]);
  const info=decodeText(raw);assert.equal(info.text,'a\nb\n');assert.equal(info.bom,true);assert.equal(info.eol,'\r\n');assert.equal(info.utf8,true);
  assert.ok(encodeText(info.text,info).equals(raw));
  assert.equal(decodeText(Buffer.from([0xcf,0xf0,0xe8])).utf8,false,'cp1251 bytes are detected');
});
test('replaceFragment tolerates line endings, trailing spaces and indentation',()=>{
  assert.equal(replaceFragment('a\nb  \nc\n','b\nc','B\nC').content,'a\nB\nC\n');
  const r=replaceFragment('class A {\n    run() {\n        go();\n    }\n}\n','run() {\n    go();\n}','run() {\n    stop();\n}');
  assert.equal(r.strategy,'indent');assert.equal(r.content,'class A {\n    run() {\n        stop();\n    }\n}\n');
  assert.throws(()=>replaceFragment('x\nx\n','x','y'),/found 2/);
  assert.equal(replaceFragment('x\nx\n','x','y',true).content,'y\ny\n');
  assert.throws(()=>replaceFragment('alpha\nbeta\n','gamma','z'),/not found/);
});
test('unifiedDiff produces separate hunks with context',()=>{
  const a=Array.from({length:30},(_,i)=>'l'+i).join('\n'),b=a.replace('l2\n','L2\n').replace('l25','L25');
  const d=unifiedDiff(a,b,'f.txt');
  assert.equal((d.match(/^@@/gm)||[]).length,2);assert.match(d,/^-l2$/m);assert.match(d,/^\+L25$/m);
  assert.match(unifiedDiff(null,'x','n'),/^--- \/dev\/null/);assert.equal(unifiedDiff('same','same'),'');
});
test('Codex-style patch: update, add, delete, move',()=>{
  const ops=parsePatch('*** Begin Patch\n*** Update File: src/a.js\n@@ function f\n-  return 1;\n+  return 2;\n*** Add File: b.txt\n+hi\n*** Delete File: c.txt\n*** Update File: d.js\n*** Move to: e.js\n@@\n-x\n+y\n*** End Patch');
  assert.deepEqual(ops.map(o=>o.type),['update','add','delete','update']);assert.equal(ops[3].moveTo,'e.js');
  assert.equal(applyHunks('function f(){\n  return 1;\n}\nfunction g(){\n  return 1;\n}',ops[0].hunks),'function f(){\n  return 2;\n}\nfunction g(){\n  return 1;\n}');
  assert.deepEqual(ops[1].lines,['hi']);
});
test('unified git diff is accepted and mismatches are reported',()=>{
  const ops=parsePatch('diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@ -1,3 +1,3 @@\n def f():\n-    return 1\n+    return 2\n');
  assert.equal(applyHunks('def f():\n    return 1\n',ops[0].hunks),'def f():\n    return 2\n');
  assert.throws(()=>applyHunks('other\n',ops[0].hunks,'x.py'),/hunk 1 did not match/);
  assert.throws(()=>parsePatch('just text'),/not recognized/);
});
