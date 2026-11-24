// Worker-thread host for the deterministic executor (CPU-01). The main thread (MCP, status, dashboard)
// never runs user regexes, parsing or graph building; a stuck op is killed by terminating this thread.
import {parentPort,workerData} from 'node:worker_threads';
import {createFileReader} from '../files.mjs';
import {createDeterministic} from './index.mjs';
const det=createDeterministic({reader:createFileReader(workerData.reader)});
parentPort.on('message',async({id,op,args})=>{
  try{parentPort.postMessage({id,ok:true,value:await det.run(op,args)});}
  catch(e){parentPort.postMessage({id,ok:false,error:String(e?.message||e),name:e?.name});}
});
