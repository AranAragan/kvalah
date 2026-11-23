import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {LANGS,DICTS,match,tr,localesScript} from '../i18n.mjs';
import {mockModel,startApp,tempDir} from './helpers.mjs';

const ROOT=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=f=>fs.readFileSync(path.join(ROOT,f),'utf8');
const en=DICTS.en;
const placeholders=v=>[...new Set((typeof v==='object'?Object.values(v).join(' '):v).match(/\{\w+\}/g)||[])].sort();

test('every locale has exactly the keys of en, no empty values, matching placeholders and full plural forms',()=>{
  const files=fs.readdirSync(path.join(ROOT,'public','i18n')).filter(f=>f.endsWith('.json')).map(f=>f.slice(0,-5)).sort();
  assert.deepEqual(files,[...LANGS].sort(),'one dictionary per supported language');
  for(const lang of LANGS){
    const dict=DICTS[lang];
    assert.deepEqual(Object.keys(dict).sort(),Object.keys(en).sort(),lang+': same keys as en');
    const categories=new Intl.PluralRules(lang).resolvedOptions().pluralCategories;
    for(const [key,value] of Object.entries(dict)){
      if(typeof value==='object'){
        assert.equal(typeof en[key],'object',lang+'/'+key+': plural only where en is plural');
        for(const c of categories)assert.ok(typeof value[c]==='string'&&value[c].trim(),lang+'/'+key+': plural form "'+c+'"');
        for(const c of Object.keys(value))assert.ok(categories.includes(c),lang+'/'+key+': unexpected plural form "'+c+'"');
      }else assert.ok(typeof value==='string'&&value.trim(),lang+'/'+key+': non-empty');
      assert.deepEqual(placeholders(value),placeholders(en[key]),lang+'/'+key+': placeholders');
    }
    assert.ok(!JSON.stringify(dict).includes('⟦'),lang+': no missing-key markers');
  }
});

test('all keys used in code exist, and every dictionary key is used',()=>{
  const used=new Set();
  const add=(re,text)=>{for(const m of text.matchAll(re))used.add(m[1]);};
  const app=read('public/app.js'),html=read('public/index.html');
  add(/\b(?:t|statusT)\('([\w.]+)'/g,app);
  add(/t\([^()]*?\?'([\w.]+)':'([\w.]+)'/g,app);
  for(const m of app.matchAll(/'([a-z]+[A-Z]?\w*\.[\w.]+)'/g))if(en[m[1]]!==undefined||/^(project|chat|settings|approval|status|done|tool|toolState|check|file|files|error|message|composer|mode|agent|caption|connection|device|history|trash|change|checkpoint|voice|units|stats|copy|lang|common|sidebar|header|model|models|busy|welcome|delete)\./.test(m[1]))used.add(m[1]);
  add(/data-i18n(?:-[a-z]+)?="([\w.]+)"/g,html);add(/data-i18n(?:-[a-z]+)?=\\?"([\w.]+)\\?"/g,app);add(/dataset\.i18n='([\w.]+)'/g,app);
  for(const f of ['server.mjs','providers.mjs','storage.mjs'])add(/\btr\('([\w.]+)'/g,read(f));
  const server=read('server.mjs');add(/tr\([^()]*?\?'([\w.]+)':'([\w.]+)'/g,server);
  for(const m of server.matchAll(/tr\(\w+\?'([\w.]+)':'([\w.]+)'\)/g)){used.add(m[1]);used.add(m[2]);}
  const desktop=read('desktop.cjs');add(/\bL\('([\w.]+)'/g,desktop);add(/L\([^()]*?\?'([\w.]+)':'([\w.]+)'/g,desktop);
  for(const m of (app+server+desktop).matchAll(/\?'([a-z]\w*\.[\w.]+)':'([a-z]\w*\.[\w.]+)'/g)){used.add(m[1]);used.add(m[2]);}
  // Keys built from a prefix at runtime.
  const tools=JSON.parse(app.match(/const TOOL_NAMES=(\[[^\]]+\])/)[1].replace(/'/g,'"'));
  for(const name of tools)used.add('tool.'+name);
  for(const p of ['inspect','implement','verified','blocked','completed'])used.add('phase.'+p);
  for(const r of ['awaiting_verification','step_limit','repeated_error','denied','length','completed'])used.add('done.'+r);
  for(const m of ['ask','auto','full'])used.add('approvalHint.'+m);
  used.add('lang.name');
  const missing=[...used].filter(k=>en[k]===undefined&&!k.endsWith('.')&&k!=='chat.json'&&/\./.test(k)&&!/^(kvalah|local-codex|window|data\.)/.test(k));
  assert.deepEqual(missing,[],'keys used in code but missing in dictionaries');
  const unused=Object.keys(en).filter(k=>!used.has(k));
  assert.deepEqual(unused,[],'dictionary keys never used');
  // No hard-coded Cyrillic left in UI code.
  for(const f of ['public/app.js','public/index.html','providers.mjs','storage.mjs','desktop.cjs','updater.cjs','preload.cjs'])assert.ok(!/[А-Яа-яЁё]/.test(read(f)),f+' has no hard-coded Russian');
});

test('OS language matching is identical in the page, the server and the desktop shell',()=>{
  const window={};const sandbox={window,document:{documentElement:{},querySelectorAll:()=>[]},Intl};
  vm.runInNewContext(localesScript()+read('public/i18n.js'),sandbox);
  const desktopSrc=read('desktop.cjs');
  const desktopMatch=new Function('LANGS',desktopSrc.match(/function matchLanguage\(tags\)\{[\s\S]*?\n\}/)[0]+'\nreturn matchLanguage;')(LANGS);
  const cases=[[['ru-RU'],'ru'],[['uk-UA','ru'],'uk'],[['de-AT'],'de'],[['pt-PT'],'pt-BR'],[['pt'],'pt-BR'],[['zh-TW'],'zh-CN'],[['zh-Hans-CN'],'zh-CN'],[['be-BY'],'ru'],[['kk-KZ'],'ru'],[['ko-KR','fr-CA'],'fr'],[['ko-KR'],'en'],[['en-GB'],'en'],[['ja_JP'],'ja'],[['tr'],'tr'],[['es-419'],'es'],[[],'en']];
  for(const [tags,expected] of cases){
    assert.equal(match(tags),expected,'server '+tags);
    assert.equal(window.kvI18n.match(tags),expected,'page '+tags);
    assert.equal(desktopMatch(tags),expected,'desktop '+tags);
  }
  const k=window.kvI18n;k.setLang('ru');
  assert.equal(k.t('device.models',{n:1}),'1 модель');assert.equal(k.t('device.models',{n:3}),'3 модели');assert.equal(k.t('device.models',{n:5}),'5 моделей');
  assert.equal(k.t('settings.contextTokens',{n:8192}),'8\u00a0192 токена');
  k.setLang('en');assert.equal(k.t('device.models',{n:1}),'1 model');assert.equal(k.t('device.models',{n:2}),'2 models');
  k.setLang('ja');assert.equal(k.t('device.models',{n:2}),'2 個のモデル');
  k.setLang('de');assert.equal(k.t('no.such.key'),'⟦no.such.key⟧','missing keys are visible');
  assert.equal(tr('srv.stepLimit',{n:24},'uk'),DICTS.uk['srv.stepLimit'].few.replace('{n}','24'));
});

test('language setting: persisted, drives server messages and the reply-language instruction',async()=>{
  const root=await tempDir(),data=path.join(root,'data'),workspace=path.join(root,'ws');fs.mkdirSync(workspace,{recursive:true});
  const seen=[];const model=await mockModel(async(url,body)=>{seen.push(body);return {content:'ok'};});
  let app;
  try{
    app=await startApp({modelUrl:model.url,data,workspace,env:{KVALAH_LANG:'de-DE'}});
    const state=(await app.api('/api/state')).body;assert.equal(state.settings.language,undefined,'nothing chosen yet');
    const chat=(await app.api('/api/chats',{})).body;assert.equal(chat.title,'Neuer Chat','server default follows the OS language');
    const bundle=await fetch(app.origin+'/i18n/locales.js');assert.equal(bundle.status,200);assert.match(await bundle.text(),/KV_LOCALES/);
    assert.equal((await app.api('/api/language',{language:'xx'})).status,400);
    const saved=(await app.api('/api/language',{language:'fr',source:'user'})).body;assert.equal(saved.language,'fr');assert.equal(saved.languageSource,'user');
    const empty=await app.api('/api/chat',{chatId:chat.id,text:'',model:'mock:latest',agent:false});assert.equal(empty.body.error,'Message vide');
    await app.turn({chatId:chat.id,text:'Bonjour',model:'mock:latest',agent:false});
    assert.match(seen.at(-1).messages[0].content,/^You are a local assistant\. Always reply in French/);
    assert.equal((await app.api('/api/state')).body.chats[0].title,'Bonjour','default title in any language is replaced');
    const settingsFile=JSON.parse(fs.readFileSync(path.join(data,'settings.json'),'utf8'));assert.equal(settingsFile.language,'fr');
    const s=(await app.api('/api/state')).body.settings;
    await app.api('/api/settings',{workspace,context:16384,maxSteps:8,thinking:false,model:'mock:latest',replyLanguage:'auto'});
    await app.turn({chatId:chat.id,text:'Hola',model:'mock:latest',agent:false});
    assert.match(seen.at(-1).messages[0].content,/language of the user's latest message/);
    assert.equal((await app.api('/api/settings',{workspace,context:16384,maxSteps:8,replyLanguage:'xx'})).status,400);
    assert.equal(s.languageSource,'user');
  }finally{await app?.stop();await model.close();}
});
