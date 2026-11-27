import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeZip} from '../compute/zip.mjs';
import {sha256} from '../compute/protocol/hash.mjs';

const output=process.argv[2];
if(!output)throw Error('node scripts/fusion-audit.mjs <output.zip>');
const root=fileURLToPath(new URL('../',import.meta.url));
const reports=path.join(root,'docs','compute','fusion');
const reportNames=['EXPERT_FUSION_ARCHITECTURE','MODEL_ARCHITECTURE','EXPERT_REGISTRY','ROUTER_DESIGN','FFN_EXPERTS','LOOP_TRANSFORMER',
  'DYNAMIC_EXPANSION','DISTRIBUTED_PIPELINE','FEDERATED_MESH','AUTO_PROVISIONING','P2P_DISTRIBUTION','SECURITY_REPORT',
  'PERFORMANCE_REPORT','QUALITY_REPORT','SCALABILITY_REPORT','HARDWARE_COMPATIBILITY','USER_GUIDE','MIGRATION_GUIDE',
  'TEST_REPORT','EXECUTIVE_SUMMARY'].map(name=>name+'.md');
const measurementNames=['reference-results.json','reference-manifest.json','reference-overview.png','validation.csv','scalability.csv','scale.jsonl'];
const scriptNames=['fusion-audit.mjs','fusion-plot.py','fusion-simulate.mjs','fusion-desktop-smoke.mjs'];
const entries=[['CHANGELOG.md',fs.readFileSync(path.join(root,'CHANGELOG.md'))]];
for(const name of reportNames)entries.push(['reports/'+name,fs.readFileSync(path.join(reports,name))]);
for(const name of measurementNames)entries.push(['measurements/'+name,fs.readFileSync(path.join(reports,'measurements',name))]);
for(const name of scriptNames)entries.push(['scripts/'+name,fs.readFileSync(path.join(root,'scripts',name))]);
entries.push(['SHA256SUMS',Buffer.from(entries.map(([n,b])=>sha256(b)+'  '+n).join('\n')+'\n')]);
const archive=writeZip(entries);
if(archive.length>30e6)throw Error('audit archive exceeds 30 MB');
fs.mkdirSync(path.dirname(output),{recursive:true});
fs.writeFileSync(output,archive,{flag:'wx'});
console.log(JSON.stringify({entries:entries.length,bytes:archive.length,sha256:sha256(archive)}));
