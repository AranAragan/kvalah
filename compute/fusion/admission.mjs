const MiB=1024**2;

// Estimate a full step at the admitted context. Accumulation backpropagates one row at
// a time, so grad_accum does not multiply the live activation estimate.
export function fusionFootprint(expert,{backend,context,modelLayout,observedBase=0}){
  const {width,layers,parameters}=expert.base;
  const inner=expert.tensors.find(t=>t.name.endsWith('.gate.weight'))?.shape[0]??expert.rank;
  const text=modelLayout?.textParameters??parameters;
  const vocab=modelLayout?.vocab??131072;
  const baseInner=modelLayout?.intermediate??width*4;
  const dense=Math.min(text,2*vocab*width);
  const quantized=backend==='cuda'||backend==='mlx';
  const baseline=quantized?(text-dense)*.65+(parameters-text+dense)*2:parameters*4;
  const backbone=Math.max(Math.ceil(baseline),observedBase);
  const weights=expert.bytes;
  const gradients=expert.tensors.filter(t=>t.trainable).reduce((n,t)=>n+4*t.shape.reduce((a,b)=>a*b,1),0);
  const adam=expert.training.optimizer==='adamw';
  const optimizer=adam?2*gradients:0;
  const depth=layers-Math.min(...expert.layers);
  const activations=4*context*(depth*(10*width+6*baseInner)+expert.layers.length*(4*inner+2*width)+3*vocab);
  const temporary=256*MiB+Math.max(quantized?2*baseInner*width:0,4*inner*width)+(adam?gradients:0);
  const training=weights+gradients+optimizer+activations+temporary;
  const staging=2*1024*MiB+2*weights+gradients;
  return {backbone,weights,gradients,optimizer,activations,temporary,
    ram:backend==='cuda'?staging:staging+backbone+training,vram:backend==='cuda'?backbone+training:0};
}

export function fitsFusionMemory(requirements,freeRam,freeVram,resident=0,backend){
  const credit=Math.min(requirements.backbone,Math.max(0,resident));
  return Number.isFinite(freeRam)&&freeRam>=requirements.ram-(backend==='cuda'?0:credit)&&
    (!requirements.vram||(Number.isFinite(freeVram)&&freeVram>=requirements.vram-credit));
}
