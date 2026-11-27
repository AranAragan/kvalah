export const chunkSizes=Object.freeze([256,512,1024,2048,4096].map(kib=>kib*1024));
export const defaultChunkSize=1024*1024;

export function partLength(total,chunk,index){
  if(!Number.isSafeInteger(total)||total<1||!chunkSizes.includes(chunk)||!Number.isSafeInteger(index)||index<0||index>=Math.ceil(total/chunk))return null;
  return Math.min(chunk,total-index*chunk);
}
