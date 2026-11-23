// LAN helpers for multi-device mode: private-address checks, interface/broadcast discovery,
// UDP announcement format and pairing codes. Pure functions (unit-tested in test/devices.test.mjs).
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import net from 'node:net';

export const PROTOCOL=1;
export const DEFAULT_PEER_PORT=47317;
export const DISCOVERY_PORT=47318;

function ipv4Parts(address){
  const s=String(address||'').replace(/^::ffff:/i,'');
  if(!net.isIPv4(s))return null;
  return s.split('.').map(Number);
}
// Loopback, RFC 1918, link-local and CGNAT (Tailscale/ZeroTier style) ranges. Public addresses are never "LAN".
export function isPrivateAddress(address){
  const a=ipv4Parts(address);
  if(a){
    return a[0]===10||a[0]===127||(a[0]===172&&a[1]>=16&&a[1]<=31)||(a[0]===192&&a[1]===168)||(a[0]===169&&a[1]===254)||(a[0]===100&&a[1]>=64&&a[1]<=127);
  }
  const s=String(address||'').toLowerCase().split('%')[0];
  if(!net.isIPv6(s))return false;
  return s==='::1'||/^fe[89ab][0-9a-f]:/.test(s)||/^f[cd][0-9a-f]{2}:/.test(s);
}
export const isLoopback=address=>{const a=ipv4Parts(address);return a?a[0]===127:String(address).split('%')[0]==='::1';};

const toInt=parts=>((parts[0]<<24)>>>0)+(parts[1]<<16)+(parts[2]<<8)+parts[3];
const toIp=n=>[n>>>24,(n>>>16)&255,(n>>>8)&255,n&255].join('.');
// Private, non-internal IPv4 addresses of this machine (os.networkInterfaces() shape), with their broadcast address.
export function lanAddresses(ifaces){
  const out=[];
  for(const [name,list] of Object.entries(ifaces||{})){
    for(const i of list||[]){
      const family=i.family===4?'IPv4':i.family;
      if(family!=='IPv4'||i.internal||!isPrivateAddress(i.address))continue;
      const addr=ipv4Parts(i.address),mask=ipv4Parts(i.netmask)||[255,255,255,0];
      const broadcast=toIp((toInt(addr)|(~toInt(mask)>>>0))>>>0);
      out.push({name,address:i.address,netmask:i.netmask||'255.255.255.0',broadcast});
    }
  }
  // Prefer typical home LANs (192.168/10/172) over link-local and CGNAT ranges.
  const rank=a=>a.startsWith('169.254.')?2:a.startsWith('100.')?1:0;
  return out.sort((x,y)=>rank(x.address)-rank(y.address));
}
export function broadcastAddresses(ifaces){
  const set=new Set(lanAddresses(ifaces).filter(a=>!a.address.startsWith('169.254.')).map(a=>a.broadcast));
  if(!set.size)set.add('255.255.255.255');
  return [...set];
}

const clean=(s,max)=>String(s??'').replace(/[\u0000-\u001f\u007f<>]/g,'').trim().slice(0,max);
export function buildAnnouncement(self){
  return Buffer.from(JSON.stringify({kvalah:PROTOCOL,type:'announce',id:self.id,name:clean(self.name,64),port:self.port,version:clean(self.version,32),platform:clean(self.platform,16),modes:{tasks:!!self.modes?.tasks,rpc:!!self.modes?.rpc}}));
}
export const buildProbe=id=>Buffer.from(JSON.stringify({kvalah:PROTOCOL,type:'probe',id}));
// Validates a UDP datagram from another kvalah instance. Returns null for anything unexpected.
export function parseAnnouncement(buffer,rinfo,selfId){
  if(!buffer||buffer.length>2048)return null;
  let data;try{data=JSON.parse(buffer.toString('utf8'));}catch{return null;}
  if(!data||typeof data!=='object'||data.kvalah!==PROTOCOL)return null;
  if(!['announce','probe'].includes(data.type))return null;
  if(typeof data.id!=='string'||!/^[a-zA-Z0-9-]{8,64}$/.test(data.id)||data.id===selfId)return null;
  const address=String(rinfo?.address||'').replace(/^::ffff:/i,'');
  if(!isPrivateAddress(address))return null;
  if(data.type==='probe')return {type:'probe',id:data.id,address,replyPort:rinfo.port};
  const port=Number(data.port);
  if(!Number.isInteger(port)||port<1||port>65535)return null;
  return {type:'announce',id:data.id,name:clean(data.name,64)||address,address,port,version:clean(data.version,32),platform:clean(data.platform,16),modes:{tasks:data.modes?.tasks===true,rpc:data.modes?.rpc===true}};
}

// "host:port", "[v6]:port", "http://host:port", or a bare host (default port).
export function parseHostPort(input,defaultPort=DEFAULT_PEER_PORT){
  let s=String(input||'').trim();
  if(!s)throw Error('empty address');
  s=s.replace(/^https?:\/\//i,'').replace(/\/.*$/,'');
  let host=s,port=defaultPort;
  const v6=/^\[([^\]]+)\](?::(\d+))?$/.exec(s);
  if(v6){host=v6[1];if(v6[2])port=Number(v6[2]);}
  else if((s.match(/:/g)||[]).length===1){const i=s.lastIndexOf(':');host=s.slice(0,i);port=Number(s.slice(i+1));}
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('invalid port');
  if(!host||!/^[a-zA-Z0-9.:%_-]+$/.test(host))throw Error('invalid host');
  return {host,port};
}

// Pairing codes: 12 Crockford base32 symbols (60 bits), shown as XXXX-XXXX-XXXX.
const ALPHABET='0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function newPairingCode(){
  const bytes=randomBytes(12);let out='';
  for(const b of bytes)out+=ALPHABET[b&31];
  return out.slice(0,4)+'-'+out.slice(4,8)+'-'+out.slice(8,12);
}
export function normalizeCode(code){
  return String(code||'').toUpperCase().replace(/O/g,'0').replace(/[IL]/g,'1').replace(/[^0-9A-Z]/g,'');
}
export function codesEqual(a,b){
  const x=Buffer.from(normalizeCode(a)),y=Buffer.from(normalizeCode(b));
  return x.length===12&&x.length===y.length&&timingSafeEqual(x,y);
}
export const newToken=()=>randomBytes(32).toString('hex');
export const tokenHash=token=>createHash('sha256').update(String(token)).digest('hex');
export function hashesEqual(a,b){
  const x=Buffer.from(String(a),'hex'),y=Buffer.from(String(b),'hex');
  return x.length===32&&y.length===32&&timingSafeEqual(x,y);
}
// Sliding-window limiter for pairing attempts (per remote address and global).
export function createLimiter({limit=5,windowMs=10*60*1000,globalLimit=30,now=Date.now}={}){
  const hits=new Map();let global=[];
  const prune=list=>list.filter(t=>now()-t<windowMs);
  return {
    blocked(key){global=prune(global);const list=prune(hits.get(key)||[]);hits.set(key,list);return list.length>=limit||global.length>=globalLimit;},
    fail(key){const list=prune(hits.get(key)||[]);list.push(now());hits.set(key,list);global=prune(global);global.push(now());},
    reset(key){hits.delete(key);}
  };
}
