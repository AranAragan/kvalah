import {encode} from '../protocol/safetensors.mjs';
import {hashJSON,sha256} from '../protocol/hash.mjs';
import {fail} from '../protocol/errors.mjs';
import {validateTensors} from './registry.mjs';

const algorithms=new Set(['fedavg','fedavgm','fedadam','fedyogi','fedprox','diloco']);

// The coordinator supplies the immutable assignment records, including token weights derived from
// masks. Update declarations alone cannot pick the expert, parent, worker, or aggregation weight.
export function aggregateExpert({expert,base,round,assignments,updates,previousState=null,maxNorm=1024}){
  const method=round.algorithm;
  const config=round.config??{};
  const lr=config.lr??(method==='fedavgm'?1:0.1),beta1=config.beta1??0.9,beta2=config.beta2??0.99,eps=config.eps??1e-3;
  if(!algorithms.has(method)||!round.id||!Number.isFinite(lr)||lr<=0||lr>10||!(beta1>=0&&beta1<1)||!(beta2>=0&&beta2<1)||
    !(eps>0&&eps<=1)||!Number.isFinite(maxNorm)||maxNorm<=0)fail('INVALID_SCHEMA','invalid expert aggregation configuration');
  if(method==='fedprox'&&!(Number.isFinite(config.mu)&&config.mu>0))fail('INVALID_SCHEMA','FedProx requires a proximal objective');
  const digest=sha256(base);
  if(!expert.checkpoint||digest!==expert.checkpoint.hash||expert.checkpoint.hash!==round.parent||round.expert!==expert.id||
    round.schema!==expert.schema_sha256||round.frozen!==expert.checkpoint.frozen)fail('CONFLICT','expert round ancestry mismatch');
  const configDigest=hashJSON({algorithm:method,config});
  if(previousState&&(previousState.algorithm!==method||previousState.config!==configDigest||previousState.parent!==round.parent||previousState.expert!==expert.id))
    fail('CONFLICT','outer optimizer state belongs to another checkpoint');
  const target=new Map(assignments.map(a=>[a.id,a]));
  if(!updates.length||target.size!==assignments.length)fail('INVALID_SCHEMA','missing updates or duplicate assignments');
  const baseTensors=validateTensors(base,expert.tensors);
  const active=expert.tensors.filter(t=>t.trainable);
  const seen=new Set(),devices=new Set(),groups=new Map();
  let total=0;
  const ordered=[...updates].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  for(const u of ordered){
    const a=target.get(u.id);
    if(!a||seen.has(u.id)||devices.has(u.device)||u.device!==a.device||u.round!==round.id||u.expert!==expert.id||u.parent!==round.parent||
      u.schema!==round.schema||u.frozen!==round.frozen||u.config!==configDigest||u.payload_sha256!==sha256(u.payload)||
      a.tokens!==u.tokens||!Number.isSafeInteger(a.tokens)||a.tokens<=0||typeof a.group!=='string')fail('CONFLICT','expert update does not match its assignment');
    seen.add(u.id);devices.add(u.device);
    const tensors=validateTensors(u.payload,active);
    let norm2=0;
    for(const t of active){
      const from=baseTensors[t.name].data,to=tensors[t.name].data;
      for(let i=0;i<from.length;i++)norm2+=(from[i]-to[i])**2;
    }
    if(!Number.isFinite(norm2)||Math.sqrt(norm2)>maxNorm)fail('INVALID_TENSOR','expert update exceeds norm limit');
    const group=groups.get(a.group)??{tokens:0,sums:Object.fromEntries(active.map(t=>[t.name,new Float64Array(tensors[t.name].data.length)]))};
    group.tokens+=a.tokens;total+=a.tokens;
    if(!Number.isSafeInteger(total))fail('INVALID_SCHEMA','supervised token overflow');
    for(const t of active){
      const data=tensors[t.name].data,out=group.sums[t.name];
      for(let i=0;i<out.length;i++)out[i]+=a.tokens*data[i];
    }
    groups.set(a.group,group);
  }
  const quorum=round.min_devices??1;
  if(!Number.isSafeInteger(quorum)||quorum<1||devices.size<quorum)fail('UNAVAILABLE','expert quorum not reached');
  const result={...baseTensors},moments={},squares={};
  const sequences=[...groups].sort(([a],[b])=>a<b?-1:a>b?1:0);
  for(const t of active){
    const old=baseTensors[t.name].data,data=new Float32Array(old.length);
    const momentum=new Float64Array(old.length),variance=new Float64Array(old.length);
    const last=previousState?.moments?.[t.name],lastVariance=previousState?.squares?.[t.name];
    if(previousState&&(!last||!lastVariance||last.length!==old.length||lastVariance.length!==old.length))fail('INVALID_SCHEMA','outer optimizer state shape mismatch');
    for(let i=0;i<data.length;i++){
      let sum=0;
      for(const [,g] of sequences)sum+=g.sums[t.name][i];
      if(method==='fedavg'||method==='fedprox'){data[i]=sum/total;continue;}
      // Average client endpoint weights first, then run the outer optimizer once globally.
      const gradient=old[i]-sum/total;
      const oldM=last?.[i]??0,oldV=lastVariance?.[i]??0;
      if(!Number.isFinite(oldM)||!Number.isFinite(oldV)||oldV<0)fail('INVALID_SCHEMA','invalid outer optimizer moment');
      if(method==='fedavgm'||method==='diloco'){
        momentum[i]=beta1*oldM+gradient;
        const direction=method==='diloco'?gradient+beta1*momentum[i]:momentum[i];
        data[i]=old[i]-lr*direction;
      }else{
        momentum[i]=beta1*oldM+(1-beta1)*gradient;
        const squared=gradient*gradient;
        variance[i]=method==='fedadam'?beta2*oldV+(1-beta2)*squared:oldV-(1-beta2)*Math.sign(oldV-squared)*squared;
        data[i]=old[i]-lr*momentum[i]/(Math.sqrt(variance[i])+eps);
      }
      if(!Number.isFinite(data[i]))fail('NONFINITE','outer optimizer produced a non-finite checkpoint');
    }
    result[t.name]={shape:t.shape,data};moments[t.name]=momentum;squares[t.name]=variance;
  }
  const payload=encode(result),parent=sha256(payload);
  return {payload,state:{algorithm:method,config:configDigest,parent,expert:expert.id,moments,squares},
    metrics:{total_tokens:total,updates:ordered.map(u=>u.id),groups:Object.fromEntries(sequences.map(([g,v])=>[g,v.tokens]))}};
}
