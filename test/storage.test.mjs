import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {openStore} from '../storage.mjs';
import {tempDir} from './helpers.mjs';

test('migrates chats.json into per-chat files and coalesces writes',async()=>{
  const dir=await tempDir();
  await fs.writeFile(path.join(dir,'chats.json'),JSON.stringify([{id:'a1',title:'A',messages:[],updated:1},{id:'b2',title:'B',messages:[],updated:2}]));
  const store=await openStore(dir);
  assert.deepEqual(store.chats.map(c=>c.id),['b2','a1']);assert.equal(store.migrated,true);
  await fs.access(path.join(dir,'chats.json.migrated'));
  const chat=store.chats[0];
  const writes=[];for(let i=0;i<20;i++){chat.title='T'+i;writes.push(store.save(chat));}
  await Promise.all(writes);await store.flush();
  assert.equal(JSON.parse(await fs.readFile(path.join(dir,'chats','b2.json'),'utf8')).title,'T19');
  await store.remove('a1');await assert.rejects(fs.access(path.join(dir,'chats','a1.json')));
  const again=await openStore(dir);assert.deepEqual(again.chats.map(c=>c.id),['b2']);
  await assert.rejects(store.save({id:'../evil'}),/идентификатор/);
});
