// Adaptive Router: picks the cheapest level that can do the job.
//   Level 1 — deterministic algorithm (no LLM): search, symbols, references, deps, hash, stats, todo, outline.
//   Level 2 — local / LAN LLM via the Smart Context Engine.
//   Level 3 — leave it to the cloud agent (offloading would cost more, or local quality is unreliable).
// Inputs: task text, input size, local health/capacity, persisted per-kind stats, configured prices.
import {predictSavings} from './cost.mjs';
const IDENT=/`([^`]{1,120})`|"([^"]{1,120})"|'([^']{1,120})'|«([^»]{1,120})»/;
const ident=g=>{const m=IDENT.exec(g);if(m)return (m[1]||m[2]||m[3]||m[4]).trim();const w=/(?:^|\s)(?:of|for|named|called|функци[яюи]|метод[а]?|класс[а]?|символ[а]?)\s+([A-Za-z_$][\w$.]*)/i.exec(g);if(w)return w[1];const c=g.match(/\b([a-z]+[A-Z][\w$]*|[A-Z][a-z]+[A-Z][\w$]*|[a-z]+_[a-z_]+)\b/);return c?c[1]:null;};
export const L1_RULES=[
  // v0.3 (ROUTE-01): L1 needs an unambiguous structural question; the bare word "dependency" is not enough
  {op:'deps',re:/\b(who|what|which (files?|modules?))\b.{0,40}\b(imports?|depends on|requires)\b|\bimport graph\b|\b(circular|cyclic) (imports?|dependenc(y|ies))\b|\bimport cycles?\b|\bdependency graph\b|кто импортирует|граф (импортов|зависимостей)|циклическ\S* (импорт|зависимост)/i,
    args:(g,t)=>({path:t.paths?.[0]}),need:(a,g)=>/\b(who|what)\b.{0,40}\b(imports?|depends on|requires)\b|кто импортирует/i.test(g)?!!a.path:true},
  {op:'symbols',re:/\b(where|find)\b.{0,40}\b(defined|declared|definition)\b|\bdefinition of\b|где (определ|объявл)|определение/i,args:g=>({name:ident(g)}),need:'name'},
  {op:'references',re:/\b(references?|usages?|call sites?|callers)\b|\bwhere\b.{0,40}\bused\b|использовани|вызовы/i,args:g=>({name:ident(g)}),need:'name'},
  {op:'todo',re:/\b(todo|fixme)s?\b/i,args:()=>({})},
  {op:'hash',re:/\b(hash|checksum|sha-?256|digest)\b|хеш|контрольн/i,args:(g,t)=>(t.paths?.length?{paths:t.paths}:{})},
  {op:'stats',re:/\b(how many|count)\b.{0,20}\b(lines|files)\b|\bloc\b|\bline count\b|статистик|сколько строк/i,args:()=>({})},
  {op:'outline',re:/\b(outline|list (all )?(the )?(functions|classes|methods|symbols|exports))\b|структур[ау] файла/i,args:(g,t)=>({path:t.paths?.[0]}),need:'path'},
  {op:'search',re:/\b(grep|search for|find (all )?(occurrences|lines|matches)|occurrences of)\b|найди (строки|вхождения)/i,args:g=>({pattern:ident(g)}),need:'pattern'},
];
export function inferKind(t){
  const g=t.goal||'';
  if(t.kind)return t.kind;
  if(/\b(convert|rename|reformat|translate|rewrite)\b|преобразуй|переименуй/i.test(g))return 'transform';
  if(/\b(test|spec)s?\b|тест/i.test(g)&&/\b(write|draft|generate|create)\b|напиши|сгенерируй/i.test(g))return 'tests';
  if(/\b(doc|docs|documentation|readme|jsdoc|docstring)\b|документац/i.test(g))return 'documentation';
  if(/\b(review|bug|vulnerab|security|smell|issue)\b|ревью|уязвим|баг/i.test(g))return 'review';
  if(/\.log$/i.test(t.paths?.[0]||'')||/\b(log|logs|error|errors|fail(ed|ing|ure)?|stack ?trace|crash)\b|лог|ошибк/i.test(g))return 'logs';
  return 'summarize';
}
// Decisions that must stay with the primary agent (never delegated, not even with prefer:'local')
const SECURITY=/\b(security|vulnerab\w*|exploit\w*|cve-\d+|injection|xss|csrf|threat model|safe to (merge|deploy|ship|release|run)|is (it|this|that) safe|approve|sign[- ]?off|auth(entication|orization)? (bypass|flaw|bug))\b|безопасн|уязвим|можно ли (мерж|деплой|выкат|релиз)/i;
export function createRouter({engine,det,counter,pricing,stats,health,capacity=()=>1,minSavingsUsd=0,maxRouteMs=300000,tokensPerSec=400,minN=5,minTokens=2000,failPrior=0.1}){
  return {
    async decide(t,{signal}={}){
      const goal=String(t.goal||'');
      if(t.prefer!=='local'&&!t.contextAlreadyLoaded){   // QA-02 finding: an already-loaded file must not be re-sent even as an L1 result
        for(const r of L1_RULES){
          if(!r.re.test(goal))continue;
          if(!det){break;}
          const args=r.args(goal,t);
          if(typeof r.need==='function'?!r.need(args,goal):r.need&&!args[r.need])continue;
          return {level:1,op:r.op,args,reason:`deterministic: "${r.op}" answers this exactly, no LLM needed`};
        }
      }
      if(SECURITY.test(goal))return {level:3,reason:'security decision: it needs the primary agent with full context; a local draft is not evidence (prefer:"local" does not override this)',advice:'Do this yourself; you may still use kvalah_compute search to locate code.'};
      const kind=inferKind(t);
      if(t.contextAlreadyLoaded&&t.prefer!=='local')return {level:3,kind,reason:'the content is already in your context: offloading cannot save reading it again',advice:'Answer from your context.'};
      const h=await health();
      if(!h?.online)return {level:3,reason:'local model offline',advice:'Do this task yourself.'};
      const m=engine.metrics?.()||{};
      if((engine.maxPending&&m.pending>=engine.maxPending)||(engine.maxPendingCalls&&m.pendingCalls>=Math.ceil(engine.maxPendingCalls*0.75)))
        return {level:3,kind,reason:`local queue overloaded (${m.pending} requests, ${m.pendingCalls} model calls pending)`,advice:'Do this task yourself or retry later.'};
      // v0.4 ROUTE-01: files the agent already read are in its context — delegating them saves nothing
      const seen=new Set((Array.isArray(t.alreadyRead)?t.alreadyRead:[]).map(String));
      const fresh=t.paths?.filter(p=>!seen.has(p))||[];
      if(t.paths?.length&&!fresh.length&&!t.context&&t.prefer!=='local')return {level:3,kind,reason:'all files are already in your context (alreadyRead): offloading cannot save reading them again',advice:'Answer from your context.'};
      const sizes=fresh.length&&engine.readFiles?await engine.readFiles.sizes(fresh,{signal}):[];
      const fileTokens=sizes.reduce((n,s)=>n+Math.ceil(s.bytes/3.8),0); // cloud-side estimate (uncalibrated)
      const inlineTokens=t.context?counter.count(t.context):0;
      const s=stats?.get(`${kind}@${engine.model}`)||stats?.get(kind); // quality per kind+model, else per kind
      // v0.4 ROUTE-01: expected value. pFail = historic failure rate of this model for this kind (prior failPrior
      // until minN samples); on failure the agent pays the delegation AND does the work itself. Verification grows with
      // the share of findings that could not be verified (the agent re-checks them): 5% of the result + 50% × unverified.
      const pFail=s&&s.n>=minN?1-s.successRate:failPrior;
      const verifyFraction=0.05+(s&&s.n>=minN&&s.verifiedRatio!==null?0.5*(1-s.verifiedRatio):0);
      const est=predictSavings({fileTokens,inlineTokens,instructionTokens:counter.count(goal)+20,maxTokens:engine.maxTokens||2048,verifyFraction},pricing);
      // v0.4 ROUTE-02: MCP interaction overhead per delegated task = tool descriptions resent with the extra turn
      // (BENCH-05 accounting), weighted by the cached-input price ratio when prices are configured.
      const schemaTokens=Number(m.savings?.overhead?.toolSchemaTokens)||0;
      const cachedRatio=pricing.configured&&pricing.cachedInputPerM!=null&&pricing.inputPerM>0?pricing.cachedInputPerM/pricing.inputPerM:1;
      const mcpOverheadTokens=Math.round(schemaTokens*cachedRatio);
      const base=est.cloudTokens.without,cost=est.cloudTokens.withInput+est.cloudTokens.withOutput;
      const expectedNetTokens=Math.round((1-pFail)*base-cost);
      const expected={pFail:+pFail.toFixed(3),verifyTokens:est.cloudTokens.verify,baselineTokens:base,delegationTokens:cost,expectedNetTokens,mcpOverheadTokens,expectedNetAfterMcp:expectedNetTokens-mcpOverheadTokens,estimated:true};
      const budget=engine.budgets({kind,instruction:goal,query:t.query}).final;
      const chunks=Math.max(1,Math.ceil((fileTokens+inlineTokens)/budget));
      const perChunkMs=s?.avgMs??Math.ceil(((fileTokens+inlineTokens)/chunks)/tokensPerSec*1000+((engine.maxTokens||2048)/4)/40*1000);
      const etaMs=Math.ceil(chunks/Math.max(1,capacity()))*perChunkMs+(chunks>1?perChunkMs:0);
      const facts={kind,fileTokens:Math.round(fileTokens),inlineTokens,predictedSavedUsd:est.savedUsd,chunks,etaMs,stats:s,expected,...(seen.size?{alreadyRead:[...seen].slice(0,32)}:{})};
      if(t.prefer!=='local'){
        if(fileTokens+inlineTokens<minTokens)return {level:3,reason:`small input (~${fileTokens+inlineTokens} tokens < KVALAH_ROUTER_MIN_TOKENS=${minTokens}): read it directly`,advice:inlineTokens&&!fileTokens?'Inline context is already in your context.':'Read it directly.',...facts};
        if(est.netCloudTokensSaved<=0)return {level:3,reason:`offloading is predicted to cost more cloud tokens than it saves (${est.netCloudTokensSaved})`,advice:inlineTokens&&!fileTokens?'Inline context is already in your context; offloading it only adds output tokens.':'Input is small; read it directly.',...facts};
        if(pricing.configured&&est.savedUsd<=minSavingsUsd)return {level:3,reason:`offloading is predicted to cost more than doing it in the cloud (${est.savedUsd} USD)`,advice:inlineTokens&&!fileTokens?'Inline context is already in your context; offloading it only adds output tokens.':'Input is small; read it directly.',...facts};
        if(s&&s.n>=minN&&s.successRate<0.5)return {level:3,reason:`low local quality: model failed ${Math.round((1-s.successRate)*100)}% of recent "${kind}" tasks`,advice:'Do this task yourself.',...facts};
        if(s&&s.n>=minN&&s.verifiedRatio!==null&&s.verifiedRatio<0.3)return {level:3,reason:`only ${Math.round(s.verifiedRatio*100)}% of local "${kind}" findings were verifiable`,advice:'Do this task yourself.',...facts};
        if(expectedNetTokens<=0)return {level:3,reason:`expected saving is not positive (${expectedNetTokens} tokens) given a ${Math.round(pFail*100)}% failure rate and ${est.cloudTokens.verify} verification tokens`,advice:'Do this task yourself.',...facts};
        if(expectedNetTokens-mcpOverheadTokens<=0)return {level:3,reason:`MCP interaction overhead (~${mcpOverheadTokens} tokens of tool descriptions per delegated task) exceeds the expected saving (${expectedNetTokens} tokens)`,advice:'Do this task yourself.',...facts};
        if(etaMs>maxRouteMs&&!t.query)return {level:3,reason:`estimated ${Math.round(etaMs/1000)}s on local hardware (${chunks} chunks) exceeds ${maxRouteMs/1000}s`,advice:'Add a focus "query" or use kvalah_compute search to narrow the input first.',...facts};
      }
      return {level:2,kind,strategy:'auto',reason:`local model: predicted saving ${est.savedUsd} USD, ~${chunks} chunk(s), ETA ~${Math.round(etaMs/1000)}s`,...facts};
    }
  };
}
