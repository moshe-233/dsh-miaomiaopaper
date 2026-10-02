/** Compact glass player. State belongs to the upstream player; opening/closing
 * this surface never starts playback or creates another media element. */
function forkEditableTarget(target) {
  return Boolean(target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || '')
    || (target.closest && target.closest('[contenteditable="true"], [role="textbox"]'))));
}
function fabTop(sel, height) {
  const top = sel.fabSnapY == null ? (sel.fabPosition.startsWith('top') ? 16 : height - 72) : sel.fabSnapY * height;
  return Math.max(12, Math.min(Math.max(12, height - 68), top));
}
function fabPanelMaxHeight(top, height) {
  return Math.max(0, top > height / 2 ? top - 22 : height - top - 74);
}
function fabIcon(name) {
  const paths = {
    play:'M9 5.5 19 12 9 18.5Z', pause:'M8 6v12M16 6v12',
    previous:'M6 5v14M19 6l-10 6 10 6Z', next:'M18 5v14M5 6l10 6-10 6Z',
    restart:'M5 9a7.5 7.5 0 1 1 0 6M5 4v5h5',
    list:'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
    collapse:'m6 9 6 6 6-6', close:'m7 7 10 10M17 7 7 17',
    wallpaper:'M4 4h16v16H4ZM4 16l5-5 4 4 3-3 4 4M15 8h.01',
    check:'m5 12 4 4 10-10',
  };
  return React.createElement('svg',{viewBox:'0 0 24 24',width:20,height:20,fill:'none',stroke:'currentColor',strokeWidth:1.8,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true},
    React.createElement('path',{d:paths[name] || paths.wallpaper,fill:name==='play'?'currentColor':'none'}));
}
function FloatingWallpaperControl() {
  useWeLocale();
  const sel = useStore();
  const [open, setOpen] = React.useState(false);
  const [listOpen, setListOpen] = React.useState(false);
  const [height, setHeight] = React.useState(() => window.innerHeight || 800);
  const [listLimit, setListLimit] = React.useState(24);
  const rootRef = React.useRef(null);
  const discRef = React.useRef(null);
  const drag = React.useRef(null);
  const suppressClick = React.useRef(false);
  React.useEffect(() => {
    if (!sel.fabEnabled) { setOpen(false); setListOpen(false); return; }
    const close = () => { setOpen(false); setListOpen(false); setListLimit(24); };
    const cancelDrag = () => {
      drag.current = null;
      const root = rootRef.current;
      if (root) { root.removeAttribute('data-dragging'); root.style.top = fabTop(selection, window.innerHeight || 800) + 'px'; root.style.left = selection.fabSnapY == null && selection.fabPosition.endsWith('left') ? '16px' : 'auto'; root.style.right = root.style.left === 'auto' ? '16px' : 'auto'; }
    };
    const move = (e) => {
      const d = drag.current; if (!d || e.pointerId !== d.id) return;
      if (Math.hypot(e.clientY-d.start, e.clientX-d.x) < 5 && !d.moved) return;
      if (!d.moved) close();
      d.moved = true; suppressClick.current = true;
      d.top = Math.max(12, Math.min(window.innerHeight - 68, e.clientY - d.offset));
      if (rootRef.current) { rootRef.current.setAttribute('data-dragging',''); rootRef.current.style.top = d.top + 'px'; rootRef.current.style.left = 'auto'; rootRef.current.style.right = '16px'; }
    };
    const up = (e) => {
      const d = drag.current; if (!d || e.pointerId !== d.id) return;
      drag.current = null;
      if (rootRef.current) rootRef.current.removeAttribute('data-dragging');
      if (d.moved) { setSetting('fabSnapY', d.top / Math.max(1, window.innerHeight)); emit(); }
    };
    const outside = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) close(); };
    const blur = () => { cancelDrag(); close(); };
    const resize = () => { cancelDrag(); setHeight(window.innerHeight || 800); };
    const key = (e) => {
      if (e.isComposing) return;
      if (e.key === 'Escape') {
        const owned = rootRef.current && rootRef.current.contains(document.activeElement);
        cancelDrag(); close(); if (owned && discRef.current) discRef.current.focus(); return;
      }
      if (forkEditableTarget(e.target) || !e.ctrlKey || !e.altKey || e.metaKey || e.shiftKey || e.repeat) return;
      if (e.key === 'ArrowLeft') stepWallpaperVideo(-1);
      else if (e.key === 'ArrowRight') onNextWallpaper();
      else if (e.code === 'Space') onTogglePlay();
      else return;
      e.preventDefault();
    };
    const events = [['pointermove',move],['pointerup',up],['pointercancel',cancelDrag],['pointerdown',outside],['blur',blur],['resize',resize],['keydown',key]];
    for (const [type, fn] of events) window.addEventListener(type,fn);
    return () => { for (const [type, fn] of events) window.removeEventListener(type,fn); drag.current = null; };
  }, [sel.fabEnabled]);
  if (!sel.fabEnabled) return null;
  const left = sel.fabSnapY == null && sel.fabPosition.endsWith('left');
  const top = fabTop(sel, height);
  const current = sel.inventory.wallpapers.find((w) => w.id === sel.id);
  const videoLike = playbackIsVideoLike(sel);
  const playbackLive = Boolean(current && (videoLike ? sel.videoPlaying : sel.playing));
  const list = playableInventory().filter(w=>matchesSourceFilter(w,sel.sourceFilter));
  const candidates = activeVideoPlaylist() ? rotationCandidates() : playableInventory();
  const action = (label, icon, fn, disabled=false, extra={}) => React.createElement('button', {
    type:'button',className:'we-fab__action',title:label,'aria-label':label,onClick:fn,disabled,...extra,
  },fabIcon(icon));
  const art = (w, cls) => React.createElement('span',{className:cls},
    w && w.preview ? React.createElement('img',{src:w.preview,alt:'',loading:'lazy',onError:e=>{e.currentTarget.style.display='none';}}) : fabIcon('wallpaper'));
  return React.createElement('div', { className:'we-fab', ref:rootRef, 'data-playing':playbackLive?'true':'false', style:{top:top+'px',left:left?'16px':'auto',right:left?'auto':'16px'} },
    React.createElement('button', { type:'button',className:'we-fab__disc',ref:discRef,'aria-label':weT('悬浮播放器'),'aria-expanded':open,'aria-controls':'we-mini-player',title:weT('点击展开，拖动调整位置'),
      onPointerDown:e=>{ if(e.button!==0)return; suppressClick.current=false; drag.current={id:e.pointerId,start:e.clientY,x:e.clientX,offset:e.clientY-top,top,moved:false}; if(e.currentTarget.setPointerCapture)e.currentTarget.setPointerCapture(e.pointerId); },
      onClick:()=>{if(suppressClick.current){suppressClick.current=false;return;}setOpen(!open);setListOpen(false);},
    },React.createElement(VinylRecord,{sm:true,cover:current && current.preview,title:current?current.title:'',playing:playbackLive && Boolean(sel.url) && vinylSpinVisible()}),React.createElement('span',{className:'we-fab__status','aria-hidden':true})),
    open && React.createElement('section', {id:'we-mini-player',className:'we-fab__panel','aria-label':weT('悬浮播放器'),style:{[left?'left':'right']:0,[top>height/2?'bottom':'top']:'62px',maxHeight:fabPanelMaxHeight(top,height)+'px'}},
      React.createElement('header',{className:'we-fab__header'},
        React.createElement('span',{className:'we-fab__eyebrow'},weT('悬浮播放器')),
        React.createElement('div',{className:'we-fab__tools'},
          action(weT('收起控制面板'),'collapse',()=>{setOpen(false);setListOpen(false);if(discRef.current)discRef.current.focus();}),
          action(weT('关闭悬浮窗'),'close',()=>{setSetting('fabEnabled',false);emit();}))),
      React.createElement('div',{className:'we-fab__now'},art(current,'we-fab__art'),
        React.createElement('div',{className:'we-fab__info'},
          React.createElement('div',{className:'we-fab__title',title:current?current.title:''},current?current.title:weT('未选择壁纸')),
          React.createElement('div',{className:'we-fab__subtitle'},sel.videoError?weT('播放未就绪'):!current?weT('从壁纸列表选择一张'):playbackLive?weT('正在播放'):weT('已暂停')))),
      React.createElement('div',{className:'we-fab__transport'},
        action(weT('上一张'),'previous',()=>stepWallpaperVideo(-1),candidates.length<2),
        action(playbackLive?weT('暂停'):weT('播放',null,'play'),playbackLive?'pause':'play',onTogglePlay,!sel.url,{className:'we-fab__action we-fab__play'}),
        action(weT('下一张'),'next',onNextWallpaper,candidates.length<2)),
      React.createElement('footer',{className:'we-fab__footer'},
        action(weT('从头播放'),'restart',restartWallpaperVideo,!sel.url||!videoLike),
        React.createElement('button',{type:'button',className:'we-fab__list-toggle','aria-expanded':listOpen,'aria-controls':'we-mini-library',onClick:()=>{setListOpen(!listOpen);setListLimit(24);}},fabIcon('list'),weT('壁纸列表'),React.createElement('span',{className:'we-fab__count'},list.length))),
      listOpen && React.createElement('div',{id:'we-mini-library',className:'we-fab__list','aria-label':weT('壁纸列表')},
        list.length?list.slice(0,listLimit).map(w=>React.createElement('button',{key:w.id,type:'button',className:'we-fab__item','aria-pressed':w.id===sel.id,onClick:()=>applySelection(w.id,{fromManual:true})},
          art(w,'we-fab__thumb'),React.createElement('span',{className:'we-fab__item-title'},w.title),w.id===sel.id?fabIcon('check'):null)):
          React.createElement('p',{className:'we-fab__empty'},weT('当前筛选下没有可播放壁纸')),
        list.length>listLimit && React.createElement('button',{type:'button',className:'we-fab__list-toggle',onClick:()=>setListLimit(listLimit+24)},weT('显示更多壁纸')))
    )
  );
}

function createComposerController(doc, changed) {
  let node = null, snapshot = null, collapsed = false;
  const restore = (owned = collapsed) => {
    if (!node || !snapshot) return;
    if (owned) {
      if (snapshot.display) node.style.setProperty('display',snapshot.display,snapshot.priority);
      else node.style.removeProperty('display');
    }
    node = null; snapshot = null;
  };
  const refresh = () => {
    const next = doc.querySelector('[data-composer-seat]');
    if (next === node) return;
    restore(); node = next;
    if (node) {
      snapshot = {display:node.style.getPropertyValue('display'),priority:node.style.getPropertyPriority('display')};
      if (collapsed) node.style.setProperty('display','none','important');
    }
    changed();
  };
  return {
    refresh,
    available:() => Boolean(node),
    collapsed:() => collapsed,
    toggle:() => {
      refresh(); if (!node) return;
      collapsed = !collapsed;
      if (collapsed) {
        // Re-snapshot on each takeover; host edits made while expanded are not lost.
        snapshot = {display:node.style.getPropertyValue('display'),priority:node.style.getPropertyPriority('display')};
        node.style.setProperty('display','none','important');
      } else {
        const current = node; restore(true); node = current;
        snapshot = {display:node.style.getPropertyValue('display'),priority:node.style.getPropertyPriority('display')};
      }
      changed();
    },
    dispose:() => { restore(); collapsed = false; },
  };
}
let composerController = null;
function ComposerCollapseButton() {
  useWeLocale(); useStore();
  const c = composerController;
  return React.createElement('button', {type:'button', className:'we-picker__btn', disabled:!c || !c.available(),
    'aria-expanded':!c || !c.collapsed(), title:weT('收起或展开输入区'), 'aria-label':weT('收起或展开输入区'),
    onClick:() => { if (c) c.toggle(); }}, c && c.collapsed() ? '▴' : '▾');
}
function installComposerCollapse(ctx) {
  if (!ctx.slots || typeof ctx.slots.inject !== 'function' || typeof document.querySelector !== 'function') return;
  let observer = null, controller = null, active = false;
  const off = ctx.slots.inject('sidebar.footer.action', () => {
    active = true;
    controller = createComposerController(document, emit); composerController = controller;
    controller.refresh();
    if (typeof MutationObserver === 'function' && document.body) {
      observer = new MutationObserver(() => { if (controller) controller.refresh(); });
      observer.observe(document.body,{childList:true,subtree:true});
    }
    const seat = ctx.slots.register({name:'sidebar.footer.action',id:'wallpaper-engine-composer',order:-100},()=>React.createElement(ComposerCollapseButton));
    return () => {
      active = false;
      if (observer) observer.disconnect(); observer = null;
      if (controller) controller.dispose(); controller = null; composerController = null;
      if (typeof seat === 'function') seat();
    };
  });
  return () => {
    if (typeof off === 'function') off();
    if (observer) observer.disconnect();
    if (active && controller) controller.dispose();
    composerController = null; active = false;
  };
}
