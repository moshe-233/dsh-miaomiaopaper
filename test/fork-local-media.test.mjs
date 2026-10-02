import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { uploadLimitBytes, localMediaDescriptor } from '../lib/local-media.js';
import { sanitizeFromSchema, serializeSettings } from '../lib/settings-schema.js';

const model = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../src/picker-model.js', import.meta.url), 'utf8') + '\nthis.api={pickerModel,wallpaperSource,matchesSourceFilter,ratingOf,keepPlayingWallpaper,migrateLocalReferences,startupWallpaperId};', model);
const api = model.api;
const plain = (v) => JSON.parse(JSON.stringify(v));
const item = (id, extra = {}) => ({ id, type: 'video', playable: true, media: '/media/'+id, title: id, contentrating: 'everyone', ...extra });

test('upload cap: bounded explicit MiB and safe upstream default', () => {
  assert.equal(uploadLimitBytes(undefined), 512*1024*1024);
  assert.equal(uploadLimitBytes('2048'), 2*1024**3);
  assert.equal(uploadLimitBytes(' 1 '), 1024**2);
  assert.equal(uploadLimitBytes('8192'), 8192*1024**2);
  for (const raw of ['0','-1','Infinity','NaN','1.5','8193','1e9','0x100','',{},'9'.repeat(100)]) assert.equal(uploadLimitBytes(raw),512*1024**2);
});
test('drop-in IDs include extension, preserve Unicode and follow platform case semantics', () => {
  const mp4=localMediaDescriptor('猫 01.mp4','win32'),png=localMediaDescriptor('猫 01.png','win32');
  assert.notEqual(mp4.id,png.id);assert.equal(mp4.legacyId,png.legacyId);
  assert.equal(mp4.type,'video');assert.equal(png.type,'image');assert.equal(mp4.title,'猫 01');
  assert.equal(localMediaDescriptor('FOO.MP4','win32').id,localMediaDescriptor('foo.mp4','win32').id);
  assert.notEqual(localMediaDescriptor('FOO.MP4','linux').id,localMediaDescriptor('foo.mp4','linux').id);
  assert.equal(mp4.id,localMediaDescriptor('猫 01.mp4','win32').id);
});
test('drop-in descriptors reject paths, metadata, ADS, hidden and unsupported files', () => {
  for(const name of ['../a.mp4','a/b.mp4','a\\b.mp4','a:stream.mp4','a\0.mp4','.hidden.mp4','a.html','a.mp4:Zone.Identifier','a.mp4 ','','a.mp4.']) assert.equal(localMediaDescriptor(name),null,name);
});
test('new settings survive host/client serialize roundtrips without a second whitelist', () => {
  for(const sourceFilter of ['all','workshop','local']){
    const input={sourceFilter,defaultId:'local-123'};
    const client=sanitizeFromSchema(input,'client'),host=sanitizeFromSchema(serializeSettings(client),'host');
    assert.equal(host.sourceFilter,sourceFilter);assert.equal(host.defaultId,input.defaultId);
  }
  assert.equal(sanitizeFromSchema({sourceFilter:'untrusted',defaultId:23},'host').sourceFilter,'all');
  assert.equal(sanitizeFromSchema({defaultId:23},'host').defaultId,'');
});
test('source filtering is pure, paginated and independent of current playback', () => {
  const list=[item('a',{source:'workshop'}),item('local-b',{source:'local'}),item('up-c')];
  const copy=JSON.stringify(list);
  const input={wallpapers:list,ratingFilter:'everyone',typeFilter:'all',sourceFilter:'local',page:100};
  const result=api.pickerModel(input);
  assert.deepEqual(plain(result.playableList.map(w=>w.id)),['local-b','up-c']);
  assert.equal(result.normalPage.page,0);assert.equal(result.basePlayable.length,2);
  assert.equal(api.keepPlayingWallpaper(list[0],'everyone'),true);
  assert.equal(JSON.stringify(list),copy);
  assert.equal(api.pickerModel({...input,sourceFilter:'workshop'}).playableList.length,1);
});
test('local default rating never overrides explicit restrictions', () => {
  assert.equal(api.ratingOf(item('local-a',{source:'local',contentrating:null})),'everyone');
  assert.equal(api.ratingOf(item('local-a',{source:'local',contentrating:'mature'})),'mature');
  assert.equal(api.keepPlayingWallpaper(item('local-a',{source:'local',contentrating:'mature'}),'everyone'),false);
});
test('legacy ID migration remaps references only for unambiguous aliases', () => {
  const old={id:'file-a',defaultId:'file-a',hiddenIds:['file-a'],rotationGroups:[{id:'g',videoOnly:true,order:'loop',wallpaperIds:['file-a','missing']}]};
  const copy=JSON.stringify(old);
  const next=plain(api.migrateLocalReferences(old,[item('local-new',{legacyId:'file-a'})]));
  assert.equal(next.id,'local-new');assert.equal(next.defaultId,'local-new');
  assert.deepEqual(next.hiddenIds,['local-new']);assert.deepEqual(next.rotationGroups[0].wallpaperIds,['local-new','missing']);
  assert.equal(next.rotationGroups[0].videoOnly,true);assert.equal(next.rotationGroups[0].order,'loop');assert.equal(JSON.stringify(old),copy);
  assert.equal(api.migrateLocalReferences(old,[item('a',{legacyId:'file-a'}),item('b',{legacyId:'file-a'})]).id,'file-a');
  assert.equal(api.migrateLocalReferences(old,[item('file-a'),item('a',{legacyId:'file-a'})]).id,'file-a');
});
test('startup default overrides valid previous selection and rejects hidden/restricted/missing targets', () => {
  const list=[item('current'),item('default')];const s={id:'current',defaultId:'default',contentRatingFilter:'everyone',hiddenIds:[]};
  assert.equal(api.startupWallpaperId(s,list),'default');
  assert.equal(api.startupWallpaperId({...s,id:'default'},list),'');
  assert.equal(api.startupWallpaperId({...s,id:''},list),'default');
  assert.equal(api.startupWallpaperId({...s,id:'gone'},list),'default');
  assert.equal(api.startupWallpaperId({...s,id:'',hiddenIds:['default']},list),'');
  assert.equal(api.startupWallpaperId({...s,id:'',defaultId:'missing'},list),'');
  assert.equal(api.startupWallpaperId({...s,id:''},[item('default',{contentrating:'mature'})]),'');
  assert.equal(api.startupWallpaperId({...s,id:'',sourceFilter:'local'},list),'default');
});

function bootHarness(initial={}) {
  const source=fs.readFileSync(new URL('../src/client.js',import.meta.url),'utf8');
  const extract=(name)=>{const start=source.indexOf((name==='loadInventory'?'async ':'')+'function '+name+'(');const end=source.indexOf('\n}\n',start)+3;assert.ok(start>=0&&end>start);return source.slice(start,end);};
  const selection={...sanitizeFromSchema({},'client'),...initial,rotationSeeded:true};
  const pending=[],applied=[];
  const c=vm.createContext({...api,selection,INVENTORY_URL:'/inventory',emit:()=>{},persistSelection:()=>{},scheduleSceneVideoResync:()=>{},
    setTransient:(k,v)=>selection[k]=v,setSetting:(k,v)=>selection[k]=v,
    apiJson:()=>new Promise(resolve=>pending.push(resolve)),hostFailureReason:()=> 'offline',
    applySelection:id=>{selection.id=id;applied.push(id);},revalidateSelection:()=>{},
  });
  vm.runInContext('let inventorySeq=0;let startupWallpaperResolved=false;let propsPanelOpen=false;\n'+extract('loadInventory')+'\n'+extract('onClear'),c);
  return {c,selection,pending,applied,resolve:(data)=>pending.shift()({ok:true,data:{wallpapers:data,playlists:[]}})};
}
test('actual inventory loader applies startup default once and clear beats a delayed response',async()=>{
  const h=bootHarness({defaultId:'default'});let job=h.c.loadInventory();h.resolve([item('default')]);await job;
  assert.deepEqual(h.applied,['default']);h.c.onClear();job=h.c.loadInventory();h.resolve([item('default')]);await job;assert.equal(h.selection.id,'');
  const delayed=bootHarness({defaultId:'default'});job=delayed.c.loadInventory();delayed.c.onClear();delayed.resolve([item('default')]);await job;assert.deepEqual(delayed.applied,['']);
});
test('actual inventory loader overrides valid current and ignores superseded responses',async()=>{
  const h=bootHarness({id:'current',defaultId:'default'});let job=h.c.loadInventory();h.resolve([item('current'),item('default')]);await job;assert.deepEqual(h.applied,['default']);
  const race=bootHarness({defaultId:'default'}),old=race.c.loadInventory(),fresh=race.c.loadInventory();
  race.pending[1]({ok:true,data:{wallpapers:[item('default')],playlists:[]}});await fresh;
  race.pending[0]({ok:true,data:{wallpapers:[],playlists:[]}});await old;
  assert.deepEqual(race.applied,['default']);assert.equal(race.selection.inventory.wallpapers.length,1);
});

test('startup default wins over a migrated previous id; missing default retains current',async()=>{
  const h=bootHarness({id:'file-old',defaultId:'default'});const job=h.c.loadInventory();
  h.resolve([item('local-current',{legacyId:'file-old'}),item('default')]);await job;
  assert.deepEqual(h.applied,['default']);
  const keep=bootHarness({id:'current',defaultId:'missing'});const next=keep.c.loadInventory();keep.resolve([item('current')]);await next;
  assert.deepEqual(keep.applied,[]);assert.equal(keep.selection.id,'current');
});
