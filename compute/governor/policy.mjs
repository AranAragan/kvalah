// Resource policy (spec §4.1, §10). Every field here is enforced by the Governor; the UI only edits it.
// The policy is local: a coordinator can never change it or enable compute remotely.
import {fail} from '../protocol/errors.mjs';
export const POLICY_VERSION=1;
export const DEFAULT_POLICY=Object.freeze({
  policy_version:POLICY_VERSION,revision:0,profile:'gentle',
  gpu_target_pct:10,cpu_target_pct:10,daily_hours:4,extended_hours:false,
  only_idle:true,idle_minutes:5,only_ac:true,pause_on_games:true,pause_on_local_ai:true,pause_on_fullscreen:false,
  min_free_vram_gib:1.5,min_free_ram_gib:2,max_worker_mem_gib:null,temp_limit_c:80,temp_hysteresis_c:5,
  battery_floor_pct:50,cache_limit_gib:20,daily_traffic_mb:1024,allow_metered:false,
  quiet_hours:{enabled:false,from:'23:00',to:'07:00'},background_after_close:false,keep_warm:false
});
const step5=(v,name)=>{if(!Number.isInteger(v)||v<0||v>100||v%5)fail('INVALID_SCHEMA',name+' must be 0–100 in steps of 5');return v;};
const range=(v,lo,hi,name,nullable=false)=>{if(nullable&&v===null)return null;if(typeof v!=='number'||!Number.isFinite(v)||v<lo||v>hi)fail('INVALID_SCHEMA',`${name} must be between ${lo} and ${hi}`);return v;};
const hhmm=(v,name)=>{if(typeof v!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(v))fail('INVALID_SCHEMA',name+' must be HH:MM');return v;};
export function validatePolicy(input,current=DEFAULT_POLICY){
  const p={...current,...(input||{})};
  const out={
    policy_version:POLICY_VERSION,revision:current.revision,
    profile:['gentle','custom','full'].includes(p.profile)?p.profile:fail('INVALID_SCHEMA','profile must be gentle, custom or full'),
    gpu_target_pct:step5(p.gpu_target_pct,'gpu_target_pct'),cpu_target_pct:step5(p.cpu_target_pct,'cpu_target_pct'),
    extended_hours:!!p.extended_hours,daily_hours:0,
    only_idle:!!p.only_idle,idle_minutes:range(p.idle_minutes,1,120,'idle_minutes'),only_ac:!!p.only_ac,pause_on_games:!!p.pause_on_games,
    pause_on_local_ai:!!p.pause_on_local_ai,pause_on_fullscreen:!!p.pause_on_fullscreen,
    min_free_vram_gib:range(p.min_free_vram_gib,0,64,'min_free_vram_gib'),min_free_ram_gib:range(p.min_free_ram_gib,0,256,'min_free_ram_gib'),
    max_worker_mem_gib:range(p.max_worker_mem_gib,1,256,'max_worker_mem_gib',true),
    temp_limit_c:range(p.temp_limit_c,50,95,'temp_limit_c'),temp_hysteresis_c:range(p.temp_hysteresis_c,1,20,'temp_hysteresis_c'),
    battery_floor_pct:range(p.battery_floor_pct,10,100,'battery_floor_pct'),cache_limit_gib:range(p.cache_limit_gib,1,2000,'cache_limit_gib'),
    daily_traffic_mb:range(p.daily_traffic_mb,10,1e6,'daily_traffic_mb'),allow_metered:!!p.allow_metered,
    quiet_hours:{enabled:!!p.quiet_hours?.enabled,from:hhmm(p.quiet_hours?.from??'23:00','quiet_hours.from'),to:hhmm(p.quiet_hours?.to??'07:00','quiet_hours.to')},
    background_after_close:false,   // tray/background mode is not implemented in v0.2: closing the app stops Compute
    keep_warm:!!p.keep_warm
  };
  out.daily_hours=range(p.daily_hours,1,out.extended_hours?24:12,'daily_hours');
  // An aggressive profile must be chosen explicitly (spec §4.1 "Установка агрессивного профиля требует явного выбора").
  if((out.gpu_target_pct>50||out.cpu_target_pct>50||out.daily_hours>12)&&out.profile!=='full')fail('INVALID_SCHEMA','targets above 50% or more than 12 h/day need the explicit "full" profile');
  return out;
}
// Nominal monthly contribution: target fraction × session hours/day × 30. A time estimate, not FLOPS.
export const nominalMonthlyHours=p=>Math.round(p.gpu_target_pct/100*p.daily_hours*30*10)/10;
