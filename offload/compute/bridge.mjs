// Resolves kvalah's own modules when overlaid into a kvalah checkout (or KVALAH_HOME is set),
// otherwise falls back to the vendored/lite copies so the npm package runs standalone.
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
export function kvalahHome(env=process.env){
  // KVALAH_HOME, then package root (files merged into the kvalah repo), then its parent (package in kvalah/offload/)
  const candidates=[env.KVALAH_HOME,path.resolve(here,'..'),path.resolve(here,'..','..')].filter(Boolean);
  return candidates.find(d=>existsSync(path.join(d,'providers.mjs'))&&existsSync(path.join(d,'scheduler.mjs')))||null;
}
export async function loadKvalah(env=process.env){
  const home=env.KVALAH_STANDALONE==='1'?null:kvalahHome(env);
  const imp=f=>import(pathToFileURL(path.join(home,f)).href);
  if(home){
    const [providers,scheduler,nodes]=await Promise.all([imp('providers.mjs'),imp('scheduler.mjs'),existsSync(path.join(home,'nodes.mjs'))?imp('nodes.mjs'):import('./vendor/nodes.mjs')]);
    return {mode:'overlay',home,...pick(providers,scheduler,nodes)};
  }
  const [providers,scheduler,nodes]=await Promise.all([import('./providers-lite.mjs'),import('./vendor/scheduler.mjs'),import('./vendor/nodes.mjs')]);
  return {mode:'standalone',home:null,...pick(providers,scheduler,nodes)};
}
// v0.4 SEC-02: model requests always go through the guarded lite providers (no redirects, loopback pinned),
// also in overlay mode — kvalah's providers.mjs uses fetch() with default redirect following. Overlay still
// shares kvalah's scheduler and node registry. (Contract change, documented in CHANGELOG 0.4.0.)
import {ollamaProvider as liteOllama,openaiProvider as liteOpenai} from './providers-lite.mjs';
import {localFetch} from './netpolicy.mjs';
const lf=localFetch();
export const guardedOllama=(url,o={})=>liteOllama(url,{fetchImpl:lf,...o});
export const guardedOpenai=(url,key='',o={})=>liteOpenai(url,key,{fetchImpl:lf,...o});
const pick=(p,s,n)=>({ollamaProvider:guardedOllama,openaiProvider:guardedOpenai,createScheduler:s.createScheduler,createRegistry:n.createRegistry,overlayProviders:p!==null&&p?.ollamaProvider!==liteOllama});
