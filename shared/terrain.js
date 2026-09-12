// Generator v1: extracted unchanged from the original embedded terrain worker.
export function createTerrain(seedValue,blockDefs){

'use strict';
// The generation/meshing worker is constructed from this embedded script; no files are fetched.
const S=16,H=112,SEA=32,PAD=2,P=S+PAD*2;
let seed=seedValue,defs=blockDefs,epoch=0,cache=new Map(),edits={};
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v)),mix=(a,b,t)=>a+(b-a)*t;
function hash(x,y,z=0){let h=Math.imul(x|0,374761393)^Math.imul(y|0,668265263)^Math.imul(z|0,2147483647)^seed;h=Math.imul(h^(h>>>13),1274126177);return((h^(h>>>16))>>>0)/4294967295;}
function noise2(x,z){let a=Math.floor(x),b=Math.floor(z),u=x-a,v=z-b;u=u*u*(3-2*u);v=v*v*(3-2*v);return mix(mix(hash(a,b),hash(a+1,b),u),mix(hash(a,b+1),hash(a+1,b+1),u),v)*2-1;}
function noise3(x,y,z){let a=Math.floor(x),b=Math.floor(y),c=Math.floor(z),u=x-a,v=y-b,w=z-c;u=u*u*(3-2*u);v=v*v*(3-2*v);w=w*w*(3-2*w);return mix(mix(mix(hash(a,b,c),hash(a+1,b,c),u),mix(hash(a,b+1,c),hash(a+1,b+1,c),u),v),mix(mix(hash(a,b,c+1),hash(a+1,b,c+1),u),mix(hash(a,b+1,c+1),hash(a+1,b+1,c+1),u),v),w)*2-1;}
function fbm(x,z){return noise2(x,z)*.57+noise2(x*2.03+21,z*2.03+9)*.28+noise2(x*4.09-7,z*4.09+32)*.15;}
function terrain(x,z){
 const cont=noise2(x*.0055+21,z*.0055-32),base=43+fbm(x*.014,z*.014)*12+cont*6;
 const ridge=Math.max(0,noise2(x*.006-110,z*.006+300)-.15),mount=ridge*ridge*100;
 const river=Math.abs(noise2(x*.0065+88,z*.0065-170));
 const rt=clamp((river-.023)/.13,0,1),r=rt*rt*(3-2*rt);
 let h=Math.floor(mix(SEA-3+noise2(x*.07,z*.07)*1.4,base+mount,r));
 if(cont<-.60)h=Math.floor(mix(SEA-6, h,clamp((cont+.85)/.25,0,1)));
 h=clamp(h,13,91);
 const temp=noise2(x*.0048+340,z*.0048+177),wet=noise2(x*.008-340,z*.008-177);
 let biome=h<=SEA?7:h<=SEA+1?8:h>68?4:temp<-.40?4:temp>.20&&wet<-.17?3:wet>.47&&temp>-.08?6:wet>.16?(hash(Math.floor(x/75),Math.floor(z/75),83)>.56?2:1):h>55?5:0;
 return {h,biome,temp,wet};
}
const at=(x,y,z)=>(y*S+z)*S+x;
function generate(cx,cz){
 const key=cx+','+cz;if(cache.has(key))return cache.get(key);
 const data=new Uint8Array(S*S*H),heights=new Uint8Array(S*S),biomes=new Uint8Array(S*S),sky=new Uint8Array(data.length);
 const ox=cx*S,oz=cz*S,GY=H/4+1,ga=new Float32Array(5*5*GY),gb=new Float32Array(ga.length),gc=new Float32Array(ga.length);
 for(let gy=0;gy<GY;gy++)for(let gz=0;gz<5;gz++)for(let gx=0;gx<5;gx++){
  let wx=ox+gx*4,wy=gy*4,wz=oz+gz*4,i=(gy*5+gz)*5+gx;
  ga[i]=noise3(wx*.048,wy*.068,wz*.048);
  gb[i]=noise3(wx*.067+130,wy*.048-71,wz*.067+13);
  gc[i]=noise3(wx*.04-85,wy*.048+74,wz*.04+170);
 }
 function interp(a,x,y,z){let gx=x>>2,gy=y>>2,gz=z>>2,u=(x&3)*.25,v=(y&3)*.25,w=(z&3)*.25,i=(gy*5+gz)*5+gx;return mix(mix(mix(a[i],a[i+1],u),mix(a[i+5],a[i+6],u),w),mix(mix(a[i+25],a[i+26],u),mix(a[i+30],a[i+31],u),w),v);}
 for(let z=0;z<S;z++)for(let x=0;x<S;x++){
  const wx=ox+x,wz=oz+z,t=terrain(wx,wz),h=t.h,b=t.biome;heights[z*S+x]=h;biomes[z*S+x]=b;
  for(let y=0;y<=Math.max(h,SEA);y++){
   let id=0;
   if(y===0||(y===1&&hash(wx,wz,31)>.35))id=11;
   else if(y>h)id=10;
   else if(y===h)id=b===3||b===7||b===8?5:b===4?16:b===5&&h>61?3:1;
   else if(y>h-4)id=b===3||b===7||b===8?5:2;
   else {
    id=y<12?59:3;
    const cave=y>3&&y<h-2&&((Math.abs(interp(ga,x,y,z))<.12&&Math.abs(interp(gb,x,y,z))<.33)||interp(gc,x,y,z)>.58);
    if(cave)id=y<6?41:0;
    else {
     let ore=hash(Math.floor(wx/3),Math.floor(y/3)+100,Math.floor(wz/3));
     if(hash(wx,y,wz)>.16){if(ore<.047&&y<65)id=12;else if(ore<.073&&y<48)id=13;else if(ore<.086&&y<27)id=14;else if(ore<.093&&y<20)id=15;}
    }
   }
   data[at(x,y,z)]=id;
  }
  if(h>SEA+1&&h<H-12){
   const r=hash(wx,wz,97);
   if(data[at(x,h,z)]===1){let id=r<.17?34:r<.182?35:r<.194?36:r<.200?37:r<.209&&b!==0?39:0; if(id)data[at(x,h+1,z)]=id;}
   if(b===3){if(r<.009){for(let q=1;q<=2+Math.floor(hash(wx,wz,84)*3);q++)data[at(x,h+q,z)]=29;}else if(r<.035)data[at(x,h+1,z)]=38;}
  }
 }
 function put(wx,y,wz,id,leaves=false){let x=wx-ox,z=wz-oz;if(x<0||x>=S||z<0||z>=S||y<=0||y>=H)return;let i=at(x,y,z);if(!leaves||data[i]===0||defs[data[i]]?.plant)data[i]=id;}
 // Trees are anchored to a global cell grid and clipped into each chunk. Borders are deterministic.
 for(let gz=Math.floor((oz-4)/5);gz<=Math.floor((oz+S+3)/5);gz++)for(let gx=Math.floor((ox-4)/5);gx<=Math.floor((ox+S+3)/5);gx++){
  let wx=gx*5+1+Math.floor(hash(gx,gz,600)*3),wz=gz*5+1+Math.floor(hash(gx,gz,601)*3),t=terrain(wx,wz),b=t.biome;
  if(t.h<=SEA+2||t.h>78||b===3||b===5||b===7||b===8)continue;
  const chance=b===1?.75:b===2?.66:b===6?.62:b===4?.45:.105;if(hash(gx,gz,602)>chance)continue;
  const tall=4+Math.floor(hash(gx,gz,603)*3),base=t.h+1,log=b===2?17:b===4?20:b===6?48:7,leaf=b===2?19:b===4?22:b===6?49:9;
  if(b===4){for(let dy=2;dy<=tall+2;dy++){let rad=dy>tall?1:dy%2?2:1;for(let dz=-rad;dz<=rad;dz++)for(let dx=-rad;dx<=rad;dx++)if(Math.abs(dx)+Math.abs(dz)<=rad+1)put(wx+dx,base+dy,wz+dz,leaf,true);}}
  else for(let dy=tall-2;dy<=tall+1;dy++){let rad=dy===tall+1?1:2;for(let dz=-rad;dz<=rad;dz++)for(let dx=-rad;dx<=rad;dx++){if(Math.abs(dx)===rad&&Math.abs(dz)===rad&&(dy>tall-1||hash(wx+dx,wz+dz,dy)>.48))continue;put(wx+dx,base+dy,wz+dz,leaf,true);}}
  for(let y=0;y<tall;y++)put(wx,base+y,wz,log);
 }
 // Rare, weathered waystations: small ruins with a recoverable supply chest.
 for(let gz=Math.floor((oz-8)/80);gz<=Math.floor((oz+S+8)/80);gz++)for(let gx=Math.floor((ox-8)/80);gx<=Math.floor((ox+S+8)/80);gx++){
  if(hash(gx,gz,871)>.19)continue;
  let wx=gx*80+18+Math.floor(hash(gx,gz,872)*38),wz=gz*80+18+Math.floor(hash(gx,gz,873)*38),t=terrain(wx,wz);
  if(t.h<SEA+3||t.biome===4||t.h>58)continue;let y=t.h+1;
  for(let dz=-3;dz<=3;dz++)for(let dx=-3;dx<=3;dx++){
   put(wx+dx,y-1,wz+dz,28);
   if(Math.abs(dx)===3||Math.abs(dz)===3){let hh=Math.floor(hash(wx+dx,wz+dz,5)*4);for(let j=0;j<hh;j++)put(wx+dx,y+j,wz+dz,hash(dx,dz,j)>.4?28:27);}
   else {put(wx+dx,y,wz+dz,0);put(wx+dx,y+1,wz+dz,0);}
  }put(wx,y,wz,47);
 }
 const e=edits[key];if(e)for(const i in e)if(+i>=0&&+i<data.length)data[+i]=e[i];
 for(let z=0;z<S;z++)for(let x=0;x<S;x++){let l=15;for(let y=H-1;y>=0;y--){let i=at(x,y,z),id=data[i],d=defs[id];sky[i]=l;if(d?.opaque)l=0;else if(id===9||id===19||id===22||id===49)l=Math.max(0,l-2);else if(id===10)l=Math.max(0,l-1);}}
 const result={cx,cz,data,heights,biomes,sky};cache.set(key,result);return result;
}

return { generate(cx,cz){ const c=generate(cx,cz); if(cache.size>96)cache.delete(cache.keys().next().value); return c; }, terrain, clear(){cache.clear();} };
}
