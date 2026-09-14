import { GameError } from '../shared/inventory.js';
// Copy-on-write quarantine: original saves are never overwritten. Every private
// record uses a separate namespace and survives reconnection/redeploy.
export class ShadowStore {
 constructor(base,uid){this.base=base;this.prefix='shadow:'+uid+':';this.reads=new Map();this.manifest=base.get('meta',this.prefix+'index')||[];}
 name(kind,key){return this.prefix+kind+':'+key;}
 get(kind,key){const privateRow=this.base.get('meta',this.name(kind,key));const shared=this.base.get(kind,key);let result=privateRow?privateRow.value:shared;if(kind==='section'&&privateRow?.value)result={...(shared||{key,revision:0}),...privateRow.value,edits:{...shared?.edits,...privateRow.value.edits}};if(kind==='section')this.reads.set(key,structuredClone(result));return result;}
 put(kind,key,value){if(kind==='audit'){this.base.put('audit',key,{...value,action:'shadow.'+value.action,blocks:[],privateBlockCount:value.blocks?.length||0});return;}const name=this.name(kind,key);if(kind==='section'){const old=this.reads.get(key)?.edits||{},own={...(this.base.get('meta',name)?.value?.edits||{})};for(const [i,id] of Object.entries(value.edits))if(old[i]!==id)own[i]=id;value={...value,edits:own};}if(!this.manifest.includes(kind+'|'+key)){if(this.manifest.length>=1200)throw new GameError('shadow_capacity');this.manifest.push(kind+'|'+key);}this.base.put('meta',name,{value});}
 delete(kind,key){this.put(kind,key,null);}
 transaction(fn){const before=[...this.manifest];try{return this.base.transaction(()=>{const r=fn();this.base.put('meta',this.prefix+'index',this.manifest);return r;});}catch(e){this.manifest=before;throw e;}}
 sections(cx,cz){const rows=new Map(this.base.sections(cx,cz).map(s=>[s.key,s]));for(const entry of this.manifest){const[k,key]=entry.split('|');if(k==='section'){const[x,,z]=key.split(',').map(Number);if(x===cx&&z===cz)rows.set(key,this.get(k,key));}}return [...rows.values()].filter(Boolean);}
 nearby(x0,x1,z0,z1){const rows=new Map(this.base.nearby(x0,x1,z0,z1).map(e=>[e.uid,e]));for(const entry of this.manifest){const[k,key]=entry.split('|');if(k==='entity'){const e=this.get(k,key);rows.delete(key);if(e&&Math.floor(e.x/16)>=x0&&Math.floor(e.x/16)<=x1&&Math.floor(e.z/16)>=z0&&Math.floor(e.z/16)<=z1)rows.set(key,e);}}return [...rows.values()];}
}
