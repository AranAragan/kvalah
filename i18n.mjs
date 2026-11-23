// Server-side localization: the same dictionaries as the UI (public/i18n/*.json).
// Only user-facing messages are translated; prompts and tool results for the model stay as they are.
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const LANGS=['ru','en','uk','de','fr','es','pt-BR','zh-CN','tr','ja'];
// English names are used inside the (English) system prompt.
export const ENGLISH_NAMES={ru:'Russian',en:'English',uk:'Ukrainian',de:'German',fr:'French',es:'Spanish','pt-BR':'Brazilian Portuguese','zh-CN':'Simplified Chinese',tr:'Turkish',ja:'Japanese'};
const DIR=path.join(path.dirname(fileURLToPath(import.meta.url)),'public','i18n');
export const DICTS=Object.fromEntries(LANGS.map(l=>{try{return [l,JSON.parse(readFileSync(path.join(DIR,l+'.json'),'utf8'))];}catch{return [l,{}];}}));
let current='ru';

export function match(tags){
  for(const raw of [].concat(tags||[])){
    const tag=String(raw||'').replace('_','-').toLowerCase();if(!tag)continue;
    const exact=LANGS.find(l=>l.toLowerCase()===tag);if(exact)return exact;
    const base=tag.split('-')[0];
    if(base==='pt')return 'pt-BR';
    if(base==='zh')return 'zh-CN';
    if(base==='be'||base==='kk')return 'ru';
    const near=LANGS.find(l=>l.split('-')[0]===base);if(near)return near;
  }
  return 'en';
}
export function setLanguage(lang){current=LANGS.includes(lang)?lang:current;return current;}
export function getLanguage(){return current;}
export function tr(key,params={},lang=current){
  let value=DICTS[lang]?.[key]??DICTS.en?.[key];
  if(value===undefined)return key;
  if(typeof value==='object'){const n=Number(params.n??0);value=value[new Intl.PluralRules(lang).select(n)]??value.other;}
  return value.replace(/\{(\w+)\}/g,(m,name)=>name in params?(name==='n'&&typeof params.n==='number'?new Intl.NumberFormat(lang).format(params.n):String(params[name])):m);
}
// Every translation of a key, e.g. to recognise the default chat title in any language.
export function allValues(key){return new Set(LANGS.map(l=>DICTS[l]?.[key]).filter(v=>typeof v==='string'));}
// Bundle served as /i18n/locales.js so the page has all dictionaries before app.js runs.
export function localesScript(){return 'window.KV_LOCALES='+JSON.stringify(DICTS).replace(/</g,'\\u003c')+';\n';}
