// Which network interface is Thunderbolt, Ethernet or Wi-Fi. Interface names alone are ambiguous
// (en0 is Wi-Fi on a MacBook, Ethernet on an iMac), so ask the OS once and cache it:
//  - macOS: `networksetup -listallhardwareports` (Thunderbolt Bridge is usually bridge0)
//  - Windows: Get-NetAdapter (Thunderbolt(TM) Networking, USB4(TM) P2P Network Adapter, Wi-Fi)
//  - Linux: sysfs (wireless/, the thunderbolt-net driver, thunderbolt0)
import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const run=(file,args,timeout=5000)=>new Promise(resolve=>{execFile(file,args,{timeout,windowsHide:true,encoding:'utf8'},(e,out)=>resolve(e?'':String(out||'')));});

export function portType(port){
  const p=String(port||'');
  if(/wi-?fi|airport|wireless|wlan|802\.11/i.test(p))return 'wifi';
  if(/thunderbolt\s*bridge/i.test(p))return 'thunderbolt';
  if(/ethernet|lan|10\/100|gigabit/i.test(p))return 'ethernet';
  if(/thunderbolt|usb4/i.test(p))return 'thunderbolt';
  return null;
}
// macOS `networksetup -listallhardwareports`.
export function parseHardwarePorts(text){
  const out={};let port=null;
  for(const line of String(text||'').split(/\r?\n/)){
    const m=/^Hardware Port:\s*(.+)$/.exec(line.trim());if(m){port=m[1];continue;}
    const d=/^Device:\s*(\S+)$/.exec(line.trim());
    if(d&&port){const t=portType(port);if(t)out[d[1]]=t;port=null;}
  }
  return out;
}
// Windows: "Name|InterfaceDescription|MediaType" lines from Get-NetAdapter.
export function parseNetAdapters(text){
  const out={};
  for(const line of String(text||'').split(/\r?\n/)){
    const [name,desc='',media='']=line.split('|').map(s=>s.trim());if(!name)continue;
    if(/thunderbolt|usb4/i.test(desc))out[name]='thunderbolt';
    else if(/802\.11|wireless/i.test(media)||/wi-?fi|wireless|802\.11|wlan/i.test(desc))out[name]='wifi';
    else if(/802\.3/i.test(media)||/ethernet|gbe|realtek|intel.*(i2\d\d|connection)/i.test(desc))out[name]='ethernet';
  }
  return out;
}
async function linuxTypes(names){
  const out={};
  for(const name of names){
    const dir=path.join('/sys/class/net',name);
    try{await fs.access(path.join(dir,'wireless'));out[name]='wifi';continue;}catch{}
    let driver='';try{driver=path.basename(await fs.readlink(path.join(dir,'device','driver')));}catch{}
    if(/thunderbolt/i.test(driver)||/^thunderbolt/.test(name)){out[name]='thunderbolt';continue;}
    if(driver)out[name]='ethernet';
  }
  return out;
}

let cache={at:0,types:{},pending:null};
// {[interfaceName]: type}; refreshed at most once a minute, never blocks for long.
export function interfaceTypes({platform=process.platform,maxAgeMs=60000}={}){
  if(Date.now()-cache.at<maxAgeMs||cache.pending)return cache.types;
  cache.pending=(async()=>{
    let types={};
    try{
      if(platform==='darwin')types=parseHardwarePorts(await run('/usr/sbin/networksetup',['-listallhardwareports']));
      else if(platform==='win32')types=parseNetAdapters(await run('powershell.exe',['-NoProfile','-NonInteractive','-Command','Get-NetAdapter | ForEach-Object { $_.Name + "|" + $_.InterfaceDescription + "|" + $_.MediaType }'],8000));
      else if(platform==='linux')types=await linuxTypes(Object.keys(os.networkInterfaces()));
    }catch{}
    cache={at:Date.now(),types,pending:null};
    return types;
  })();
  return cache.types;
}
export async function interfaceTypesReady(opts){interfaceTypes(opts);if(cache.pending)await cache.pending;return cache.types;}
