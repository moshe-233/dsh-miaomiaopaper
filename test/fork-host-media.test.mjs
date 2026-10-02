import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import { localMediaDescriptor, uploadLimitBytes } from '../lib/local-media.js';
import { registerUploadRoutes } from '../lib/routes/upload.js';
// 折行尾：下面按 '\n/**\n * Validate + normalize' 定位切片，CRLF 检出下会恒找不到。
const host=fs.readFileSync(new URL('../lib/index.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
// Evaluate the unchanged production scanner/removal resolver against a temporary
// fixture, avoiding Steam discovery and any access to a user's real library.
const start=host.indexOf('async function enumerateUploadsP(dir) {');
const end=host.indexOf('\n/**\n * Validate + normalize',start);
assert.ok(start>=0 && end>start);
const re=host.match(/const UPLOAD_FILE_RE = ([^;]+);/);assert.ok(re);
const c=vm.createContext({...path,stat:fsp.stat,readdir:fsp.readdir,readdirSync:fs.readdirSync,lstatSync:fs.lstatSync,
  localMediaDescriptor,pathExistsP:async p=>{try{await fsp.access(p);return true;}catch{return false;}},
  readProjectP:async()=>null,SCAN_CHUNK:24});
vm.runInContext('const UPLOAD_FILE_RE = '+re[1]+';\n'+host.slice(start,end),c);

test('production scanner indexes direct media without collisions; ignores hidden/nested/linked files and refuses removal',async(t)=>{
  const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'we-fork-scan-'));
  try {
    for(const name of ['same.mp4','same.png','猫.jpg','.hidden.mp4','note.txt','up-managed.mp4'])await fsp.writeFile(path.join(dir,name),'fixture');
    await fsp.mkdir(path.join(dir,'nested'));await fsp.writeFile(path.join(dir,'nested','private.mp4'),'fixture');
    await fsp.writeFile(path.join(dir,'linked.mp4'),'fixture');await fsp.link(path.join(dir,'linked.mp4'),path.join(dir,'hardlink.mp4'));
    try{await fsp.symlink(path.join(dir,'same.mp4'),path.join(dir,'symlink.mp4'),'file');}catch(e){if(e.code!=='EPERM')throw e;t.diagnostic('symlink creation denied by OS; that branch is not covered here');}
    const items=await c.enumerateUploadsP(dir);
    assert.equal(items.length,4);assert.equal(new Set(items.map(w=>w.id)).size,4);
    const personal=items.filter(w=>w.id.startsWith('local-'));assert.equal(personal.length,3);
    assert.notEqual(personal.find(w=>w.fileAbs.endsWith('same.mp4')).id,personal.find(w=>w.fileAbs.endsWith('same.png')).id);
    for(const w of personal){assert.equal(c.resolveUploadFile(dir,w.id),null);assert.ok(fs.existsSync(w.fileAbs));}
    for(const bad of ['../same','file-c2FtZQ','local-anything','up-../same'])assert.equal(c.resolveUploadFile(dir,bad),null);
    assert.equal(c.resolveUploadFile(dir,'up-managed'),path.join(dir,'up-managed.mp4'));
    assert.deepEqual(items.map(w=>w.id),(await c.enumerateUploadsP(dir)).map(w=>w.id));
  } finally { await fsp.rm(dir,{recursive:true,force:true}); }
});

test('real streaming upload route enforces configured cap and returns its actual limit; drop-in removal is rejected',async()=>{
  const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'we-fork-upload-')),routes=[];
  await fsp.writeFile(path.join(dir,'personal.mp4'),'personal');
  registerUploadRoutes({register:r=>{routes.push(r);return()=>{};}},{
    disposers:[],base:'/wallpaper-engine',tokenFor:p=>Buffer.from(p).toString('base64url'),UPLOAD_EXT:{'video/mp4':'mp4'},UPLOAD_MAX_BYTES:uploadLimitBytes('1'),
    ensureUploadDir:()=>dir,readUploadMeta:()=>({}),metaEntry:()=>({}),setUploadMeta:()=>{},removeUploadMeta:()=>{},
    resolveUploadFile:c.resolveUploadFile,setUploadDir:()=>{},normalizeUserDir:()=>null,armBodyIdleTimeout:()=>{},lingerClose:()=>{},
  });
  const server=http.createServer((req,res)=>{const r=routes.find(r=>r.path===new URL(req.url,'http://x').pathname);if(r)r.handler(req,res);else{res.statusCode=404;res.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port+'/wallpaper-engine';
  try {
    const over=await fetch(base+'/upload',{method:'POST',headers:{'Content-Type':'video/mp4'},body:Buffer.alloc(1024*1024+1)});
    assert.equal(over.status,413);const payload=await over.json();assert.equal(payload.limit,1);assert.ok(payload.error.includes('{limit}'));
    const ok=await fetch(base+'/upload',{method:'POST',headers:{'Content-Type':'video/mp4'},body:Buffer.from('tiny test fixture')});assert.equal(ok.status,200);
    const reject=await fetch(base+'/remove',{method:'POST',body:JSON.stringify({id:localMediaDescriptor('personal.mp4').id})});
    assert.equal(reject.status,400);assert.equal(await fsp.readFile(path.join(dir,'personal.mp4'),'utf8'),'personal');
    assert.equal((await fsp.readdir(dir)).filter(n=>n.endsWith('.tmp')).length,0);
  } finally {
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fsp.rm(dir,{recursive:true,force:true});
  }
});
