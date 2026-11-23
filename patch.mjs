// Text helpers for edits: encoding/EOL preservation, tolerant fragment matching,
// real unified diffs and the multi-file apply_patch format (Codex-style and unified diff).

export function decodeText(buffer){
  const bom=buffer.length>=3&&buffer[0]===0xef&&buffer[1]===0xbb&&buffer[2]===0xbf;
  const body=bom?buffer.subarray(3):buffer,text=body.toString('utf8');
  const utf8=Buffer.from(text,'utf8').equals(body)&&!body.includes(0);
  const crlf=(text.match(/\r\n/g)||[]).length,lf=(text.match(/\n/g)||[]).length-crlf;
  return {text:text.replace(/\r\n/g,'\n'),bom,eol:crlf>lf?'\r\n':'\n',utf8};
}
export function encodeText(textLF,{bom=false,eol='\n'}={}){
  const body=Buffer.from(eol==='\r\n'?textLF.replace(/\r?\n/g,'\r\n'):textLF,'utf8');
  return bom?Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),body]):body;
}
export const toLF=s=>String(s??'').replace(/\r\n?/g,'\n');

function lineStarts(text){const starts=[0];for(let i=0;i<text.length;i++)if(text[i]==='\n')starts.push(i+1);return starts;}
function similarity(a,b){a=a.trim();b=b.trim();if(!a||!b)return 0;let same=0;const n=Math.min(a.length,b.length);for(let i=0;i<n;i++)if(a[i]===b[i])same++;return same/Math.max(a.length,b.length);}
// Finds old in content (both LF). Strategies: exact, trailing whitespace, indentation-insensitive.
export function findFragment(content,old){
  const exact=[];let at=content.indexOf(old);
  while(at>=0&&old){exact.push({start:at,end:at+old.length});at=content.indexOf(old,at+1);}
  if(exact.length)return {matches:exact,strategy:'exact'};
  const fileLines=content.split('\n'),oldLines=old.replace(/\n$/,'').split('\n'),starts=lineStarts(content);
  while(oldLines.length&&!oldLines[0].trim())oldLines.shift();
  while(oldLines.length&&!oldLines.at(-1).trim())oldLines.pop();
  if(!oldLines.length)return {matches:[],strategy:'none'};
  for(const [strategy,norm] of [['whitespace',s=>s.trimEnd()],['indent',s=>s.trim()]]){
    const want=oldLines.map(norm),matches=[];
    for(let i=0;i+want.length<=fileLines.length;i++){
      let ok=true;for(let k=0;k<want.length;k++)if(norm(fileLines[i+k])!==want[k]){ok=false;break;}
      if(ok){const last=i+want.length-1;matches.push({start:starts[i],end:starts[last]+fileLines[last].length,line:i,strategy,fileIndent:/^\s*/.exec(fileLines[i])[0],oldIndent:/^\s*/.exec(oldLines[0])[0]});}
    }
    if(matches.length)return {matches,strategy};
  }
  let best=-1,score=0;for(let i=0;i<fileLines.length;i++){const s=similarity(fileLines[i],oldLines[0]);if(s>score){score=s;best=i;}}
  return {matches:[],strategy:'none',hint:best>=0&&score>0.5?best+1:null};
}
function reindent(text,from,to){
  if(from===to)return text;
  return text.split('\n').map(l=>!l.trim()?l:l.startsWith(from)?to+l.slice(from.length):l).join('\n');
}
// Replaces old_text with new_text. Throws a descriptive error when no unique match exists.
export function replaceFragment(content,oldText,newText,replaceAll=false){
  const old=toLF(oldText),replacement=toLF(newText);
  if(!old)throw Error('old_text must not be empty. Use write_file or append_file to create content.');
  const {matches,strategy,hint}=findFragment(content,old);
  if(!matches.length)throw Error('Fragment not found (checked exact, trailing-whitespace and indentation-insensitive matches).'+(hint?' Closest line: '+hint+'. Read the file around it and copy the text exactly.':' Read the file again and copy the text exactly.'));
  if(matches.length>1&&!replaceAll)throw Error('Expected exactly one matching fragment; found '+matches.length+'. Include more surrounding lines or set replace_all=true.');
  let out='',pos=0;
  for(const m of matches){
    const insert=strategy==='indent'?reindent(replacement.replace(/\n$/,''),m.oldIndent,m.fileIndent):strategy==='whitespace'?replacement.replace(/\n$/,''):replacement;
    out+=content.slice(pos,m.start)+insert;pos=m.end;
  }
  return {content:out+content.slice(pos),count:matches.length,strategy};
}

// Myers diff on lines -> edit script.
function diffLines(a,b){
  let pre=0;while(pre<a.length&&pre<b.length&&a[pre]===b[pre])pre++;
  let suf=0;while(suf<a.length-pre&&suf<b.length-pre&&a[a.length-1-suf]===b[b.length-1-suf])suf++;
  const A=a.slice(pre,a.length-suf),B=b.slice(pre,b.length-suf),n=A.length,m=B.length,max=n+m;
  const ops=[];for(let i=0;i<pre;i++)ops.push([' ',a[i]]);
  let middle=null;
  if(max&&n*m<=25e6&&max<=20000){
    const v=new Int32Array(2*max+2),trace=[];const off=max+1;let found=false;
    for(let d=0;d<=max&&!found;d++){
      trace.push(v.slice());
      for(let k=-d;k<=d;k+=2){
        let x=k===-d||(k!==d&&v[off+k-1]<v[off+k+1])?v[off+k+1]:v[off+k-1]+1,y=x-k;
        while(x<n&&y<m&&A[x]===B[y]){x++;y++;}
        v[off+k]=x;if(x>=n&&y>=m){found=true;break;}
      }
      if(d>3000)break;
    }
    if(found){
      middle=[];let x=n,y=m;
      for(let d=trace.length-1;d>=0;d--){
        const vv=trace[d],k=x-y;
        const prevK=k===-d||(k!==d&&vv[off+k-1]<vv[off+k+1])?k+1:k-1;
        const px=d===0?0:vv[off+prevK],py=px-prevK;
        while(x>px&&y>py){middle.push([' ',A[x-1]]);x--;y--;}
        if(d>0){if(x===px)middle.push(['+',B[y-1]]);else middle.push(['-',A[x-1]]);}
        x=px;y=py;
      }
      middle.reverse();
    }
  }
  if(!middle)middle=[...A.map(l=>['-',l]),...B.map(l=>['+',l])];
  ops.push(...middle);for(let i=b.length-suf;i<b.length;i++)ops.push([' ',b[i]]);
  return ops;
}
export function unifiedDiff(before,after,file='file',{context=3,maxChars=14000}={}){
  const a=before===null||before===undefined?[]:toLF(before).split('\n'),b=after===null||after===undefined?[]:toLF(after).split('\n');
  const ops=diffLines(a,b);
  const out=['--- '+(before===null?'/dev/null':'a/'+file),'+++ '+(after===null?'/dev/null':'b/'+file)];
  let i=0,ai=0,bi=0;const pos=[];for(const op of ops){pos.push([ai,bi]);if(op[0]!=='+')ai++;if(op[0]!=='-')bi++;}
  while(i<ops.length){
    if(ops[i][0]===' '){i++;continue;}
    let start=Math.max(0,i-context),end=i;
    while(end<ops.length){
      if(ops[end][0]!==' '){end++;continue;}
      let run=0;while(end+run<ops.length&&ops[end+run][0]===' ')run++;
      if(end+run>=ops.length||run>context*2){end=Math.min(ops.length,end+context);break;}
      end+=run;
    }
    const slice=ops.slice(start,end),[as,bs]=pos[start];
    const ac=slice.filter(o=>o[0]!=='+').length,bc=slice.filter(o=>o[0]!=='-').length;
    out.push('@@ -'+(ac?as+1:as)+','+ac+' +'+(bc?bs+1:bs)+','+bc+' @@',...slice.map(o=>o[0]+o[1]));
    i=end;
  }
  if(out.length===2)return '';
  const text=out.join('\n');
  return text.length>maxChars?text.slice(0,maxChars)+'\n[diff truncated]':text;
}
export function diffStats(diff){let add=0,del=0;for(const l of String(diff).split('\n')){if(l.startsWith('+')&&!l.startsWith('+++'))add++;else if(l.startsWith('-')&&!l.startsWith('---'))del++;}return {added:add,removed:del};}

// apply_patch: parses Codex-style "*** Begin Patch" or a standard unified/git diff.
export function parsePatch(input){
  const text=toLF(input).replace(/^```[\w-]*\n/,'').replace(/\n```\s*$/,'');
  if(/^\*\*\* (?:Begin Patch|Add File|Update File|Delete File)/m.test(text))return parseCodexPatch(text);
  if(/^--- /m.test(text)&&/^\+\+\+ /m.test(text))return parseUnified(text);
  throw Error('Patch format not recognized. Use "*** Begin Patch / *** Update File: path / @@ / -old / +new / *** End Patch".');
}
function parseCodexPatch(text){
  const lines=text.split('\n'),ops=[];let cur=null,hunk=null;
  const push=()=>{if(cur)ops.push(cur);cur=null;hunk=null;};
  for(const raw of lines){
    let m;
    if(/^\*\*\* Begin Patch/.test(raw))continue;
    if(/^\*\*\* End Patch/.test(raw)){push();break;}
    if((m=/^\*\*\* Add File:\s*(.+?)\s*$/.exec(raw))){push();cur={type:'add',path:m[1],lines:[]};continue;}
    if((m=/^\*\*\* Delete File:\s*(.+?)\s*$/.exec(raw))){push();ops.push({type:'delete',path:m[1]});continue;}
    if((m=/^\*\*\* Update File:\s*(.+?)\s*$/.exec(raw))){push();cur={type:'update',path:m[1],hunks:[]};continue;}
    if(!cur)continue;
    if((m=/^\*\*\* Move to:\s*(.+?)\s*$/.exec(raw))&&cur.type==='update'){cur.moveTo=m[1];continue;}
    if(/^\*\*\* End of File/.test(raw)){if(hunk)hunk.eof=true;continue;}
    if(cur.type==='add'){cur.lines.push(raw.startsWith('+')?raw.slice(1):raw);continue;}
    if(raw.startsWith('@@')){hunk={header:raw.replace(/^@@\s?/,'').replace(/\s?@@.*$/,'').trim(),lines:[]};cur.hunks.push(hunk);continue;}
    if(!hunk){hunk={header:'',lines:[]};cur.hunks.push(hunk);}
    if(raw.startsWith('+'))hunk.lines.push(['+',raw.slice(1)]);
    else if(raw.startsWith('-'))hunk.lines.push(['-',raw.slice(1)]);
    else hunk.lines.push([' ',raw.startsWith(' ')?raw.slice(1):raw]);
  }
  push();
  for(const op of ops){
    if(op.type==='add'&&op.lines.length&&op.lines.at(-1)==='')op.lines.pop();
    if(op.type==='update')for(const h of op.hunks)while(h.lines.length&&h.lines.at(-1)[0]===' '&&h.lines.at(-1)[1]==='')h.lines.pop();
  }
  if(!ops.length)throw Error('Patch contains no file operations.');
  return ops;
}
function parseUnified(text){
  const lines=text.split('\n'),ops=[];let cur=null,hunk=null;
  const clean=p=>p.replace(/^[ab]\//,'').replace(/\t.*$/,'').trim();
  for(let i=0;i<lines.length;i++){
    const raw=lines[i];
    if(raw.startsWith('--- ')&&lines[i+1]?.startsWith('+++ ')){
      const from=clean(raw.slice(4)),to=clean(lines[i+1].slice(4));i++;
      cur=from==='/dev/null'?{type:'add',path:to,lines:[]}:to==='/dev/null'?{type:'delete',path:from}:{type:'update',path:from,moveTo:to!==from?to:undefined,hunks:[]};
      ops.push(cur);hunk=null;continue;
    }
    if(!cur||cur.type==='delete')continue;
    if(raw.startsWith('@@')){hunk={header:'',lines:[]};if(cur.type==='update')cur.hunks.push(hunk);continue;}
    if(!hunk||/^(?:diff --git|index |new file mode|deleted file mode|\\ No newline)/.test(raw))continue;
    const op=raw[0]==='+'||raw[0]==='-'?raw[0]:' ',body=raw[0]===' '||op!==' '?raw.slice(1):raw;
    if(cur.type==='add'){if(op==='+')cur.lines.push(body);}else hunk.lines.push([op,body]);
  }
  for(const op of ops)if(op.type==='update')for(const h of op.hunks)while(h.lines.length&&h.lines.at(-1)[0]===' '&&h.lines.at(-1)[1]==='')h.lines.pop();
  if(!ops.length)throw Error('Patch contains no file operations.');
  return ops;
}
function locate(fileLines,want,from){
  for(const norm of [s=>s,s=>s.trimEnd(),s=>s.trim()]){
    const w=want.map(norm);
    for(let i=from;i+w.length<=fileLines.length;i++){let ok=true;for(let k=0;k<w.length;k++)if(norm(fileLines[i+k])!==w[k]){ok=false;break;}if(ok)return i;}
  }
  return -1;
}
// Applies hunks sequentially to LF content.
export function applyHunks(content,hunks,file='file'){
  let lines=content.split('\n');let cursor=0;
  hunks.forEach((h,index)=>{
    const old=h.lines.filter(l=>l[0]!=='+').map(l=>l[1]),next=h.lines.filter(l=>l[0]!=='-').map(l=>l[1]);
    let from=cursor;
    if(h.header){const found=locate(lines,[h.header],cursor);if(found>=0)from=found;}
    let at;
    const headerAt=h.header?locate(lines,[h.header],cursor):-1;
    if(!old.length)at=headerAt>=0&&!h.eof?headerAt+1:lines.length-(lines.at(-1)===''?1:0);
    else{at=locate(lines,old,from);if(at<0&&from!==cursor)at=locate(lines,old,cursor);if(at<0)at=locate(lines,old,0);}
    if(at<0)throw Error(file+': hunk '+(index+1)+' did not match. First expected line: '+JSON.stringify(old[0]??'')+'. Read the file and regenerate the patch with exact context lines.');
    const indentFile=old.length?/^\s*/.exec(lines[at])[0]:'',indentOld=old.length?/^\s*/.exec(old[0])[0]:'';
    const fixed=old.length&&lines[at].trim()===old[0].trim()&&lines[at]!==old[0]?next.map(l=>l.startsWith(indentOld)?indentFile+l.slice(indentOld.length):l):next;
    lines=[...lines.slice(0,at),...fixed,...lines.slice(at+old.length)];
    cursor=at+fixed.length;
  });
  return lines.join('\n');
}
