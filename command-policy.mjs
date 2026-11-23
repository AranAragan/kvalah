// Approval policy for shell commands. This is NOT an operating-system sandbox:
// it decides which commands may run without a confirmation card.
//   ask  — only exact version/location checks run automatically (original behaviour);
//   auto — additionally read-only inspection commands and project "always allow" rules;
//   full — every command runs without confirmation (still logged, still needs a plan).
export const APPROVAL_MODES=['ask','auto','full'];
const META=/[;&|<>`\r\n]|\$\(|\$\{|@\(|\$[\w:]|%[\w]+%/;
export function hasShellMeta(command){return META.test(String(command));}
function versionCheck(text){
  return /^(?:node|npm(?:\.cmd)?|npx(?:\.cmd)?|python|python3|py|dotnet|git)\s+--version$/i.test(text)||/^(?:Get-Location|pwd)$/i.test(text);
}
// Arguments that reach outside the project or change behaviour of otherwise read-only tools.
function dangerousFlags(text){return text.split(/\s+/).slice(1).some(t=>/^--(?:output|pre|ext-diff|textconv|exec|upload-pack|config)\b/i.test(t)||/^-c$/.test(t));}
function unsafeArgs(text){
  return dangerousFlags(text)||text.split(/\s+/).slice(1).some(t=>{const v=t.replace(/^['"]|['"]$/g,'').replace(/^-{1,2}[\w-]+[=:]/,'');
    return /^[A-Za-z]:|^[\\/]|^~|^\\\\|(?:^|[\\/])\.\.(?:[\\/]|$)/.test(v);});
}
const READ_ONLY=[
  /^(?:node|npm(?:\.cmd)?|npx(?:\.cmd)?|python3?|py|dotnet|git|cargo|rustc|go|java|javac|pip3?|pnpm(?:\.cmd)?|yarn(?:\.cmd)?|deno|bun|tsc(?:\.cmd)?|cmake|gcc|g\+\+|clang|rg)\s+(?:--version|-v|-V|version)$/i,
  /^(?:Get-ChildItem|gci|ls|dir)(?:\s+[^]*)?$/i,
  /^(?:Get-Content|gc|cat|type)\s+\S[^]*$/i,
  /^(?:Select-String|sls)\s+\S[^]*$/i,
  /^(?:Test-Path|Get-Item|Resolve-Path|Get-FileHash)\s+\S[^]*$/i,
  /^(?:Get-Command|gcm|where(?:\.exe)?|which)\s+[\w.+-]+$/i,
  /^git\s+(?:status|diff|log|show|rev-parse|ls-files|blame|describe|shortlog)(?:\s+[^]*)?$/i,
  /^git\s+branch(?:\s+(?:-a|-r|-v|-vv|--all|--remotes|--list|--show-current))*$/i,
  /^git\s+(?:tag\s+(?:-l|--list)|remote\s+-v|stash\s+list)$/i,
  /^rg(?:\.exe)?\s+\S[^]*$/i,
  /^npm(?:\.cmd)?\s+(?:ls|list)(?:\s+[^]*)?$/i,
  /^dotnet\s+--(?:info|list-sdks|list-runtimes)$/i,
  /^(?:pip3?|python3?\s+-m\s+pip|py\s+-m\s+pip)\s+(?:list|show|freeze)(?:\s+[^]*)?$/i
];
export function isReadOnlyCommand(command){
  const text=String(command).trim();
  if(versionCheck(text))return true;
  if(!text||hasShellMeta(text)||unsafeArgs(text))return false;
  return READ_ONLY.some(re=>re.test(text));
}
// Prefix rule used for "always allow in this project": the program and up to two following
// words (options included), e.g. "npm.cmd run build", "dotnet test", "node --check app.js".
export function commandRule(command){
  const tokens=prepareCommand(command).trim().split(/\s+/),rule=[tokens[0]];
  for(const t of tokens.slice(1,3)){if(/["'`$]/.test(t))break;rule.push(t);}
  return rule.join(' ');
}
export function matchesRule(command,rule){
  const text=prepareCommand(command).trim();
  if(!rule||hasShellMeta(text)||dangerousFlags(text))return false;
  const a=text.split(/\s+/),b=String(rule).trim().split(/\s+/);
  if(b.length>a.length)return false;
  return b.every((t,i)=>i===0?t.toLowerCase()===a[i].toLowerCase():t===a[i]);
}
export function commandPolicy(command,{mode='ask',rules=[]}={}){
  const text=String(command).trim(),readOnly=isReadOnlyCommand(text);
  if(versionCheck(text))return {automatic:true,readOnly:true,reason:/version/i.test(text)?'Проверка версии установленного инструмента':'Текущая рабочая папка'};
  if(mode==='full')return {automatic:true,readOnly,reason:'Полный автоматический режим: команды выполняются без подтверждения'};
  if(mode==='auto'&&readOnly)return {automatic:true,readOnly,reason:'Команда только читает данные проекта'};
  const rule=rules.find(r=>matchesRule(text,r));
  if(rule)return {automatic:true,readOnly,reason:'Разрешено правилом проекта: '+rule,rule};
  return {automatic:false,readOnly,reason:readOnly?'Команда только читает данные, но режим «Спрашивать» требует подтверждения':'Команда может запускать код или изменять систему; требуется подтверждение',suggestedRule:hasShellMeta(text)?null:commandRule(text)};
}
export function prepareCommand(command){
  // Explicit .cmd avoids the PowerShell npm.ps1 execution-policy conflict.
  return String(command).replace(/^(\s*)(npm|npx|pnpm|yarn)(?=\s|$)/i,(_,space,name)=>space+name+'.cmd');
}
