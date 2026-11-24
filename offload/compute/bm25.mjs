// Small BM25 index over chunks for relevance ranking. Identifiers are split (camelCase, snake_case, kebab).
const STOP=new Set('the a an and or of to in on for is are be with this that it as at by from not no if then else return const let var function class import export new'.split(' '));
export function terms(text){
  const out=[];
  for(const raw of String(text).match(/[\p{L}\p{N}_$]+/gu)||[]){
    const parts=raw.replace(/([a-z0-9])([A-Z])/g,'$1 $2').replace(/[_$]+/g,' ').toLowerCase().split(/\s+/).filter(Boolean);
    const whole=raw.toLowerCase();
    for(const p of new Set([whole,...parts]))if(p.length>1&&!STOP.has(p))out.push(p);
  }
  return out;
}
export function createBM25(docs,{k1=1.2,b=0.75}={}){
  const tf=docs.map(d=>{const m=new Map();for(const t of terms(d.text))m.set(t,(m.get(t)||0)+1);return m;});
  const len=tf.map(m=>{let n=0;for(const v of m.values())n+=v;return n;});
  const avg=len.reduce((a,b)=>a+b,0)/(len.length||1)||1;
  const df=new Map();for(const m of tf)for(const t of m.keys())df.set(t,(df.get(t)||0)+1);
  const N=docs.length;
  return {
    score(query){
      const q=[...new Set(terms(query))];
      return docs.map((d,i)=>{let s=0;for(const t of q){const f=tf[i].get(t);if(!f)continue;const idf=Math.log(1+(N-df.get(t)+0.5)/(df.get(t)+0.5));s+=idf*f*(k1+1)/(f+k1*(1-b+b*len[i]/avg));}return {doc:d,index:i,score:s};});
    },
    rank(query,k=Infinity){return this.score(query).sort((a,b)=>b.score-a.score||a.index-b.index).slice(0,k);}
  };
}
