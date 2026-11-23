import {attachmentText} from './core.mjs';

export async function extractAttachment(name,mime,buffer){
  if(!/\.pdf$/i.test(name)&&mime!=='application/pdf')return attachmentText(name,mime,buffer);
  // PDF support is loaded lazily from the pdfjs-dist npm package (legacy build works in plain Node).
  // Text extraction needs no canvas/DOMMatrix; pdf.js only warns once that rendering polyfills are absent.
  const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task=getDocument({data:new Uint8Array(buffer),isEvalSupported:false,disableFontFace:true,useSystemFonts:true});
  const doc=await task.promise;
  try{
    let text='';
    for(let pageNo=1;pageNo<=Math.min(doc.numPages,100);pageNo++){
      const page=await doc.getPage(pageNo),content=await page.getTextContent();
      text+='\nСтраница '+pageNo+'\n'+content.items.map(i=>i.str+(i.hasEOL?'\n':' ')).join('');
      if(text.length>100000){text+='\n[Документ обрезан]';break;}
    }
    if(!text.replace(/Страница \d+/g,'').trim())throw Error('В PDF нет извлекаемого текста. Для сканов нужен OCR.');
    return text;
  }finally{await task.destroy();}
}
