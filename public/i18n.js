// Interface localization. Dictionaries live in /i18n/<lang>.json; the server bundles them into
// /i18n/locales.js (window.KV_LOCALES) so t() works synchronously from the first paint.
(function(){
  const LANGS=['ru','en','uk','de','fr','es','pt-BR','zh-CN','tr','ja'];
  const SHORT={ru:'RU',en:'EN',uk:'UK',de:'DE',fr:'FR',es:'ES','pt-BR':'PT','zh-CN':'中文',tr:'TR',ja:'日本'};
  const SPEECH={ru:'ru-RU',en:'en-US',uk:'uk-UA',de:'de-DE',fr:'fr-FR',es:'es-ES','pt-BR':'pt-BR','zh-CN':'zh-CN',tr:'tr-TR',ja:'ja-JP'};
  const dicts=window.KV_LOCALES||{};
  let lang='en';
  // Maps OS/browser language tags to the nearest supported interface language.
  function match(tags){
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
  const number=n=>typeof n==='number'?new Intl.NumberFormat(lang).format(n):String(n);
  function t(key,params={}){
    let value=dicts[lang]?.[key]??dicts.en?.[key];
    if(value===undefined)return '⟦'+key+'⟧';
    if(typeof value==='object'){const n=Number(params.n??0);value=value[new Intl.PluralRules(lang).select(n)]??value.other;}
    return value.replace(/\{(\w+)\}/g,(m,name)=>name in params?(name==='n'?number(params.n):String(params[name])):m);
  }
  // Static markup: data-i18n (text), data-i18n-html, and data-i18n-<attribute>="key" pairs.
  function apply(root=document){
    for(const el of root.querySelectorAll('[data-i18n]'))el.textContent=t(el.dataset.i18n);
    for(const el of root.querySelectorAll('[data-i18n-html]'))el.innerHTML=t(el.dataset.i18nHtml);
    for(const [attr,data] of [['title','i18nTitle'],['aria-label','i18nAria'],['placeholder','i18nPlaceholder'],['alt','i18nAlt'],['data-prompt','i18nPrompt']])
      for(const el of root.querySelectorAll('[data-'+data.replace(/[A-Z]/g,c=>'-'+c.toLowerCase())+']'))el.setAttribute(attr,t(el.dataset[data]));
  }
  function setLang(value){lang=LANGS.includes(value)?value:'en';document.documentElement.lang=lang;return lang;}
  window.kvI18n={LANGS,SHORT,match,t,apply,setLang,number,get lang(){return lang;},get speech(){return SPEECH[lang];},name:l=>dicts[l]?.['lang.name']||l};
  window.t=t;
})();
