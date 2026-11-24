// v0.4 BENCH-03: normalize provider usage reports to one shape without double counting.
//   {input: uncached input, cachedInput: cache reads, cacheWrite: cache creation, output: visible output, reasoning}
// Provider semantics (see docs/V04-REPORT.md, BENCH-03, for the documentation links):
//   openai-chat       prompt_tokens INCLUDES prompt_tokens_details.cached_tokens; completion_tokens INCLUDES
//                     completion_tokens_details.reasoning_tokens.
//   openai-responses  input_tokens INCLUDES input_tokens_details.cached_tokens; output_tokens INCLUDES
//                     output_tokens_details.reasoning_tokens.
//   anthropic         input_tokens EXCLUDES cache_read_input_tokens and cache_creation_input_tokens (reported
//                     separately); output_tokens includes extended-thinking tokens (no separate count → reasoning 0).
//   gemini            promptTokenCount INCLUDES cachedContentTokenCount; thoughtsTokenCount and toolUsePromptTokenCount
//                     are NOT part of candidatesTokenCount / promptTokenCount (totalTokenCount = sum of the four).
//   normalized        already in the shape above.
const n=v=>{if(v===undefined||v===null)return 0;const x=Number(v);if(!Number.isFinite(x)||x<0)throw new Error('usage: invalid token count '+JSON.stringify(v));return x;};
const out=(input,cachedInput,cacheWrite,output,reasoning,fmt)=>{
  if(input<0||output<0)throw new Error(`usage (${fmt}) is inconsistent: a subset is larger than its total`);
  return {input,cachedInput,cacheWrite,output,reasoning};
};
export const USAGE_FORMATS=['openai-chat','openai-responses','anthropic','gemini','normalized'];
export function normalizeUsage(u,format='normalized'){
  if(!u||typeof u!=='object')throw new Error('usage: object expected');
  switch(format){
    case 'openai-chat':{const cached=n(u.prompt_tokens_details?.cached_tokens),reasoning=n(u.completion_tokens_details?.reasoning_tokens);
      return out(n(u.prompt_tokens)-cached,cached,0,n(u.completion_tokens)-reasoning,reasoning,format);}
    case 'openai-responses':{const cached=n(u.input_tokens_details?.cached_tokens),reasoning=n(u.output_tokens_details?.reasoning_tokens);
      return out(n(u.input_tokens)-cached,cached,0,n(u.output_tokens)-reasoning,reasoning,format);}
    case 'anthropic':return out(n(u.input_tokens),n(u.cache_read_input_tokens),n(u.cache_creation_input_tokens),n(u.output_tokens),0,format);
    case 'gemini':{const cached=n(u.cachedContentTokenCount);   // toolUsePromptTokenCount is input outside promptTokenCount
      const o=out(n(u.promptTokenCount)-cached,cached,0,n(u.candidatesTokenCount),n(u.thoughtsTokenCount),format);o.input+=n(u.toolUsePromptTokenCount);return o;}
    case 'normalized':return out(n(u.input),n(u.cachedInput),n(u.cacheWrite),n(u.output),n(u.reasoning),format);
  }
  throw new Error('unknown usage format: '+String(format).slice(0,40)+' (expected '+USAGE_FORMATS.join(', ')+')');
}
export const addUsage=(a,b)=>({input:a.input+(b.input||0),cachedInput:a.cachedInput+(b.cachedInput||0),cacheWrite:a.cacheWrite+(b.cacheWrite||0),output:a.output+(b.output||0),reasoning:a.reasoning+(b.reasoning||0)});
export const ZERO_USAGE=Object.freeze({input:0,cachedInput:0,cacheWrite:0,output:0,reasoning:0});
