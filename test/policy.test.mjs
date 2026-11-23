import test from 'node:test';
import assert from 'node:assert/strict';
import {commandPolicy,isReadOnlyCommand,commandRule,matchesRule,prepareCommand} from '../command-policy.mjs';

test('ask mode keeps the original strict allowlist',()=>{
  assert.equal(commandPolicy('node --version').automatic,true);
  assert.equal(commandPolicy('git status').automatic,false);
  assert.equal(commandPolicy('git status').readOnly,true,'read-only commands do not need a plan');
});
test('auto mode runs read-only commands but not chained, redirected or outside-project ones',()=>{
  const auto=c=>commandPolicy(prepareCommand(c),{mode:'auto'}).automatic;
  for(const c of ['git status','git diff','git log -n 5','Get-ChildItem -Recurse','rg TODO src','Select-String -Path *.cs -Pattern Main','git branch -a'])assert.equal(auto(c),true,c);
  for(const c of ['npm test','git status; Remove-Item x','ls | Remove-Item','Get-Content C:\\Users\\x\\secret.txt','cat ../../etc/passwd','git diff --output=evil.txt','git branch -D main','rg x --pre calc.exe','Get-Content $env:USERPROFILE\\a','dir > out.txt','git -c core.pager=calc log','cmd /c del x'])assert.equal(auto(c),false,c);
  assert.equal(isReadOnlyCommand('Get-ChildItem `\nRemove-Item'),false);
});
test('full mode and project rules',()=>{
  assert.equal(commandPolicy('npm.cmd run build',{mode:'full'}).automatic,true);
  const rule=commandRule('npm test -- --watch');assert.equal(rule,'npm.cmd test --');
  assert.equal(commandRule('dotnet build -c Release'),'dotnet build -c');
  assert.equal(commandPolicy('npm.cmd test',{mode:'ask',rules:['npm.cmd test']}).automatic,true);
  assert.equal(matchesRule('npm.cmd test; calc','npm.cmd test'),false);
  assert.equal(matchesRule('npm.cmd testing','npm.cmd test'),false);
  assert.equal(commandPolicy('npm test & calc').suggestedRule,null);
});
