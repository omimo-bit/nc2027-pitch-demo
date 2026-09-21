/*
 * NC 2027 Visual Audit Prototype
 * ------------------------------------------------------------
 * Runs fully in the browser. No image is sent to GAS by this file.
 * The engine uses classical computer vision + reference-assisted
 * similarity scoring for a real, deterministic pitch prototype.
 * It is NOT a production trained SKU detector; production accuracy
 * requires a labeled shelf-image dataset and model validation.
 */
(function () {
  'use strict';

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  function makeCanvas(w, h) {
    const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
  }

  function loadFile(file, maxWidth = 1200) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.naturalWidth);
        const c = makeCanvas(Math.max(1, Math.round(img.naturalWidth * scale)), Math.max(1, Math.round(img.naturalHeight * scale)));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url); resolve(c);
      };
      img.onerror = err => { URL.revokeObjectURL(url); reject(err); };
      img.src = url;
    });
  }

  function cloneCanvas(src) {
    const c = makeCanvas(src.width, src.height); c.getContext('2d').drawImage(src, 0, 0); return c;
  }

  function cropCanvas(src, x, y, w, h) {
    const c = makeCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
    c.getContext('2d').drawImage(src, x, y, w, h, 0, 0, c.width, c.height); return c;
  }

  function imageStats(canvas) {
    const ctx = canvas.getContext('2d', {willReadFrequently:true});
    const {data, width, height} = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let sum = 0, sum2 = 0, lap = 0, count = width * height;
    const gray = new Float32Array(count);
    for (let i=0,p=0;i<data.length;i+=4,p++) {
      const g = data[i]*.299 + data[i+1]*.587 + data[i+2]*.114;
      gray[p]=g; sum+=g; sum2+=g*g;
    }
    for (let y=1;y<height-1;y+=2) for (let x=1;x<width-1;x+=2) {
      const p=y*width+x;
      const l = Math.abs(4*gray[p]-gray[p-1]-gray[p+1]-gray[p-width]-gray[p+width]);
      lap += l;
    }
    const mean = sum/count, variance = Math.max(0,sum2/count-mean*mean);
    return {
      brightness: Math.round(mean),
      contrast: Math.round(Math.sqrt(variance)),
      sharpness: Math.round((lap / Math.max(1, ((width-2)*(height-2)/4))) * 10) / 10
    };
  }

  function rgbHistogram(canvas, bins=4) {
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    const data=ctx.getImageData(0,0,canvas.width,canvas.height).data;
    const hist=new Float32Array(bins*bins*bins); let total=0;
    for(let i=0;i<data.length;i+=16){
      const r=Math.min(bins-1,Math.floor(data[i]/256*bins));
      const g=Math.min(bins-1,Math.floor(data[i+1]/256*bins));
      const b=Math.min(bins-1,Math.floor(data[i+2]/256*bins));
      hist[r*bins*bins+g*bins+b]++; total++;
    }
    if(total) for(let i=0;i<hist.length;i++) hist[i]/=total;
    return hist;
  }

  function cosine(a,b){let dot=0,aa=0,bb=0;for(let i=0;i<a.length;i++){dot+=a[i]*b[i];aa+=a[i]*a[i];bb+=b[i]*b[i];}return dot/(Math.sqrt(aa*bb)+1e-9);}

  function kmeansPalette(canvas, k=4, iterations=6) {
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    const d=ctx.getImageData(0,0,canvas.width,canvas.height).data;const pts=[];
    const stride=Math.max(4,Math.floor((canvas.width*canvas.height)/700));
    for(let p=0;p<canvas.width*canvas.height;p+=stride){const i=p*4;if(d[i+3]<200)continue;pts.push([d[i]/255,d[i+1]/255,d[i+2]/255]);}
    if(!pts.length)return [];k=Math.min(k,pts.length);const cent=[];for(let i=0;i<k;i++)cent.push(pts[Math.floor(i*(pts.length-1)/Math.max(1,k-1))].slice());let assign=new Int16Array(pts.length);
    for(let it=0;it<iterations;it++){const sums=Array.from({length:k},()=>[0,0,0,0]);for(let i=0;i<pts.length;i++){let bi=0,bd=1e9;for(let c=0;c<k;c++){const dr=pts[i][0]-cent[c][0],dg=pts[i][1]-cent[c][1],db=pts[i][2]-cent[c][2],dd=dr*dr+dg*dg+db*db;if(dd<bd){bd=dd;bi=c;}}assign[i]=bi;sums[bi][0]+=pts[i][0];sums[bi][1]+=pts[i][1];sums[bi][2]+=pts[i][2];sums[bi][3]++;}for(let c=0;c<k;c++)if(sums[c][3])cent[c]=[sums[c][0]/sums[c][3],sums[c][1]/sums[c][3],sums[c][2]/sums[c][3]];}
    const counts=new Array(k).fill(0);assign.forEach(x=>counts[x]++);return cent.map((c,i)=>({rgb:c,w:counts[i]/pts.length})).sort((a,b)=>b.w-a.w);
  }
  function paletteSimilarity(a,b){if(!a.length||!b.length)return 0;let score=0,weight=0;for(const pa of a){let best=0;for(const pb of b){const dr=pa.rgb[0]-pb.rgb[0],dg=pa.rgb[1]-pb.rgb[1],db=pa.rgb[2]-pb.rgb[2],dist=Math.sqrt(dr*dr+dg*dg+db*db)/1.732;best=Math.max(best,1-dist);}score+=best*pa.w;weight+=pa.w;}return score/Math.max(1e-9,weight);}

  function edgeDensity(canvas) {
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    const {data,width,height}=ctx.getImageData(0,0,canvas.width,canvas.height);
    let edges=0,total=0;
    for(let y=1;y<height-1;y+=2) for(let x=1;x<width-1;x+=2){
      const i=(y*width+x)*4, il=(y*width+x-1)*4, ir=(y*width+x+1)*4, it=((y-1)*width+x)*4, ib=((y+1)*width+x)*4;
      const g=(data[i]+data[i+1]+data[i+2])/3;
      const gx=Math.abs((data[ir]+data[ir+1]+data[ir+2])/3-(data[il]+data[il+1]+data[il+2])/3);
      const gy=Math.abs((data[ib]+data[ib+1]+data[ib+2])/3-(data[it]+data[it+1]+data[it+2])/3);
      if(gx+gy>55 && g<245) edges++; total++;
    }
    return edges/Math.max(1,total);
  }

  function saturationMean(canvas){
    const data=canvas.getContext('2d',{willReadFrequently:true}).getImageData(0,0,canvas.width,canvas.height).data;let s=0,n=0;
    for(let i=0;i<data.length;i+=20){const mx=Math.max(data[i],data[i+1],data[i+2]),mn=Math.min(data[i],data[i+1],data[i+2]);s+=mx?((mx-mn)/mx):0;n++;}return s/Math.max(1,n);
  }

  function detectShelfLines(canvas) {
    const smallW=Math.min(700,canvas.width), scale=smallW/canvas.width, smallH=Math.round(canvas.height*scale);
    const c=makeCanvas(smallW,smallH); c.getContext('2d').drawImage(canvas,0,0,smallW,smallH);
    const {data,width,height}=c.getContext('2d',{willReadFrequently:true}).getImageData(0,0,smallW,smallH);
    const energy=new Float32Array(height);
    const gray=(i)=>data[i]*.299+data[i+1]*.587+data[i+2]*.114;
    for(let y=1;y<height;y++){
      let e=0;for(let x=0;x<width;x+=3){const i=(y*width+x)*4,j=((y-1)*width+x)*4;e+=Math.abs(gray(i)-gray(j));}
      energy[y]=e/(width/3);
    }
    const peaks=[];for(let y=5;y<height-5;y++){if(energy[y]>energy[y-1]&&energy[y]>=energy[y+1])peaks.push({y,score:energy[y]});}
    peaks.sort((a,b)=>b.score-a.score);const chosen=[];const minDist=Math.max(22,Math.round(height*.09));
    for(const p of peaks){if(chosen.every(q=>Math.abs(q.y-p.y)>minDist)){chosen.push(p);if(chosen.length>=5)break;}}
    chosen.sort((a,b)=>a.y-b.y);
    return chosen.map(p=>Math.round(p.y/scale));
  }

  function iou(a,b){const x1=Math.max(a.x,b.x),y1=Math.max(a.y,b.y),x2=Math.min(a.x+a.w,b.x+b.w),y2=Math.min(a.y+a.h,b.y+b.h);const inter=Math.max(0,x2-x1)*Math.max(0,y2-y1);return inter/(a.w*a.h+b.w*b.h-inter+1e-9);}

  function referenceMatches(shelf, ref, opts={}) {
    const refHist=rgbHistogram(ref), refEdge=edgeDensity(ref), refSat=saturationMean(ref), refPalette=kmeansPalette(ref,4,5);
    const aspect=ref.width/ref.height;
    const baseH=clamp(Math.round(shelf.height*(opts.relativeHeight||0.17)),50,Math.max(60,Math.round(shelf.height*.28)));
    const winH=opts.windowHeight||baseH, winW=opts.windowWidth||Math.round(winH*aspect);
    const stepX=Math.max(12,Math.round(winW*.36)),stepY=Math.max(14,Math.round(winH*.28));
    const candidates=[];
    for(let y=0;y+winH<=shelf.height;y+=stepY){for(let x=0;x+winW<=shelf.width;x+=stepX){
      const p=cropCanvas(shelf,x,y,winW,winH);const sim=cosine(refHist,rgbHistogram(p));const ed=edgeDensity(p),sat=saturationMean(p);
      const edgeScore=1-clamp(Math.abs(ed-refEdge)/Math.max(.05,refEdge+.03),0,1);
      const satScore=1-clamp(Math.abs(sat-refSat)/Math.max(.2,refSat+.1),0,1);
      const paletteScore=paletteSimilarity(refPalette,kmeansPalette(p,4,4));
      const score=sim*.62+edgeScore*.14+satScore*.10+paletteScore*.14;
      if(score>(opts.threshold||.76)) candidates.push({x,y,w:winW,h:winH,score});
    }}
    candidates.sort((a,b)=>b.score-a.score);const keep=[];
    for(const c of candidates){if(keep.every(k=>iou(c,k)<.25)){keep.push(c);if(keep.length>40)break;}}
    return keep;
  }

  function estimateCategoryFacings(shelf, shelfLines, ref) {
    const aspect=ref.width/ref.height;
    const lines=[0,...shelfLines,shelf.height].filter((v,i,a)=>i===0||v-a[i-1]>25);
    let count=0;const boxes=[];
    for(let i=0;i<lines.length-1;i++){
      const top=lines[i]+4,bottom=lines[i+1]-5,h=bottom-top;
      if(h<45) continue;
      const winH=Math.min(Math.round(h*.78),Math.round(shelf.height*.2));const winW=Math.max(35,Math.round(winH*aspect));const step=Math.max(28,Math.round(winW*.82));
      for(let x=4;x+winW<shelf.width;x+=step){const p=cropCanvas(shelf,x,top,winW,winH);const ed=edgeDensity(p),sat=saturationMean(p);if(ed>.045&&sat>.10){count++;boxes.push({x,y:top,w:winW,h:winH});}}
    }
    return {count,boxes};
  }

  function bandIndex(y, lines, h) { const sorted=[0,...lines,h].sort((a,b)=>a-b);for(let i=0;i<sorted.length-1;i++)if(y>=sorted[i]&&y<sorted[i+1])return i+1;return sorted.length-1; }

  function detectPosm(shelf){
    const ctx=shelf.getContext('2d',{willReadFrequently:true}),{data,width,height}=ctx.getImageData(0,0,shelf.width,Math.max(1,Math.round(shelf.height*.25)));let hit=0,n=0;
    for(let i=0;i<data.length;i+=16){const r=data[i],g=data[i+1],b=data[i+2];if(r>160&&g>55&&g<190&&b<100&&r>g*1.15)hit++;n++;}
    const ratio=hit/Math.max(1,n);return {detected:ratio>.012,score:Math.round(clamp(ratio/.035,0,1)*100)};
  }

  function analyze(shelf, ref, opts={}) {
    const stats=imageStats(shelf), lines=detectShelfLines(shelf), matches=referenceMatches(shelf,ref,opts), category=estimateCategoryFacings(shelf,lines,ref);
    const targetFacing=matches.length, totalFacing=Math.max(targetFacing,category.count||targetFacing), sos=totalFacing?targetFacing/totalFacing*100:0;
    const shelfCounts={};matches.forEach(m=>{const b=bandIndex(m.y+m.h/2,lines,shelf.height);shelfCounts[b]=(shelfCounts[b]||0)+1;});
    let dominantShelf=0,domCount=0;Object.keys(shelfCounts).forEach(k=>{if(shelfCounts[k]>domCount){domCount=shelfCounts[k];dominantShelf=Number(k);}});
    const expectedShelf=Number(opts.expectedShelf||2);const planogram=targetFacing?Math.max(0,100-Math.abs(dominantShelf-expectedShelf)*28):0;
    const posm=detectPosm(shelf);
    let confidence=0;if(matches.length) confidence=matches.reduce((s,m)=>s+m.score,0)/matches.length*100;
    const qualityPenalty=(stats.brightness<55||stats.brightness>225?18:0)+(stats.contrast<25?12:0)+(stats.sharpness<16?15:0);
    confidence=clamp(confidence-qualityPenalty,0,99);
    return {quality:stats,shelfLines:lines,matches,categoryBoxes:category.boxes.slice(0,80),targetFacing,totalFacing,sos:Math.round(sos*10)/10,availability:targetFacing>0,osa:targetFacing>0?100:0,dominantShelf,expectedShelf,planogram:Math.round(planogram),posm,confidence:Math.round(confidence)};
  }

  function drawOverlay(shelf, result) {
    const out=cloneCanvas(shelf),ctx=out.getContext('2d');ctx.lineWidth=Math.max(2,Math.round(out.width/400));ctx.font=`${Math.max(12,Math.round(out.width/70))}px Arial`;
    ctx.strokeStyle='rgba(17,91,159,.65)';result.shelfLines.forEach(y=>{ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(out.width,y);ctx.stroke();});
    ctx.strokeStyle='#1f8f63';ctx.fillStyle='rgba(31,143,99,.12)';result.matches.forEach((m,i)=>{ctx.fillRect(m.x,m.y,m.w,m.h);ctx.strokeRect(m.x,m.y,m.w,m.h);ctx.fillStyle='#0d6847';ctx.fillText(String(i+1),m.x+4,m.y+16);ctx.fillStyle='rgba(31,143,99,.12)';});
    return out;
  }

  function makeDemoAssets() {
    const shelf=makeCanvas(960,620),ctx=shelf.getContext('2d');ctx.fillStyle='#e8ecef';ctx.fillRect(0,0,960,620);
    ctx.fillStyle='#f9fbfc';ctx.fillRect(25,28,910,72);ctx.fillStyle='#e46f1d';ctx.fillRect(25,28,330,72);ctx.fillStyle='#fff';ctx.font='bold 27px Arial';ctx.fillText('ENFAGROW A+',52,73);ctx.fillStyle='#244766';ctx.font='bold 18px Arial';ctx.fillText('Growing Up Milk · Demo Shelf',390,71);
    const shelfYs=[190,350,510];ctx.fillStyle='#9da8b1';shelfYs.forEach(y=>{ctx.fillRect(20,y,920,13);ctx.fillStyle='#c7cfd6';ctx.fillRect(20,y+13,920,7);ctx.fillStyle='#9da8b1';});
    function pack(x,y,w,h,type,label,price){ctx.fillStyle=type==='target'?'#176fc1':type==='target2'?'#1d8ba6':type==='comp1'?'#7557a8':'#65a44e';ctx.fillRect(x,y,w,h);ctx.fillStyle='#fff';ctx.fillRect(x+7,y+9,w-14,23);ctx.fillStyle=type.startsWith('target')?'#ef8a28':'#f4c64b';ctx.fillRect(x+7,y+40,w-14,17);ctx.fillStyle='#fff';ctx.font='bold 12px Arial';ctx.fillText(label,x+10,y+27);ctx.fillStyle='#152c40';ctx.fillRect(x-1,y+h+4,w+2,26);ctx.fillStyle='#fff';ctx.font='bold 12px Arial';ctx.fillText(String(price),x+7,y+h+22);}
    const rows=[{y:75,types:['comp1','target','target','target','comp2','comp2','target','comp1','comp1']},{y:235,types:['target2','target','target','comp2','comp2','target','target','comp1','comp1']},{y:395,types:['comp2','comp2','target','target','target','target','comp1','comp1','target']}];
    rows.forEach((r,ri)=>r.types.forEach((t,i)=>pack(42+i*98,r.y,76,94,t,t.startsWith('target')?'A+':'COMP',389900+ri*10000)));
    const ref=cropCanvas(shelf,140,75,76,94);
    const price=makeCanvas(420,140),p=price.getContext('2d');p.fillStyle='#fff';p.fillRect(0,0,420,140);p.strokeStyle='#b9c1c8';p.strokeRect(4,4,412,132);p.fillStyle='#182a3b';p.font='bold 24px Arial';p.fillText('ENFAGROW A+ 800G',24,42);p.font='bold 48px Arial';p.fillText('389900',105,105);
    return {shelf,ref,price};
  }

  function binaryDigit(canvas) {
    const target=makeCanvas(28,42),ctx=target.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,28,42);ctx.drawImage(canvas,0,0,28,42);const img=ctx.getImageData(0,0,28,42);const out=new Uint8Array(28*42);for(let i=0,p=0;i<img.data.length;i+=4,p++){const g=img.data[i]*.299+img.data[i+1]*.587+img.data[i+2]*.114;out[p]=g<150?1:0;}return out;
  }
  function digitTemplates(){const arr=[];for(let d=0;d<10;d++){const c=makeCanvas(36,52),x=c.getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,36,52);x.fillStyle='#111';x.font='bold 42px Arial';x.textAlign='center';x.textBaseline='middle';x.fillText(String(d),18,27);arr.push(binaryDigit(c));}return arr;}
  const DIGITS=digitTemplates();
  function ocrPrice(canvas) {
    const scale=2,c=makeCanvas(canvas.width*scale,canvas.height*scale),ctx=c.getContext('2d');ctx.imageSmoothingEnabled=true;ctx.drawImage(canvas,0,0,c.width,c.height);
    const img=ctx.getImageData(0,0,c.width,c.height),w=c.width,h=c.height,mask=new Uint8Array(w*h);
    for(let y=Math.floor(h*.35);y<h;y++)for(let x=0;x<w;x++){const i=(y*w+x)*4,g=img.data[i]*.299+img.data[i+1]*.587+img.data[i+2]*.114;if(g<110)mask[y*w+x]=1;}
    const visited=new Uint8Array(mask.length),comps=[];const stack=[];
    for(let y=Math.floor(h*.35);y<h;y++)for(let x=0;x<w;x++){const idx=y*w+x;if(!mask[idx]||visited[idx])continue;let minX=x,maxX=x,minY=y,maxY=y,n=0;stack.push(idx);visited[idx]=1;while(stack.length){const p=stack.pop(),py=Math.floor(p/w),px=p-py*w;n++;if(px<minX)minX=px;if(px>maxX)maxX=px;if(py<minY)minY=py;if(py>maxY)maxY=py;const ns=[p-1,p+1,p-w,p+w];for(const q of ns){if(q>=0&&q<mask.length&&!visited[q]&&mask[q]){visited[q]=1;stack.push(q);}}}const cw=maxX-minX+1,ch=maxY-minY+1;if(ch>30&&cw>8&&cw<90&&n>80)comps.push({x:minX,y:minY,w:cw,h:ch});}
    comps.sort((a,b)=>a.x-b.x);let text='';let confs=[];
    for(const b of comps.slice(-8)){const crop=cropCanvas(c,b.x,b.y,b.w,b.h),vec=binaryDigit(crop);let best=-1,score=-1;for(let d=0;d<10;d++){let same=0;for(let i=0;i<vec.length;i++)if(vec[i]===DIGITS[d][i])same++;const s=same/vec.length;if(s>score){score=s;best=d;}}if(score>.58){text+=best;confs.push(score);}}
    const value=text?Number(text):null;return {text,value,confidence:confs.length?Math.round(confs.reduce((a,b)=>a+b,0)/confs.length*100):0};
  }

  window.NCVision={loadFile,cloneCanvas,cropCanvas,imageStats,detectShelfLines,kmeansPalette,analyze,drawOverlay,makeDemoAssets,ocrPrice};
})();
