// SKILL-01 regression: Skill Lite without unsupported claims; limits, quoteVerified and fallbacks documented.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,stat} from 'node:fs/promises';
import {scanSecrets} from '../compute/secrets.mjs';
const dir=new URL('../skill/',import.meta.url);
const read=p=>readFile(new URL(p,dir),'utf8');

test('SKILL-01: no unsupported claims anywhere in the skill', async()=>{
  for(const f of ['SKILL.md','README.md','references/ADVANCED.md']){
    const t=await read(f);
    for(const re of [/instant and free/i,/results are exact/i,/any size works/i,/cheap and private/i,/\bexactly\b/i,/trust them without/i])assert.ok(!re.test(t),`${f}: forbidden claim ${re}`);
  }
});

test('SKILL-01: Skill Lite — short main file, advanced rules in references/', async()=>{
  const main=await read('SKILL.md');
  assert.match(main,/^---\nname: kvalah-offload\ndescription: .{40,1024}\n---\n/s);
  assert.ok(main.length<=3200,'SKILL.md is not "lite": '+main.length+' chars');
  assert.match(main,/references\/ADVANCED\.md/);
  const adv=await read('references/ADVANCED.md');assert.ok(adv.length>1500);
});

test('SKILL-01: limits, quoteVerified, coverage, retry-once fallback and the MCP dependency are documented', async()=>{
  const all=(await read('SKILL.md'))+(await read('references/ADVANCED.md'))+(await read('README.md'));
  for(const re of [/quoteVerified/,/not (a )?(proof|evidence) of correctness|does not mean the finding is correct/i,/sourceCoverage/,/KVALAH_WORKSPACE/,/tokenizer|estimated/i,/LAN/,/KVALAH_LAN_ALLOW/,
    /at most one retry|retry at most once/i,/paths/,/small (inputs|tasks)/i,/MCP server/i,/npx|npm/i,/Codex/,/Claude Code/,/Cursor/,/Agensi/,/not verified|unverified/i])
    assert.match(all,re,'missing: '+re);
});

test('SKILL-01: the skill folder ships text only, no secrets or binaries', async()=>{
  const walk=async d=>{const out=[];for(const e of await readdir(d,{withFileTypes:true})){const p=new URL(e.name+(e.isDirectory()?'/':''),d);if(e.isDirectory())out.push(...await walk(p));else out.push(p);}return out;};
  for(const f of await walk(dir)){
    assert.match(f.pathname,/\.(md|txt)$|LICENSE$/,'unexpected file type: '+f.pathname);
    const t=await readFile(f);assert.ok(!t.includes(0),'binary: '+f.pathname);
    assert.deepEqual(scanSecrets(t.toString('utf8')).filter(x=>x.type!=='sensitive-assignment'),[],'secret-like content: '+f.pathname);
    assert.ok((await stat(f)).size<20000);
  }
});
