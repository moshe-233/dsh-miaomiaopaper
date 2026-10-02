import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { sanitizeFromSchema, serializeSettings } from '../lib/settings-schema.js';
const read = (p) => fs.readFileSync(new URL(p,import.meta.url),'utf8');
const controls = read('../src/fork-controls.js');
const playlist = read('../src/video-playlist.js');
const plain = (v) => JSON.parse(JSON.stringify(v));
function context(extra={}) { const c=vm.createContext(extra);vm.runInContext(controls+'\n'+playlist,c);return c; }

test('video group flags, orders and nullable dock heights survive host roundtrip',()=>{
  for(const order of ['sequence','random','loop']) {
    const v={fabEnabled:true,fabPosition:'top-left',fabSnapY:0.25,rotationGroups:[{id:'g',videoOnly:true,order,wallpaperIds:['a','b']}]};
    const s=sanitizeFromSchema(v,'client'),h=sanitizeFromSchema(serializeSettings(s),'host');
    assert.equal(h.rotationGroups[0].videoOnly,true);assert.equal(h.rotationGroups[0].order,order);assert.equal(h.fabSnapY,.25);assert.equal(h.fabEnabled,true);
  }
  assert.equal(sanitizeFromSchema({rotationGroups:[{id:'g',order:'loop'}]},'host').rotationGroups[0].order,'sequence');
  assert.equal(sanitizeFromSchema({fabPoint:{y:.7}},'host').fabSnapY,.7);
  assert.equal(sanitizeFromSchema({fabSnapY:null,fabPoint:{y:.7}},'host').fabSnapY,null);
  for(const v of [Infinity,NaN,'0.5',{},[]])assert.equal(sanitizeFromSchema({fabSnapY:v},'host').fabSnapY,null);
  assert.equal(sanitizeFromSchema({fabSnapY:2},'host').fabSnapY,1);
  assert.equal(sanitizeFromSchema({},'host').fabEnabled,false);
});
test('video stepping wraps, random excludes current, loop still allows manual next',()=>{
  const c=context(),ids=['a','b','c'];
  assert.equal(c.rotationMinimum({videoOnly:true}),1);assert.equal(c.rotationMinimum({}),2);
  assert.equal(c.videoPlaylistTarget(ids,'c',1,'sequence',()=>0),'a');
  assert.equal(c.videoPlaylistTarget(ids,'a',-1,'sequence',()=>0),'c');
  assert.equal(c.videoPlaylistTarget(ids,'a',1,'random',()=>0),'b');
  assert.equal(c.videoPlaylistTarget(ids,'a',1,'random',()=>.99),'c');
  assert.equal(c.videoPlaylistTarget(ids,'a',1,'loop',()=>0),'b');
  assert.equal(c.videoPlaylistTarget(['a'],'a',1,'sequence',()=>0),'a');
  assert.equal(c.videoPlaylistTarget([],'a',1,'sequence',()=>0),'');
});
test('ended advances exactly once via preparation; stale, paused, single and loop videos cannot advance',()=>{
  let group={id:'g',videoOnly:true,order:'sequence'},count=0,playing=true;
  let videos=[{id:'a'},{id:'b'}],current={ended:true};
  const c=context({selection:{rotationEnabled:true},activeRotationGroup:()=>group,rotationCandidates:()=>videos,
    isEffectivelyPlaying:()=>playing,beginRotationPrepare:()=>count++,LAYER_ID:'layer',document:{getElementById:()=>({querySelector:()=>current})}});
  assert.equal(c.syncVideoPlaylistPlayback(current),true);assert.equal(current.loop,false);assert.equal(count,1);
  c.syncVideoPlaylistPlayback(current);assert.equal(count,1);
  c.syncVideoPlaylistPlayback({ended:true});assert.equal(count,1);
  current.ended=false;c.syncVideoPlaylistPlayback(current);current.ended=true;playing=false;c.syncVideoPlaylistPlayback(current);assert.equal(count,1);
  playing=true;c.syncVideoPlaylistPlayback(current);assert.equal(count,2);
  videos=[{id:'a'}];assert.equal(c.syncVideoPlaylistPlayback(current),false);assert.equal(current.loop,true);
  videos.push({id:'b'});group.order='loop';c.syncVideoPlaylistPlayback(current);assert.equal(current.loop,true);assert.equal(count,2);
  c.selection.rotationEnabled=false;group.order='sequence';c.syncVideoPlaylistPlayback(current);assert.equal(current.loop,true);
});
test('random playback history is bounded, supports previous/forward and resets by group',()=>{
  let group={id:'g',videoOnly:true,order:'random'};
  const selection={rotationEnabled:true,id:'0'},videos=Array.from({length:100},(_,i)=>({id:String(i)}));
  const c=context({selection,activeRotationGroup:()=>group,rotationCandidates:()=>videos});
  c.applySelection=(id)=>{c.rememberVideoSelection(id);selection.id=id;};
  for(let i=0;i<100;i++)c.applySelection(String(i));
  assert.equal(vm.runInContext('videoPlaylistHistory.ids.length',c),64);
  c.stepWallpaperVideo(-1);assert.equal(selection.id,'98');c.stepWallpaperVideo(1);assert.equal(selection.id,'99');
  group={...group,id:'other'};c.rememberVideoSelection('5');
  assert.deepEqual(plain(vm.runInContext('videoPlaylistHistory.ids',c)),['5']);
});
function node(display='',priority='') {
  const map=new Map(display?[['display',[display,priority]]]:[]);
  return {style:{getPropertyValue:k=>map.get(k)?.[0]||'',getPropertyPriority:k=>map.get(k)?.[1]||'',setProperty:(k,v,p='')=>map.set(k,[v,p]),removeProperty:k=>map.delete(k)}};
}
test('composer only binds explicit seat, preserves inline values/priorities and restores replaced nodes',()=>{
  const a=node('grid','important'),b=node('flex');let current=a,updates=0;
  const c=context().createComposerController({querySelector:(s)=>{assert.equal(s,'[data-composer-seat]');return current;}},()=>updates++);
  c.refresh();assert.equal(c.available(),true);c.toggle();assert.equal(a.style.getPropertyValue('display'),'none');
  current=b;c.refresh();assert.equal(a.style.getPropertyValue('display'),'grid');assert.equal(a.style.getPropertyPriority('display'),'important');assert.equal(b.style.getPropertyValue('display'),'none');
  current=null;c.refresh();assert.equal(b.style.getPropertyValue('display'),'flex');assert.equal(c.available(),false);assert.equal(c.collapsed(),true);
  current=b;c.refresh();assert.equal(b.style.getPropertyValue('display'),'none');c.dispose();assert.equal(b.style.getPropertyValue('display'),'flex');assert.equal(c.collapsed(),false);assert.ok(updates>=4);
});
test('composer does not overwrite host edits while expanded and empty inline styles stay absent',()=>{
  let current=node();const c=context().createComposerController({querySelector:()=>current},()=>{});
  c.refresh();c.toggle();c.toggle();assert.equal(current.style.getPropertyValue('display'),'');
  current.style.setProperty('display','grid','important');c.dispose();assert.equal(current.style.getPropertyValue('display'),'grid');
  current=null;c.refresh();c.toggle();assert.equal(c.collapsed(),false);
});
test('FAB coordinate clamps and keyboard editing guard cover every editable shape',()=>{
  const c=context();
  assert.equal(c.fabTop({fabPosition:'top-left',fabSnapY:null},800),16);
  assert.equal(c.fabTop({fabPosition:'bottom-right',fabSnapY:null},800),728);
  assert.equal(c.fabTop({fabPosition:'bottom-right',fabSnapY:1},800),732);
  for(const tagName of ['INPUT','TEXTAREA','SELECT'])assert.equal(c.forkEditableTarget({tagName}),true);
  assert.equal(c.forkEditableTarget({isContentEditable:true}),true);
  assert.equal(c.forkEditableTarget({tagName:'SPAN',closest:()=>({})}),true);
  assert.equal(c.forkEditableTarget({tagName:'BUTTON',closest:()=>null}),false);
});
test('dragged FAB panel fits the available side of the viewport',()=>{
  const c=context();
  for(const height of [200,480,842,1080])for(const ratio of [0,.25,.4,.5,.6,.75,1]){
    const top=c.fabTop({fabPosition:'bottom-right',fabSnapY:ratio},height);
    const max=c.fabPanelMaxHeight(top,height);
    assert.ok(max>=0);
    if(top>height/2)assert.ok(top-10-max>=12);
    else assert.ok(top+62+max<=height-12);
  }
  assert.equal(c.fabPanelMaxHeight(310,842),458);
});
test('FAB mounts only when enabled and cleans every global listener; shortcuts ignore typing',()=>{
  const events=new Map(),effects=[],refs=[];let next=0,play=0;
  const sel={fabEnabled:true,fabPosition:'bottom-right',fabSnapY:null,inventory:{wallpapers:[]}};
  const c=context({selection:sel,window:{innerHeight:800,addEventListener:(k,v)=>events.set(k,v),removeEventListener:(k,v)=>{assert.equal(events.get(k),v);events.delete(k);}},
    React:{useState:v=>[typeof v==='function'?v():v,()=>{}],useRef:v=>{const r={current:v};refs.push(r);return r;},useEffect:f=>effects.push(f),createElement:(type,props,...children)=>({type,props,children})},
    VinylRecord:()=>{},vinylSpinVisible:()=>true,useWeLocale:()=>{},useStore:()=>sel,playableInventory:()=>[],activeRotationGroup:()=>null,matchesSourceFilter:()=>true,playbackIsVideoLike:()=>false,weT:s=>s,onNextWallpaper:()=>next++,onTogglePlay:()=>play++});
  assert.ok(c.FloatingWallpaperControl());const cleanup=effects[0]();assert.equal(events.size,7);
  const key={key:'ArrowRight',ctrlKey:true,altKey:true,target:{tagName:'TEXTAREA'},preventDefault:()=>{}};
  events.get('keydown')(key);assert.equal(next,0);key.target={tagName:'BODY'};events.get('keydown')(key);assert.equal(next,1);
  events.get('keydown')({...key,key:' ',code:'Space'});assert.equal(play,1);
  cleanup();assert.equal(events.size,0);sel.fabEnabled=false;assert.equal(c.FloatingWallpaperControl(),null);
});
test('all control modules are inlined, and real playback/editor/slot wiring remains connected',()=>{
  const build=read('../scripts/build-client.mjs'),client=read('../src/client.js'),media=read('../src/media-prep.js'),panel=read('../src/panel-tabs.js');
  assert.ok(build.includes("file: 'src/video-playlist.js'") && build.includes("file: 'src/fork-controls.js'"));
  assert.ok(client.includes('if (syncVideoPlaylistPlayback(video)) return;'));
  assert.ok(client.includes('|| activeVideoPlaylist()) return;'));
  assert.ok(media.includes('rememberVideoSelection(id);'));
  assert.ok(client.includes('installComposerCollapse(ctx)'));
  assert.ok(panel.includes('editing.videoOnly'));
});

test('mini player distinguishes collapse from off, shares selection and disables empty controls',()=>{
  const items=[{id:'a',title:'Video',type:'video'},{id:'b',title:'Image',type:'image'}];
  const sel={fabEnabled:true,fabPosition:'bottom-right',fabSnapY:null,inventory:{wallpapers:items},id:'a',url:'/a',videoPlaying:true};
  const states=[],refs=[];let si=0,ri=0,toggles=0,chosen='';
  const c=context({selection:sel,window:{innerHeight:842},document:{activeElement:null},
    React:{useState:v=>{const i=si++;if(!(i in states))states[i]=typeof v==='function'?v():v;return [states[i],v=>states[i]=v];},useRef:v=>refs[ri++]|| (refs[ri-1]={current:v}),useEffect:()=>{},createElement:(type,props,...children)=>({type,props:props||{},children})},
    VinylRecord:()=>{},vinylSpinVisible:()=>true,useWeLocale:()=>{},useStore:()=>sel,playableInventory:()=>items,activeRotationGroup:()=>null,matchesSourceFilter:()=>true,
    playbackIsVideoLike:()=>sel.id==='a',weT:s=>s,onTogglePlay:()=>toggles++,onNextWallpaper:()=>{},
    setSetting:(k,v)=>sel[k]=v,emit:()=>{},applySelection:id=>chosen=id});
  const render=()=>{si=0;ri=0;return c.FloatingWallpaperControl();};
  const all=(n)=>n&&typeof n==='object'?[n,...(n.children||[]).flat(Infinity).flatMap(all)]:[];
  const by=(tree,label)=>all(tree).find(n=>n.props['aria-label']===label&&n.type==='button');
  let tree=render();assert.equal(all(tree).filter(n=>n.type==='section').length,0);
  const disc=()=>all(tree).find(n=>n.type===c.VinylRecord);
  assert.equal(disc().props.playing,true);assert.equal(disc().props.sm,true);
  sel.videoPlaying=false;tree=render();assert.equal(disc().props.playing,false);
  sel.videoPlaying=true;c.vinylSpinVisible=()=>false;tree=render();assert.equal(disc().props.playing,false);
  c.vinylSpinVisible=()=>true;tree=render();assert.equal(disc().props.playing,true);
  by(tree,'悬浮播放器').props.onClick();tree=render();assert.equal(all(tree).filter(n=>n.type==='section').length,1);
  by(tree,'暂停').props.onClick();assert.equal(toggles,1);
  all(tree).find(n=>n.props.className==='we-fab__list-toggle').props.onClick();tree=render();
  all(tree).filter(n=>n.props.className==='we-fab__item')[1].props.onClick();assert.equal(chosen,'b');
  items.push(...Array.from({length:60},(_,i)=>({id:'extra-'+i,title:'Extra',type:'image'})));tree=render();assert.equal(all(tree).filter(n=>n.props.className==='we-fab__item').length,24);
  all(tree).find(n=>n.type==='button'&&n.children.includes('显示更多壁纸')).props.onClick();tree=render();assert.equal(all(tree).filter(n=>n.props.className==='we-fab__item').length,48);
  by(tree,'收起控制面板').props.onClick();tree=render();assert.equal(sel.fabEnabled,true);assert.equal(toggles,1);
  by(tree,'悬浮播放器').props.onClick();tree=render();by(tree,'关闭悬浮窗').props.onClick();assert.equal(render(),null);
  sel.fabEnabled=true;sel.id='';sel.url='';tree=render();assert.equal(by(tree,'播放').props.disabled,true);assert.equal(by(tree,'从头播放').props.disabled,true);
});

test('glass mini player has native-theme, opaque and reduced-motion fallbacks',()=>{
  const css=read('../src/styles.js');
  assert.ok(css.includes('body[data-ds-dark-theme] .we-fab'));
  assert.ok(css.includes('backdrop-filter:blur(28px) saturate(170%)'));
  assert.ok(css.includes('prefers-reduced-transparency:reduce'));
  assert.ok(css.includes('.we-fab__panel{animation:none}'));
  assert.ok(css.includes('we-fab button:focus-visible'));
  assert.ok(!controls.includes('React.createElement(QuickPanel'));
});


test('library and floating launcher share the original paused/resumable vinyl component',()=>{
  const client=read('../src/client.js'),panel=read('../src/panel-tabs.js'),css=read('../src/styles.js');
  assert.ok(panel.includes('React.createElement(VinylRecord'));
  assert.ok(panel.includes('playing: playbackLive && Boolean(sel.url) && vinylSpinVisible()'));
  assert.ok(controls.includes('React.createElement(VinylRecord'));
  assert.ok(controls.includes('playing:playbackLive && Boolean(sel.url) && vinylSpinVisible()'));
  assert.ok(client.includes('document.hidden !== true'));
  assert.ok(css.includes('animation: we-vinyl-spin 8s linear infinite'));
  assert.ok(css.includes('.we-vinyl--playing { animation-play-state: running; }'));
  assert.ok(css.includes('animation-play-state: paused;'));
  assert.ok(css.includes('.we-vinyl { animation: none; }'));
  assert.ok(css.includes('.we-fab .we-fab__disc>.we-vinyl{width:52px;height:52px;pointer-events:none}'));
});
