// OS sensor adapters (spec §10). Missing sensors report null — never a made-up value — and the Governor
// pauses fail-safe where the policy depends on them. No screen capture, input logging or app names.
import {spawn} from 'node:child_process';
import os from 'node:os';
export function parseNvidiaLine(line){
  const f=line.split(',').map(s=>s.trim());if(f.length<6)return null;
  const n=v=>{const x=Number(v);return Number.isFinite(x)?x:null;};
  return {name:f[0].slice(0,60),utilization_pct:n(f[1]),memory_used_bytes:n(f[2])==null?null:n(f[2])*2**20,memory_total_bytes:n(f[3])==null?null:n(f[3])*2**20,temperature_c:n(f[4]),power_w:n(f[5]),source:'nvidia-smi'};
}
// Long-running nvidia-smi sampler (one process, 2 s period). Resolves null samples when NVIDIA tools are absent.
export function startNvidia(onSample,{periodMs=2000}={}){
  let child;
  try{child=spawn('nvidia-smi',['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw','--format=csv,noheader,nounits','-lms',String(periodMs)],{windowsHide:true,stdio:['ignore','pipe','ignore']});}
  catch{onSample(null);return ()=>{};}
  let buf='';
  child.on('error',()=>onSample(null));
  child.stdout.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);const s=parseNvidiaLine(line);if(s)onSample(s);}});
  child.on('exit',()=>onSample(null));
  return ()=>{try{child.kill();}catch{}};
}
// Windows: SHQueryUserNotificationState tells whether a full-screen Direct3D app (game) or presentation is
// running. A small PowerShell loop prints only the numeric state.
const PS=`$ErrorActionPreference='Stop';Add-Type -Namespace K -Name Q -MemberDefinition '[DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int s);';while($true){$s=0;[void][K.Q]::SHQueryUserNotificationState([ref]$s);[Console]::Out.WriteLine($s);[Console]::Out.Flush();Start-Sleep -Seconds 2}`;
export function parseNotificationState(n){return {game:n===3,fullscreen:n===2||n===3||n===4,source:'SHQueryUserNotificationState'};}
export function startWindowsGameSensor(onSample){
  if(process.platform!=='win32'){onSample({game:null,fullscreen:null});return ()=>{};}
  let child;
  try{child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',PS],{windowsHide:true,stdio:['ignore','pipe','ignore']});}
  catch{onSample({game:null,fullscreen:null});return ()=>{};}
  let buf='';
  child.on('error',()=>onSample({game:null,fullscreen:null}));
  child.stdout.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\n'))>=0){const v=Number(buf.slice(0,i).trim());buf=buf.slice(i+1);if(Number.isInteger(v))onSample(parseNotificationState(v));}});
  child.on('exit',()=>onSample({game:null,fullscreen:null}));
  return ()=>{try{child.kill();}catch{}};
}
export const memorySample=()=>({ram_free_bytes:os.freemem(),ram_total_bytes:os.totalmem(),logical_cpus:os.availableParallelism?.()||os.cpus().length});
