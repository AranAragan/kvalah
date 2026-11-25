// Kvalah Compute v0.2 — Resource Governor (spec §10, R02/R04/R05 logic level). Real sensors and real GPU
// duty-cycle measurements are hardware tests (docs/compute/HW-TEST.md) and are NOT claimed here.
import {tmp} from './compute-helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createGovernor} from '../compute/governor/governor.mjs';
import {validatePolicy,DEFAULT_POLICY,nominalMonthlyHours} from '../compute/governor/policy.mjs';
import {parseNvidiaLine,parseNotificationState} from '../compute/governor/sensors.mjs';
const OK={on_battery:false,idle_s:3600,game:false,fullscreen:false,ram_free_bytes:8*2**30};
function gov(o={}){let t=Date.parse('2026-11-26T10:00:00+03:00'),m=0;const g=createGovernor({stateDir:o.dir||tmp('kc-gov-'),now:()=>t,mono:()=>m,...o});g.setEnabled(true);g.setSensors(OK);return {g,adv:ms=>{t+=ms;m+=ms;},set:ms=>{t=ms;}};}
test('defaults are gentle: 10% GPU/CPU, 4 h/day, idle only, mains only, pause for games and local AI; nothing in background',()=>{
  assert.equal(DEFAULT_POLICY.gpu_target_pct,10);assert.equal(DEFAULT_POLICY.daily_hours,4);assert.ok(DEFAULT_POLICY.only_idle&&DEFAULT_POLICY.only_ac&&DEFAULT_POLICY.pause_on_games&&DEFAULT_POLICY.pause_on_local_ai);
  assert.equal(validatePolicy({background_after_close:true}).background_after_close,false);
  assert.equal(nominalMonthlyHours(DEFAULT_POLICY),12);
  assert.throws(()=>validatePolicy({gpu_target_pct:12}),/steps of 5/);
  assert.throws(()=>validatePolicy({gpu_target_pct:80}),/full/);assert.equal(validatePolicy({gpu_target_pct:80,profile:'full'}).gpu_target_pct,80);
  assert.throws(()=>validatePolicy({daily_hours:16}),/between/);assert.equal(validatePolicy({daily_hours:16,extended_hours:true,profile:'full'}).daily_hours,16);
});
test('decision priority: disabled → manual → temperature → power → broker → budget → idle → games',()=>{
  const {g}=gov();
  assert.equal(g.decide().run,true);
  g.setSensors({game:true});assert.equal(g.decide().reason,'game');
  g.setSensors({idle_s:10});assert.equal(g.decide().reason,'user_active');
  g.setBroker('chat-1',true);assert.equal(g.decide().reason,'local_ai');
  g.setSensors({on_battery:true});assert.equal(g.decide().reason,'on_battery');
  g.setSensors({gpu:{temperature_c:85}});assert.equal(g.decide().reason,'temperature');
  g.setManualPause(true);assert.equal(g.decide().reason,'manual_pause');
  g.setEnabled(false);assert.equal(g.decide().reason,'disabled');
});
test('missing sensors fail closed with an explanation instead of guessing',()=>{
  const {g}=gov();g.setSensors({on_battery:null,idle_s:null,game:null});
  assert.equal(g.decide().reason,'sensor_unavailable_power');
  g.setPolicy({only_ac:false});assert.equal(g.decide().reason,'sensor_unavailable_idle');
  g.setPolicy({only_idle:false});assert.equal(g.decide().reason,'sensor_unavailable_game');
  g.setPolicy({pause_on_games:false});assert.equal(g.decide().run,true);
});
test('temperature hysteresis: resume only after 30 s below limit − hysteresis',()=>{
  const {g,adv}=gov();
  g.setSensors({gpu:{temperature_c:81}});assert.equal(g.decide().run,false);
  g.setSensors({gpu:{temperature_c:77}});adv(60e3);assert.equal(g.decide().run,false,'77 °C is above 80−5');
  g.setSensors({gpu:{temperature_c:74}});assert.equal(g.decide().run,false);adv(29e3);assert.equal(g.decide().run,false);adv(2e3);assert.equal(g.decide().run,true);
});
test('R02 daily budget: accounting stops work at the limit; new local day resets; budget survives restart',()=>{
  const dir=tmp('kc-gov-');const {g,adv}=gov({dir,policy:{...DEFAULT_POLICY,daily_hours:1}});
  g.account({wallMs:59*60e3});assert.equal(g.decide().run,true);g.account({wallMs:61e3});
  assert.equal(g.decide().reason,'daily_budget');g.save();
  const {g:g2}=gov({dir,policy:{...DEFAULT_POLICY,daily_hours:1}});assert.equal(g2.decide().reason,'daily_budget','restart does not reset the budget');
  adv(24*3600e3);assert.equal(g.decide().run,true,'next day');
});
test('R04 clock moved backwards cannot return to an earlier day with unused budget',()=>{
  const dir=tmp('kc-gov-');const {g,set}=gov({dir,policy:{...DEFAULT_POLICY,daily_hours:1}});
  g.account({wallMs:3600e3});assert.equal(g.decide().reason,'daily_budget');
  set(Date.parse('2026-11-25T10:00:00+03:00'));assert.equal(g.decide().reason,'daily_budget');assert.equal(g.budget().day,'2026-11-26');
});
test('duty cycle: sleep keeps the active share near the target; measured share is reported, not assumed',()=>{
  const {g,adv}=gov({policy:{...DEFAULT_POLICY,gpu_target_pct:10}});
  let active=0,total=0;
  for(let i=0;i<200;i++){adv(500);active+=500;total+=500;const s=g.afterStep(500);adv(s);total+=s;}
  const share=active/total;assert.ok(share>0.09&&share<0.11,'share '+share);
  const m=g.measured();assert.ok(Math.abs(m.active_fraction_60s-0.1)<0.02,JSON.stringify(m));
  g.setPolicy({gpu_target_pct:0});assert.equal(g.decide().reason,'gpu_zero');
});
test('policy revisions: a stale editor cannot overwrite a newer policy',()=>{
  const {g}=gov();const r=g.policy.revision;g.setPolicy({gpu_target_pct:20},r);
  assert.throws(()=>g.setPolicy({gpu_target_pct:30},r),e=>e.code==='CONFLICT');
});
test('sensor parsers: nvidia-smi CSV and Windows notification state',()=>{
  const s=parseNvidiaLine('NVIDIA GeForce RTX 5070 Laptop GPU, 37, 1500, 8151, 61, 42.5');
  assert.equal(s.utilization_pct,37);assert.equal(s.memory_used_bytes,1500*2**20);assert.equal(s.memory_total_bytes,8151*2**20);assert.equal(s.temperature_c,61);assert.equal(s.power_w,42.5);
  assert.equal(parseNvidiaLine('GPU, [N/A], 1, 2, [N/A], [N/A]').temperature_c,null,'unsupported field → null, never invented');assert.equal(parseNvidiaLine('garbage'),null);
  assert.deepEqual(parseNotificationState(3),{game:true,fullscreen:true,source:'SHQueryUserNotificationState'});
  assert.equal(parseNotificationState(5).game,false);
});
