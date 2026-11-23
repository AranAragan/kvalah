// 0.9: link types (Thunderbolt / Ethernet / Wi-Fi), discovery on every interface, link failover,
// integrated-GPU handling in the pool, and the live activity sampler.
import test from 'node:test';
import assert from 'node:assert/strict';
import {interfaceType,lanAddresses,broadcastAddresses,buildAnnouncement,parseAnnouncement,parseLinks,linkRank} from '../lan.mjs';
import {parseHardwarePorts,parseNetAdapters,portType} from '../netif.mjs';
import {isIntegratedGpu,strongGpus,poolDeviceRows,llamaServerArgs,rpcServerArgs} from '../llamacpp.mjs';
import {parseNvidiaSmi,createRate,createActivity} from '../activity.mjs';
import {normalizeLinks,normalizeNode} from '../nodes.mjs';

test('interface types: OS facts first, then names',()=>{
  assert.equal(interfaceType('en0','192.168.1.5',{en0:'wifi'}),'wifi','a MacBook en0 is Wi-Fi when networksetup says so');
  assert.equal(interfaceType('bridge0','169.254.3.4'),'thunderbolt');
  assert.equal(interfaceType('thunderbolt0'),'thunderbolt');
  assert.equal(interfaceType('wlp3s0'),'wifi');assert.equal(interfaceType('Wi-Fi'),'wifi');
  assert.equal(interfaceType('enp4s0'),'ethernet');assert.equal(interfaceType('Ethernet 2'),'ethernet');
  assert.equal(interfaceType('tailscale0','100.64.1.1'),'vpn');
  assert.ok(linkRank('thunderbolt')<linkRank('ethernet')&&linkRank('ethernet')<linkRank('wifi'));
});

test('macOS hardware ports and Windows adapters are classified',()=>{
  const mac=`Hardware Port: Ethernet\nDevice: en0\nEthernet Address: aa\n\nHardware Port: Wi-Fi\nDevice: en1\nEthernet Address: bb\n\nHardware Port: Thunderbolt 1\nDevice: en2\n\nHardware Port: Thunderbolt Bridge\nDevice: bridge0\n\nHardware Port: Thunderbolt Ethernet Slot 0\nDevice: en5\n\nVLAN Configurations\n===================\n`;
  assert.deepEqual(parseHardwarePorts(mac),{en0:'ethernet',en1:'wifi',en2:'thunderbolt',bridge0:'thunderbolt',en5:'ethernet'});
  assert.equal(portType('USB 10/100/1000 LAN'),'ethernet');
  const win='Wi-Fi|Intel(R) Wi-Fi 6E AX211 160MHz|Native 802.11\nEthernet|Realtek PCIe GbE Family Controller|802.3\nEthernet 3|Thunderbolt(TM) Networking|802.3\nEthernet 4|USB4(TM) P2P Network Adapter|802.3\nБеспроводная сеть|MediaTek Wi-Fi 6 MT7921|Native 802.11\n';
  assert.deepEqual(parseNetAdapters(win),{'Wi-Fi':'wifi',Ethernet:'ethernet','Ethernet 3':'thunderbolt','Ethernet 4':'thunderbolt','Беспроводная сеть':'wifi'});
});

test('Thunderbolt link-local addresses are listed, typed and get a discovery broadcast',()=>{
  const ifaces={en1:[{address:'192.168.1.20',netmask:'255.255.255.0',family:'IPv4',internal:false}],
    bridge0:[{address:'169.254.10.20',netmask:'255.255.0.0',family:'IPv4',internal:false}]};
  const list=lanAddresses(ifaces,{en1:'wifi',bridge0:'thunderbolt'});
  assert.deepEqual(list.map(a=>[a.address,a.type]),[['192.168.1.20','wifi'],['169.254.10.20','thunderbolt']]);
  assert.deepEqual(broadcastAddresses(ifaces).sort(),['169.254.255.255','192.168.1.255']);
});

test('announcements carry every address with its link type; hostile lists are cleaned',()=>{
  const self={id:'aaaaaaaa-1111',name:'Mac',port:47317,version:'0.9.0',platform:'darwin',modes:{tasks:true,rpc:true},links:[{address:'169.254.10.20',type:'thunderbolt'},{address:'192.168.1.20',type:'wifi'}]};
  const r=parseAnnouncement(buildAnnouncement(self),{address:'169.254.10.20',port:47318},'other-id-1234');
  assert.deepEqual(r.links,[{address:'169.254.10.20',type:'thunderbolt'},{address:'192.168.1.20',type:'wifi'}]);
  assert.deepEqual(parseLinks([{a:'8.8.8.8',t:'ethernet'},{a:'127.0.0.1',t:'ethernet'},{a:'10.0.0.2',t:'weird'},{a:'<x>'},null,'x']),[{address:'10.0.0.2',type:'other'}]);
  assert.deepEqual(parseLinks('nope'),[]);
});

test('paired devices keep several links; invalid ones are dropped',()=>{
  assert.deepEqual(normalizeLinks([{url:'http://169.254.1.2:47317',type:'thunderbolt'},{url:'http://169.254.1.2:47317',type:'wifi'},{url:'javascript:alert(1)'},{url:'http://evil.example:80'},{url:'http://192.168.1.2:47317/',type:'wifi'}]),
    [{url:'http://169.254.1.2:47317',type:'thunderbolt'},{url:'http://192.168.1.2:47317',type:'wifi'}]);
  const n=normalizeNode({kind:'kvalah',url:'http://192.168.1.2:47317',links:[{url:'http://169.254.1.2:47317',type:'thunderbolt'}],link:'wifi'});
  assert.equal(n.link,'wifi');assert.equal(n.links.length,1);
  assert.deepEqual(normalizeNode({kind:'ollama',url:'http://192.168.1.2:11434',links:[{url:'http://1.2.3.4:1'}]}).links,[]);
});

test('integrated GPUs next to a discrete GPU are skipped by default',()=>{
  for(const d of ['AMD Radeon 610M (RADV RAPHAEL_MENDOCINO)','AMD Radeon(TM) Graphics','AMD Radeon 780M','Intel(R) UHD Graphics 770','Intel(R) Iris(R) Xe Graphics','Intel(R) Arc(TM) Graphics'])assert.ok(isIntegratedGpu(d),d);
  for(const d of ['NVIDIA GeForce RTX 4060 Laptop GPU','AMD Radeon RX 7900 XTX','Intel(R) Arc(TM) A770 Graphics','Apple M3 Max','AMD Radeon Pro W7900'])assert.ok(!isIntegratedGpu(d),d);
  const devs=[{name:'Vulkan0',description:'NVIDIA GeForce RTX 4060 Laptop GPU'},{name:'Vulkan1',description:'AMD Radeon 610M'},{name:'CPU',description:'cpu'}];
  assert.deepEqual(strongGpus(devs).keep.map(d=>d.name),['Vulkan0']);assert.deepEqual(strongGpus(devs).skipped.map(d=>d.name),['Vulkan1']);
  assert.deepEqual(strongGpus(devs,{skipIntegrated:false}).keep.map(d=>d.name),['Vulkan0','Vulkan1']);
  assert.deepEqual(strongGpus([devs[1]]).keep.map(d=>d.name),['Vulkan1'],'an integrated GPU alone is still used');
  assert.deepEqual(rpcServerArgs({port:5000,devices:['Vulkan0']}),['-H','127.0.0.1','-p','5000','-c','-d','Vulkan0']);
  const args=llamaServerArgs({model:'/m.gguf',rpc:['127.0.0.1:5001'],port:8080,devices:['Vulkan0','RPC0']});
  assert.deepEqual(args.slice(args.indexOf('--device'),args.indexOf('--device')+2),['--device','Vulkan0,RPC0']);
  assert.throws(()=>llamaServerArgs({model:'/m.gguf',port:8080,devices:['a;b']}));
});

test('pool rows: a worker lending two GPUs shows both under its name, matched by endpoint',()=>{
  const devices=[{name:'Vulkan0',description:'NVIDIA GeForce RTX 3060',totalMiB:12288,freeMiB:11000},{name:'Vulkan1',description:'AMD Radeon 610M',totalMiB:8000,freeMiB:7000},
    {name:'RPC0',description:'127.0.0.1:6001',totalMiB:7900,freeMiB:7000},{name:'RPC1',description:'127.0.0.1:6001',totalMiB:7900,freeMiB:7400},{name:'RPC2',description:'127.0.0.1:6002',totalMiB:24000,freeMiB:23000}];
  const rows=poolDeviceRows(devices,{names:['ENVERDASH','STUDIO'],endpoints:['127.0.0.1:6001','127.0.0.1:6002'],remote:[[{description:'NVIDIA RTX 4060'},{description:'NVIDIA RTX 4070'}],[]],selfName:'Desk',platform:'linux',skipped:['Vulkan1']});
  assert.deepEqual(rows.map(r=>[r.device,r.name,r.used]),[['Vulkan0','Desk',true],['Vulkan1','Desk',false],['RPC0','ENVERDASH',true],['RPC1','ENVERDASH',true],['RPC2','STUDIO',true]]);
  assert.equal(rows[2].description,'NVIDIA RTX 4060');assert.equal(rows[3].description,'NVIDIA RTX 4070');assert.equal(rows[4].description,'127.0.0.1:6002');
  assert.equal(rows[1].skipped,true);
});

test('activity: nvidia-smi parsing, rates and a cheap sample',async()=>{
  assert.deepEqual(parseNvidiaSmi('NVIDIA GeForce RTX 4060 Laptop GPU, 5120, 8188, 37\nbad line\n'),[{name:'NVIDIA GeForce RTX 4060 Laptop GPU',usedMiB:5120,totalMiB:8188,util:37}]);
  const r=createRate(3000);r.push(0,1000);r.push(5e6,2000);assert.equal(r.get(2000),5e6);assert.equal(r.get(10000),0,'old samples expire');
  const a=createActivity({platform:'linux'});
  a.sample({bytesUp:0,bytesDown:0});for(let i=0;i<20;i++)a.addTokens();
  await new Promise(res=>setTimeout(res,300));
  const s=a.sample({bytesUp:1e6,bytesDown:2e6});
  assert.ok(s.cpu>=0&&s.cpu<=100);assert.ok(s.ram.total>0&&s.ram.used>0);
  assert.ok(s.net.up>0&&s.net.down>s.net.up);assert.ok(s.tps>0);assert.ok(Array.isArray(s.gpus));
  assert.equal(createActivity({platform:'darwin'}).sample().gpus[0].shared,true,'Apple GPU memory is the RAM');
});
