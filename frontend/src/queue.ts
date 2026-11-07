import {api,ApiError,send} from './api';
export type Pending={id:string,token:string,mime:string,meeting:string,label:string,count:number,closed:boolean,duration?:number,error?:string,fileSize?:number,chunkSize?:number};
const db=()=>new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('huh-audio',1);r.onupgradeneeded=()=>{r.result.createObjectStore('sessions',{keyPath:'id'});r.result.createObjectStore('chunks',{keyPath:['id','index']})};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
async function transaction<T>(store:string,mode:IDBTransactionMode,fn:(s:IDBObjectStore)=>IDBRequest<T>):Promise<T>{const d=await db();return new Promise((resolve,reject)=>{const t=d.transaction(store,mode);const r=fn(t.objectStore(store));t.oncomplete=()=>{d.close();resolve(r.result)};t.onerror=()=>{d.close();reject(t.error)};t.onabort=()=>{d.close();reject(t.error)}})}
export const sessions=()=>transaction<Pending[]>('sessions','readonly',s=>s.getAll());
export const saveSession=(p:Pending)=>transaction('sessions','readwrite',s=>s.put(p));
export async function appendChunk(p:Pending,blob:Blob){const d=await db();await new Promise<void>((resolve,reject)=>{const t=d.transaction(['sessions','chunks'],'readwrite');t.objectStore('chunks').put({id:p.id,index:p.count,blob});t.objectStore('sessions').put({...p,count:p.count+1});t.oncomplete=()=>{p.count++;d.close();resolve()};t.onabort=t.onerror=()=>{d.close();reject(t.error)}})}
export const saveChunk=(id:string,index:number,blob:Blob)=>transaction('chunks','readwrite',s=>s.put({id,index,blob}));
async function updateError(id:string,error?:string){const d=await db();await new Promise<void>((resolve,reject)=>{const t=d.transaction('sessions','readwrite');const store=t.objectStore('sessions');const get=store.get(id);get.onsuccess=()=>{if(get.result)store.put({...get.result,error})};t.oncomplete=()=>{d.close();resolve()};t.onerror=()=>{d.close();reject(t.error)}})}
/** Remove a local upload session and all of its buffered audio. */
export async function forget(id:string){const d=await db();await new Promise<void>((resolve,reject)=>{const t=d.transaction(['sessions','chunks'],'readwrite');t.objectStore('sessions').delete(id);t.objectStore('chunks').delete(IDBKeyRange.bound([id,-Infinity],[id,Infinity]));t.oncomplete=()=>{d.close();resolve()};t.onabort=t.onerror=()=>{d.close();reject(t.error)}})}
/** Drop everything this browser still holds for a deleted meeting. */
export async function forgetMeeting(meeting:string){for(const p of await sessions())if(p.meeting===meeting)await forget(p.id);if(typeof sessionStorage==='undefined')return;const keys:string[]=[];for(let i=0;i<sessionStorage.length;i++){const k=sessionStorage.key(i);if(k?.startsWith(`huh-draft-${meeting}-`))keys.push(k)}keys.forEach(k=>sessionStorage.removeItem(k))}
const locks=new Map<string,Promise<void>>();
export function drain(p:Pending):Promise<void>{const existing=locks.get(p.id);if(existing)return existing;const run=(async()=>{
 try{for(let index=0;index<p.count;index++){const chunk=await transaction<{blob:Blob}|undefined>('chunks','readonly',s=>s.get([p.id,index]));if(chunk){await api(`/recordings/${p.id}/chunks/${index}`,{method:'PUT',headers:{'Content-Type':p.mime,'X-Recording-Token':p.token},body:chunk.blob});await transaction('chunks','readwrite',s=>s.delete([p.id,index]));}}
 if(p.closed){await send(`/recordings/${p.id}/finish`,{token:p.token,chunk_count:p.count,duration:p.duration});await transaction('sessions','readwrite',s=>s.delete(p.id));}else {p.error=undefined;await updateError(p.id)}
 }catch(e){
  // 404: the recording (or its meeting) was deleted on the server — keep nothing locally.
  // Only this API's own "Not found" counts — a proxy/network 404 must never discard audio.
  if(e instanceof ApiError&&e.status===404&&e.message==='Not found'){await forget(p.id);return}
  p.error=e instanceof Error?e.message:String(e);await updateError(p.id,p.error);throw e}
 })().finally(()=>locks.delete(p.id));locks.set(p.id,run);return run}
export async function bufferFile(file:File,meeting:string,mode:string,onProgress:(message:string)=>void){const result=await send(`/meetings/${meeting}/uploads`,{filename:file.name,mime_type:file.type||'audio/mp4',size:file.size,mode});const p:Pending={fileSize:file.size,chunkSize:result.chunk_size,id:result.recording_id,token:result.token,mime:file.type||'audio/mp4',meeting,label:file.name,count:0,closed:false};await saveSession(p);for(let offset=0;offset<file.size;offset+=result.chunk_size){await appendChunk(p,file.slice(offset,offset+result.chunk_size));onProgress(`Saved ${Math.min(100,Math.round((offset+result.chunk_size)/file.size*100))}% locally`)}p.closed=true;await saveSession(p);await drain(p)}

export async function resumeFile(p:Pending,file:File){if(file.size!==p.fileSize||file.name!==p.label)throw Error('Choose the original file with the same name and size.');for(let offset=p.count*p.chunkSize!;offset<file.size;offset+=p.chunkSize!)await appendChunk(p,file.slice(offset,offset+p.chunkSize!));p.closed=true;await saveSession(p);await drain(p)}
