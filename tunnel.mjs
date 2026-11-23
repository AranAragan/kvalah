// One LAN port for everything a worker shares:
//  - HTTP peer API (pairing, info, model proxy) — bearer-token authenticated
//  - "KVRPC1 <token>\n" tunnels to the local ggml-rpc-server (which itself only listens on 127.0.0.1)
// The llama.cpp RPC protocol has no authentication, so it is never exposed directly.
import net from 'node:net';
import {isPrivateAddress} from './lan.mjs';

export const HELLO='KVRPC1 ';
const MAX_HELLO=200;

// Accepts connections on every given address; sniffs the first bytes to route HTTP vs RPC tunnel.
export function createPeerListener({addresses,port,httpServer,authorizeTunnel,tunnelTarget,onTunnel=()=>{},allowRemote=isPrivateAddress}){
  const servers=[];const sockets=new Set();
  function onConnection(socket){
    if(!allowRemote(socket.remoteAddress)){socket.destroy();return;}
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));
    socket.setTimeout(15000,()=>socket.destroy());
    let head=Buffer.alloc(0);
    const onData=chunk=>{
      head=Buffer.concat([head,chunk]);
      const prefix=head.subarray(0,HELLO.length).toString('latin1');
      if(head.length<HELLO.length&&HELLO.startsWith(prefix))return; // wait for more bytes
      if(prefix!==HELLO){
        // HTTP: hand the socket (with the bytes already read) to the HTTP server.
        socket.removeListener('data',onData);socket.pause();socket.unshift(head);socket.setTimeout(0);
        httpServer.emit('connection',socket);process.nextTick(()=>socket.resume());return;
      }
      const nl=head.indexOf(10);
      if(nl<0){if(head.length>MAX_HELLO)socket.destroy();return;}
      socket.removeListener('data',onData);socket.pause();
      const token=head.subarray(HELLO.length,nl).toString('latin1').trim(),rest=head.subarray(nl+1);
      const who=authorizeTunnel(token,socket.remoteAddress);
      const target=who&&tunnelTarget();
      if(!who){socket.end('ERR unauthorized\n');return;}
      if(!target){socket.end('ERR rpc-server is not running\n');return;}
      const upstream=net.connect(target.port,target.host||'127.0.0.1');
      upstream.once('connect',()=>{
        socket.setTimeout(0);socket.setNoDelay(true);upstream.setNoDelay(true);
        socket.write('OK\n');if(rest.length)upstream.write(rest);
        socket.pipe(upstream);upstream.pipe(socket);socket.resume();
        onTunnel({host:who,remote:socket.remoteAddress,socket});
      });
      upstream.on('error',()=>{if(!socket.destroyed)socket.end('ERR rpc-server unreachable\n');});
      socket.on('error',()=>upstream.destroy());upstream.on('close',()=>socket.destroy());socket.on('close',()=>upstream.destroy());
    };
    socket.on('data',onData);socket.on('error',()=>{});
  }
  const listen=address=>new Promise((resolve,reject)=>{
    const s=net.createServer(onConnection);
    s.once('error',reject);
    s.listen(port,address,()=>{s.removeListener('error',reject);s.on('error',()=>{});servers.push(s);resolve();});
  });
  return {
    async start(){const errors=[];for(const a of addresses){try{await listen(a);}catch(e){errors.push(a+': '+(e.code||e.message));}}if(!servers.length)throw Error(errors.join('; ')||'no LAN address to listen on');return {listening:servers.map(s=>s.address()),errors};},
    // New interfaces (a Thunderbolt cable plugged in later) are added without dropping open tunnels.
    async add(list){const have=new Set(servers.map(x=>x.address()?.address));const errors=[];for(const a of list)if(!have.has(a)){try{await listen(a);}catch(e){errors.push(a+': '+(e.code||e.message));}}return errors;},
    close(){for(const s of servers)s.close();for(const so of sockets)so.destroy();servers.length=0;},
    get listening(){return servers.map(s=>s.address());}
  };
}

// Host side: a 127.0.0.1 port that llama-server's --rpc connects to; each connection is carried to
// the worker over the authenticated tunnel.
export function createTunnelClient({host,port,token,connectTimeoutMs=8000}){
  const stats={connections:0,active:0,bytesUp:0,bytesDown:0,lastError:''};
  const sockets=new Set();
  const server=net.createServer(local=>{
    local.pause();sockets.add(local);stats.connections++;stats.active++;
    local.on('close',()=>{sockets.delete(local);stats.active--;});
    const remote=net.connect({host,port,timeout:connectTimeoutMs});
    sockets.add(remote);remote.on('close',()=>sockets.delete(remote));
    let buf=Buffer.alloc(0),open=false;
    remote.once('connect',()=>{remote.setTimeout(connectTimeoutMs);remote.write(HELLO+token+'\n');});
    remote.on('timeout',()=>{if(!open){stats.lastError='timeout';remote.destroy();local.destroy();}});
    const onHello=chunk=>{
      buf=Buffer.concat([buf,chunk]);const nl=buf.indexOf(10);
      if(nl<0){if(buf.length>MAX_HELLO){remote.destroy();local.destroy();}return;}
      remote.removeListener('data',onHello);
      const line=buf.subarray(0,nl).toString('latin1');
      if(line!=='OK'){stats.lastError=line.replace(/^ERR\s*/,'');remote.destroy();local.destroy();return;}
      open=true;remote.setTimeout(0);remote.setNoDelay(true);local.setNoDelay(true);
      const rest=buf.subarray(nl+1);if(rest.length){stats.bytesDown+=rest.length;local.write(rest);}
      local.on('data',c=>{stats.bytesUp+=c.length;});remote.on('data',c=>{stats.bytesDown+=c.length;});
      local.pipe(remote);remote.pipe(local);local.resume();
    };
    remote.on('data',onHello);
    remote.on('error',e=>{stats.lastError=e.code||e.message;local.destroy();});
    local.on('error',()=>remote.destroy());
    remote.on('close',()=>local.destroy());local.on('close',()=>remote.destroy());
  });
  return {
    stats,
    listen(){return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve(server.address().port));});},
    get port(){return server.address()?.port;},
    close(){server.close();for(const s of sockets)s.destroy();}
  };
}
