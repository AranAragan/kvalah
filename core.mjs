import fs from 'node:fs/promises';
import path from 'node:path';
import {inflateRawSync} from 'node:zlib';
import {looseJSON} from './toolcalls.mjs';

export async function safePath(root, input='.') {
  if (typeof input !== 'string' || input.includes('\0')) throw Error('Некорректный путь');
  const base=await fs.realpath(root), target=path.resolve(base,input);
  const inside=p=>{const rel=path.relative(base,p);return rel==='' || (!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));};
  if(!inside(target)) throw Error('Путь находится вне рабочей папки');
  let probe=target;
  while(true){try{if(!inside(await fs.realpath(probe)))throw Error('Ссылка ведёт вне рабочей папки');break;}catch(e){if(e.code!=='ENOENT')throw e; const parent=path.dirname(probe);if(parent===probe)throw e;probe=parent;}}
  return target;
}

export function validateCall(call){
  const fn=call?.function;
  if(!fn||typeof fn.name!=='string')throw Error('Отсутствует function.name');
  let args=fn.arguments;
  if(typeof args==='string'){try{args=args.trim()?looseJSON(args):{};}catch{throw Error('arguments должен быть JSON-объектом');}}
  if(args===undefined||args===null)args={};
  if(!args||typeof args!=='object'||Array.isArray(args))throw Error('arguments должен быть объектом');
  const fields={list_files:['path'],read_file:['path'],write_file:['path','content'],run_shell:['command'],get_environment:[],request_access:['path','mode','reason'],create_project:['name'],inspect_project:[],edit_file:['path','old_text','new_text'],update_plan:['note'],verify_project:['command'],finish_task:['summary'],append_file:['path','content'],apply_patch:['patch'],search_code:['pattern'],find_files:['pattern'],outline_file:['path'],git_status:[],git_diff:[],git_commit:['message']};
  if(!fields[fn.name])throw Error('Неизвестный инструмент: '+fn.name);
  for(const key of fields[fn.name])if(typeof args[key]!=='string')throw Error('Обязательное строковое поле: '+key);
  for(const key of ['path','cwd','glob','file'])if(args[key]!==undefined&&typeof args[key]!=='string')throw Error(key+' must be a string');
  if((fn.name==='write_file'||fn.name==='append_file')&&Buffer.byteLength(args.content)>500000)throw Error('Файл слишком большой: максимум 500 КБ');
  if(fn.name==='run_shell'&&args.command.length>20000)throw Error('Команда слишком длинная');
  if(fn.name==='run_shell'&&args.cwd!==undefined&&typeof args.cwd!=='string')throw Error('cwd должен быть строкой');
  if(fn.name==='run_shell'&&args.timeoutSeconds!==undefined&&(!Number.isInteger(args.timeoutSeconds)||args.timeoutSeconds<30||args.timeoutSeconds>900))throw Error('timeoutSeconds должен быть целым числом от 30 до 900');
  if(fn.name==='request_access'&&!['read','write'].includes(args.mode))throw Error('mode должен быть read или write');
  if(fn.name==='edit_file'&&(args.old_text.length+args.new_text.length>500000))throw Error('Edit too large');
  if(fn.name==='edit_file'&&args.replace_all!==undefined&&typeof args.replace_all!=='boolean')throw Error('replace_all must be boolean');
  if(fn.name==='apply_patch'&&args.patch.length>600000)throw Error('Patch too large');
  if(fn.name==='search_code'&&(args.pattern.length>500||args.maxResults!==undefined&&(!Number.isInteger(args.maxResults)||args.maxResults<1||args.maxResults>300)))throw Error('pattern ≤500 chars, maxResults 1-300');
  if(fn.name==='git_commit'&&(!args.message.trim()||args.message.length>5000||args.files!==undefined&&(!Array.isArray(args.files)||args.files.some(f=>typeof f!=='string'))))throw Error('message required; files must be an array of paths');
  if(fn.name==='inspect_project'&&args.path!==undefined&&typeof args.path!=='string')throw Error('path must be a string');
  if(fn.name==='read_file')for(const key of ['startLine','endLine'])if(args[key]!==undefined&&(!Number.isInteger(args[key])||args[key]<1))throw Error(key+' must be a positive integer');
  if(fn.name==='update_plan'){
    if(!Array.isArray(args.steps)||!args.steps.length||args.steps.length>20||args.steps.some(s=>!s||typeof s.title!=='string'||!s.title.trim()||s.status!==undefined&&!['pending','in_progress','done'].includes(s.status)))throw Error('steps must contain 1-20 titles with pending/in_progress/done status');
  }
  if(fn.name==='verify_project'){
    if(args.command.length>20000)throw Error('Verification command too long');
    if(!Array.isArray(args.artifacts)||args.artifacts.length>8||args.artifacts.some(a=>!a||typeof a.path!=='string'||!['file','exe'].includes(a.kind)))throw Error('artifacts must be an array of {path,kind:file|exe}');
    if(args.launchArtifact!==undefined&&typeof args.launchArtifact!=='string')throw Error('launchArtifact must be a path');
  }
  return {name:fn.name,args};
}

export function extractDocx(buffer){
  try{return extractDocxUnsafe(buffer);}catch(e){if(e instanceof RangeError||e.code==='ERR_OUT_OF_RANGE')throw Error('Повреждённый DOCX');throw e;}
}
function extractDocxUnsafe(buffer){
  let pos=-1;for(let i=buffer.length-22;i>=Math.max(0,buffer.length-65557);i--){if(buffer.readUInt32LE(i)===0x06054b50){pos=i;break;}}
  if(pos<0)throw Error('Повреждённый DOCX');
  let cursor=buffer.readUInt32LE(pos+16);const count=buffer.readUInt16LE(pos+10);
  for(let i=0;i<count;i++){
    if(buffer.readUInt32LE(cursor)!==0x02014b50)throw Error('Некорректный ZIP');
    const method=buffer.readUInt16LE(cursor+10),size=buffer.readUInt32LE(cursor+20),expanded=buffer.readUInt32LE(cursor+24),nl=buffer.readUInt16LE(cursor+28),el=buffer.readUInt16LE(cursor+30),cl=buffer.readUInt16LE(cursor+32),offset=buffer.readUInt32LE(cursor+42);
    const name=buffer.subarray(cursor+46,cursor+46+nl).toString();
    if(name==='word/document.xml'){
      if(expanded>5000000)throw Error('Слишком большой документ');
      const start=offset+30+buffer.readUInt16LE(offset+26)+buffer.readUInt16LE(offset+28),data=buffer.subarray(start,start+size);
      const xml=(method===0?data:method===8?inflateRawSync(data,{maxOutputLength:5000000}):(()=>{throw Error('Неподдерживаемое сжатие DOCX');})()).toString('utf8');
      return xml.replace(/<w:tab\b[^>]*\/>/g,'\t').replace(/<\/w:p>/g,'\n').replace(/<[^>]+>/g,'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
    }
    cursor+=46+nl+el+cl;
  }
  throw Error('В DOCX не найден текст');
}

export function attachmentText(name,mime,buffer){
  if(/\.(docx)$/i.test(name))return extractDocx(buffer);
  if(/^(text\/|application\/(json|xml|javascript|x-yaml))/.test(mime)||/\.(txt|md|csv|tsv|json|js|mjs|cjs|jsx|ts|tsx|py|go|rs|java|cs|html|css|xml|yaml|yml|log|sql|ps1|sh|toml|ini|srt)$/i.test(name))return buffer.toString('utf8');
  return null;
}
