// Structure extraction. JS/TS via @babel/parser (error-recovering, TS + JSX); other languages via
// conservative line regexes. Pure algorithms, no LLM.
import {parse} from '@babel/parser';
export const JS_EXT=/\.(m?js|cjs|jsx|ts|tsx|mts|cts)$/i;
const isTS=p=>/\.(ts|tsx|mts|cts)$/i.test(p);
export function parseJS(text,file='x.js'){
  const plugins=[isTS(file)?'typescript':null,/\.(jsx|tsx|js|mjs|cjs)$/i.test(file)?'jsx':null,['decorators',{decoratorsBeforeExport:true}]].filter(Boolean);
  return parse(text,{sourceType:'unambiguous',errorRecovery:true,allowReturnOutsideFunction:true,allowImportExportEverywhere:true,plugins});
}
const nameOf=n=>n?.type==='Identifier'?n.name:n?.type==='StringLiteral'?n.value:n?.type==='PrivateName'?'#'+n.id?.name:null;
function* walkNodes(node){
  if(!node||typeof node.type!=='string')return;
  yield node;
  for(const k of Object.keys(node)){
    if(k==='loc'||k==='start'||k==='end'||k==='extra'||k==='leadingComments'||k==='trailingComments'||k==='innerComments')continue;
    const v=node[k];
    if(Array.isArray(v)){for(const c of v)if(c&&typeof c.type==='string')yield* walkNodes(c);}
    else if(v&&typeof v.type==='string')yield* walkNodes(v);
  }
}
export function outlineJS(text,file){
  let ast;try{ast=parseJS(text,file);}catch(e){return {language:isTS(file)?'typescript':'javascript',error:String(e.message).slice(0,200),symbols:[],imports:[],exports:[]};}
  const symbols=[],imports=[],exports=[];let dynamicNonLiteral=0;
  const L=n=>n.loc?.start.line,E=n=>n.loc?.end.line;
  const params=f=>(f.params||[]).map(p=>p.type==='Identifier'?p.name:p.type==='AssignmentPattern'?nameOf(p.left)+'=':p.type==='RestElement'?'...'+nameOf(p.argument):p.type==='TSParameterProperty'?nameOf(p.parameter):'{…}');
  function decl(d,exported){
    if(!d)return;
    switch(d.type){
      case 'FunctionDeclaration':case 'TSDeclareFunction':symbols.push({name:nameOf(d.id)||'default',kind:'function',line:L(d),endLine:E(d),exported,async:!!d.async,params:params(d)});break;
      case 'ClassDeclaration':{const cname=nameOf(d.id)||'default';symbols.push({name:cname,kind:'class',line:L(d),endLine:E(d),exported,extends:d.superClass?nameOf(d.superClass)||'…':undefined});
        for(const m of d.body.body||[])if(/Method|Property/.test(m.type)&&m.key)symbols.push({name:cname+'.'+(nameOf(m.key)||'[computed]'),kind:m.type.includes('Method')?(m.kind==='constructor'?'constructor':'method'):'property',line:L(m),endLine:E(m),exported,static:!!m.static});break;}
      case 'VariableDeclaration':for(const v of d.declarations){const n=nameOf(v.id);if(!n)continue;const init=v.init;const fn=init&&/ArrowFunctionExpression|FunctionExpression/.test(init.type);
        symbols.push({name:n,kind:fn?'function':init?.type==='ClassExpression'?'class':'variable',line:L(v),endLine:E(v),exported,...(fn?{params:params(init),async:!!init.async}:{})});}break;
      case 'TSInterfaceDeclaration':symbols.push({name:nameOf(d.id),kind:'interface',line:L(d),endLine:E(d),exported});break;
      case 'TSTypeAliasDeclaration':symbols.push({name:nameOf(d.id),kind:'type',line:L(d),endLine:E(d),exported});break;
      case 'TSEnumDeclaration':symbols.push({name:nameOf(d.id),kind:'enum',line:L(d),endLine:E(d),exported});break;
      case 'TSModuleDeclaration':symbols.push({name:nameOf(d.id),kind:'namespace',line:L(d),endLine:E(d),exported});break;
    }
  }
  for(const s of ast.program.body){
    if(s.type==='ImportDeclaration')imports.push({source:s.source.value,line:L(s),kind:s.importKind==='type'?'type':'import',names:s.specifiers.map(x=>x.type==='ImportDefaultSpecifier'?'default':x.type==='ImportNamespaceSpecifier'?'*':nameOf(x.imported))});
    else if(s.type==='ExportNamedDeclaration'){
      if(s.declaration){decl(s.declaration,true);const d=s.declaration;const names=d.declarations?d.declarations.map(v=>nameOf(v.id)).filter(Boolean):[nameOf(d.id)];for(const n of names)exports.push({name:n,line:L(s)});}
      for(const sp of s.specifiers||[])exports.push({name:nameOf(sp.exported),local:nameOf(sp.local),line:L(s),from:s.source?.value});
      if(s.source)imports.push({source:s.source.value,line:L(s),kind:'reexport',names:(s.specifiers||[]).map(x=>nameOf(x.local))});
    }
    else if(s.type==='ExportDefaultDeclaration'){exports.push({name:'default',line:L(s)});if(/Declaration$/.test(s.declaration.type))decl(s.declaration,true);}
    else if(s.type==='ExportAllDeclaration'){imports.push({source:s.source.value,line:L(s),kind:'reexport',names:['*']});exports.push({name:'*',from:s.source.value,line:L(s)});}
    else decl(s,false);
  }
  // require(), dynamic import(), module.exports anywhere
  for(const n of walkNodes(ast.program)){
    if(n.type==='CallExpression'&&n.arguments?.[0]?.type==='StringLiteral'){
      if(n.callee.type==='Identifier'&&n.callee.name==='require')imports.push({source:n.arguments[0].value,line:L(n),kind:'require',names:[]});
      else if(n.callee.type==='Import')imports.push({source:n.arguments[0].value,line:L(n),kind:'dynamic',names:[]});
    }
    if(n.type==='ImportExpression'&&n.source?.type==='StringLiteral')imports.push({source:n.source.value,line:L(n),kind:'dynamic',names:[]});
    else if(n.type==='ImportExpression'||(n.type==='CallExpression'&&(n.callee.type==='Import'||(n.callee.type==='Identifier'&&n.callee.name==='require'))&&n.arguments?.[0]&&n.arguments[0].type!=='StringLiteral'))dynamicNonLiteral++;
    if(n.type==='AssignmentExpression'&&n.left.type==='MemberExpression'&&nameOf(n.left.object)==='module'&&nameOf(n.left.property)==='exports')exports.push({name:'module.exports',line:L(n)});
  }
  return {language:isTS(file)?'typescript':'javascript',parseErrors:(ast.errors||[]).length,dynamicNonLiteral,symbols,imports,exports};
}
const JS_REGEX=[/\.(m?js|cjs|jsx|ts|tsx|mts|cts)$/i,'javascript',[[/^()(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,'function'],[/^()(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,'class'],[/^()(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,'function']],[/^\s*import\s.*?from\s+['"]([^'"]+)['"]/,/require\(\s*['"]([^'"]+)['"]\s*\)/]];
const REGEX_LANGS=[
  [/\.py$/i,'python',[[/^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/,'function'],[/^(\s*)class\s+([A-Za-z_]\w*)/,'class']],[/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/]],
  [/\.go$/i,'go',[[/^()func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/,'function'],[/^()type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/,'type']],[/^\s*(?:import\s+)?"([^"]+)"/]],
  [/\.rs$/i,'rust',[[/^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/,'function'],[/^(\s*)(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/,'type']],[/^\s*use\s+([\w:]+)/]],
  [/\.(java|kt|cs)$/i,'jvm/cs',[[/^(\s*)(?:public|private|protected|internal|static|final|abstract|\s)*\s*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/,'class'],[/^(\s+)(?:public|private|protected|internal|static|final|override|suspend|async|\s)+[\w<>\[\],\s?]*\s([a-zA-Z_]\w*)\s*\([^;]*$/,'method']],[/^\s*(?:import|using)\s+([\w.]+)/]],
];
export function outline(text,file){
  let lang;
  if(JS_EXT.test(file)){const o=outlineJS(text,file);if(!o.error)return o;lang=JS_REGEX;var parseError=o.error;}
  else lang=REGEX_LANGS.find(([re])=>re.test(file));
  if(!lang)return {language:null,supported:false,symbols:[],imports:[],exports:[]};
  const [,name,defs,imps]=lang;const symbols=[],imports=[];
  text.split('\n').forEach((l,i)=>{
    for(const [re,kind] of defs){const m=re.exec(l);if(m){symbols.push({name:m[2],kind:m[1]&&m[1].length&&kind==='function'&&name==='python'?'method':kind,line:i+1,exported:name==='go'?/^[A-Z]/.test(m[2]):undefined});break;}}
    for(const re of imps){const m=re.exec(l);if(m)imports.push({source:m[1]||m[2],line:i+1,kind:'import',names:[]});}
  });
  return {language:name,approximate:true,...(parseError?{parseError}:{}),symbols,imports,exports:[]};
}
