// Takes snapshots from the registration and governor interfaces. Eligibility is a hard gate.
// Ranking affects placements only. Aggregation weights come from verified supervision masks.
export function scheduleExperts(tasks,devices,{now=Date.now(),heartbeatLimitMs=90000}={}){
  const workers=new Map(devices.filter(d=>d&&d.id).map(d=>[d.id,d]));
  const assigned=[],pending=[];
  const ordered=[...tasks].sort((a,b)=>b.priority-a.priority||(a.id<b.id?-1:a.id>b.id?1:0));
  for(const task of ordered){
    const candidates=[];
    for(const device of workers.values()){
      const reasons=[];
      if(!['approved','active'].includes(device.state)||device.consent!==true||device.governor?.allowed!==true||!(device.governor.target_pct>0))reasons.push('policy');
      if(!(now-device.last_seen>=0&&now-device.last_seen<=heartbeatLimitMs))reasons.push('heartbeat');
      if(!task.runtimes.includes(device.runtime))reasons.push('runtime');
      if(!(device.free_ram>=task.ram&&device.free_vram>=task.vram))reasons.push('memory');
      if(!(device.temp_c<=device.max_temp_c))reasons.push('temperature');
      if(task.device&&task.device!==device.id)reasons.push('placement');
      if(task.group&&task.group!==device.group)reasons.push('group');
      const cached=new Set(device.cache??[]);
      const bytes=task.artifacts.reduce((n,a)=>n+(cached.has(a.sha256)?0:a.bytes),0);
      if(!(device.remaining_traffic>=bytes&&device.free_disk>=bytes))reasons.push('transfer-budget');
      if(reasons.length)continue;
      const transfer=bytes/Math.max(device.bytes_per_s||1,1)+(device.rtt_ms||0)/1000;
      const compute=task.tokens/Math.max((device.tokens_per_s||1)*(device.governor.target_pct/100),0.01);
      const resident=device.resident===task.backbone?0:device.cold_start_s||0;
      const retry=Math.min(20,Math.max(0,device.recent_failures||0));
      candidates.push({device:device.id,group:device.group,seconds:transfer+compute+resident+retry,bytes});
    }
    candidates.sort((a,b)=>a.seconds-b.seconds||(a.device<b.device?-1:1));
    const result=candidates[0];
    if(!result){pending.push({task:task.id,reason:'no eligible device'});continue;}
    workers.delete(result.device);
    assigned.push({task:task.id,expert:task.expert,...result});
  }
  return {assigned,pending};
}
