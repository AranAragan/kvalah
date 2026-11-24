// Line-aware chunking under a token budget. Never drops content: every input char lands in exactly one chunk
// (plus optional overlap). Over-long single lines are hard-split.
export function chunkText(text,{maxTokens,count,overlapLines=0,path=null,source='file'}){
  if(!(maxTokens>0))throw Error('chunkText: maxTokens must be > 0');
  const lines=text.split('\n');const chunks=[];
  // v0.3 (CTX-02): every chunk carries its char range [charStart,charEnd) in the input (incl. its trailing newline)
  const lineStart=new Array(lines.length+1);lineStart[0]=0;for(let i=0;i<lines.length;i++)lineStart[i+1]=lineStart[i]+lines[i].length+1;
  const endOf=i=>Math.min(text.length,lineStart[i]); // end of line i-1 incl. newline
  let cur=[],curTok=0,start=1;
  const flush=(endLine)=>{if(!cur.length)return;const t=cur.join('\n');chunks.push({id:chunks.length,path,source,startLine:start,endLine,text:t,tokens:count(t),charStart:lineStart[start-1],charEnd:endOf(endLine)});};
  for(let i=0;i<lines.length;i++){
    let line=lines[i];let lt=count(line)+1;
    if(lt>maxTokens){ // hard split a giant line (minified code, base64, JSON blob)
      flush(i);cur=[];curTok=0;
      // split on code points (never inside a surrogate pair); halve any piece that is still too dense (mixed scripts)
      const cps=Array.from(line);
      const per=Math.max(16,Math.floor(cps.length*maxTokens/lt*0.9));
      let co=lineStart[i];
      const emit=(a,b)=>{const piece=cps.slice(a,b).join('');const tk=count(piece);
        if(tk>maxTokens&&b-a>1){const m=a+Math.floor((b-a)/2);emit(a,m);emit(m,b);return;}
        const end=co+piece.length+(b===cps.length?1:0);
        chunks.push({id:chunks.length,path,source,startLine:i+1,endLine:i+1,partial:true,text:piece,tokens:tk,charStart:co,charEnd:Math.min(text.length,end)});co+=piece.length;};
      for(let p=0;p<cps.length;p+=per)emit(p,Math.min(cps.length,p+per));
      start=i+2;continue;
    }
    if(curTok+lt>maxTokens&&cur.length){
      flush(i);
      const keep=overlapLines>0?cur.slice(-overlapLines):[];
      cur=[...keep];curTok=keep.reduce((n,l)=>n+count(l)+1,0);start=i+1-keep.length;
    }
    cur.push(line);curTok+=lt;
  }
  flush(lines.length);
  return chunks;
}
