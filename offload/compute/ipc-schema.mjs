// v0.4 IPC-01: zod schemas for every Compute Service message. Strict objects (unknown keys rejected), bounded
// strings and ids. Invalid messages are answered with a ProtocolError (or the connection is closed before
// authentication) — they never reach the dispatcher and never throw out of the socket handler.
import {z} from 'zod';
export const METHOD_NAMES=['compute','status','metrics','state','delegate','batch','auto','lease','release'];
const id=z.union([z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),z.string().min(1).max(64)]);
const errBody=z.object({name:z.string().max(60),message:z.string().max(4000)}).strict();
export const Hello=z.object({type:z.literal('hello'),protocol:z.number().int(),token:z.string().min(1).max(256),
  client:z.string().max(64).optional(),priority:z.enum(['interactive','background']).optional(),workspace:z.string().max(4096).nullable().optional(),
  scope:z.enum(['workspace','device']).optional()}).strict();   // v0.4 COMPUTE-02: 'device' = lease/metrics only, no workspace access
export const Call=z.object({type:z.literal('call'),id,method:z.enum(METHOD_NAMES),args:z.record(z.string(),z.unknown()).optional()}).strict();
export const Cancel=z.object({type:z.literal('cancel'),id}).strict();
export const ClientMessage=z.discriminatedUnion('type',[Call,Cancel]);
export const Welcome=z.object({type:z.literal('welcome'),protocol:z.number().int(),pid:z.number().int(),model:z.string().max(400).nullable(),workspace:z.boolean(),
  limits:z.record(z.string(),z.unknown()),fingerprint:z.string().max(128).nullable().optional()}).strict();
export const Result=z.object({type:z.literal('result'),id,ok:z.boolean(),result:z.unknown().optional(),error:errBody.optional()}).strict()
  .refine(m=>m.ok?m.error===undefined:m.error!==undefined,'ok/error mismatch');
export const ErrorMsg=z.object({type:z.literal('error'),error:errBody}).strict();
export const ServiceMessage=z.union([Welcome,Result,ErrorMsg]);
export const parse=(schema,line)=>{let v;try{v=JSON.parse(line);}catch{return {ok:false,error:'invalid JSON'};}
  const r=schema.safeParse(v);return r.success?{ok:true,value:r.data}:{ok:false,error:r.error.issues.slice(0,3).map(i=>(i.path.join('.')||'message')+': '+i.message).join('; ')};};
