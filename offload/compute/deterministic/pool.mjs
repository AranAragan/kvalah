// CPU-01: deterministic ops run in ONE persistent worker thread (keeps the outline cache warm) with
//   * a per-op time limit (KVALAH_DET_TIMEOUT_MS, default 20 s) and V8 heap limit (KVALAH_DET_MEMORY_MB, 256),
//   * cancellation by terminating the worker (a regex or parser cannot be interrupted any other way),
//   * a FIFO queue (ops are serialized; status/dashboard stay on the free main thread).
// A terminated worker is replaced lazily on the next op.
import {Worker} from 'node:worker_threads';
import {OPS} from './index.mjs';
const named=(name,msg)=>Object.assign(Error(msg),{name});
export function createDeterministicPool({reader,timeoutMs=20000,memoryMb=256}){
  if(!reader)return null;
  let worker=null,seq=0,current=null;const queue=[];
  const st={started:0,terminated:0,timeouts:0,cancelled:0,completed:0,failed:0};
  function spawn(){
    worker=new Worker(new URL('./worker.mjs',import.meta.url),{workerData:{reader:{root:reader.root}},resourceLimits:{maxOldGenerationSizeMb:memoryMb,maxYoungGenerationSizeMb:Math.min(64,memoryMb/4)}});
    st.started++;
    worker.on('message',m=>{if(current&&m.id===current.id){const c=current;current=null;c.finish(m);pump();}});
    worker.on('error',e=>{const c=current;current=null;worker=null;if(c){st.failed++;c.reject(named('DeterministicWorkerError','Deterministic worker failed: '+(e?.message||e)+(/memory|heap/i.test(String(e?.message))?' (memory limit KVALAH_DET_MEMORY_MB)':'')));}pump();});
    worker.on('exit',()=>{if(worker&&!current)worker=null;});
    worker.unref(); // after the listeners: attaching 'message' re-refs the port; an idle worker must not keep the process alive
  }
  function kill(reason){const w=worker;worker=null;st.terminated++;w?.terminate().catch(()=>{});}
  function pump(){
    if(!current&&!queue.length){worker?.unref();return;}
    if(current)return;
    const job=queue.shift();
    if(job.signal?.aborted){job.reject(job.signal.reason instanceof Error?job.signal.reason:named('AbortError','Cancelled'));return pump();}
    if(!worker)spawn();
    current=job;worker.ref(); // busy: keep the process alive until the op settles
    const timer=setTimeout(()=>{if(current!==job)return;current=null;st.timeouts++;kill('timeout');job.reject(named('DeterministicTimeoutError',`Deterministic op "${job.op}" exceeded the ${timeoutMs}ms time limit and was stopped (KVALAH_DET_TIMEOUT_MS). Use a literal pattern or narrow glob.`));pump();},timeoutMs);
    const onAbort=()=>{if(current!==job)return;current=null;st.cancelled++;kill('cancel');job.reject(job.signal.reason instanceof Error?job.signal.reason:named('AbortError','Cancelled'));pump();};
    job.signal?.addEventListener('abort',onAbort,{once:true});
    job.finish=(m)=>{clearTimeout(timer);job.signal?.removeEventListener('abort',onAbort);if(m.ok){st.completed++;job.resolve(m.value);}else{st.failed++;job.reject(named(m.name||'Error',m.error));}};
    const _rej=job.reject;job.reject=e=>{clearTimeout(timer);job.signal?.removeEventListener('abort',onAbort);_rej(e);};
    worker.postMessage({id:job.id,op:job.op,args:job.args});
  }
  return {
    ops:OPS,
    run(op,args={},{signal}={}){
      if(!OPS.includes(op))return Promise.reject(Error('Unknown op; expected one of '+OPS.join(', ')));
      signal?.throwIfAborted();
      return new Promise((resolve,reject)=>{
        const job={id:++seq,op,args:JSON.parse(JSON.stringify(args??{})),signal,resolve,reject};
        // cancelled while still queued: drop it without touching the running op
        signal?.addEventListener('abort',()=>{const i=queue.indexOf(job);if(i>=0){queue.splice(i,1);st.cancelled++;reject(signal.reason instanceof Error?signal.reason:named('AbortError','Cancelled'));}},{once:true});
        queue.push(job);pump();
      });
    },
    stats(){return {...st,queued:queue.length,running:current?current.op:null,timeoutMs,memoryMb};},
    async close(){for(const j of queue.splice(0))j.reject(named('AbortError','Shutting down'));if(current){const c=current;current=null;c.reject(named('AbortError','Shutting down'));}const w=worker;worker=null;await w?.terminate().catch(()=>{});}
  };
}
