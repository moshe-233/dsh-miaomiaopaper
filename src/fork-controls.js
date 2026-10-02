/** Optional controls. All player actions use the upstream store and handlers.
 * Composer binding only accepts the host's explicit data-composer-seat marker;
 * never guess a textarea's parent. DOM ownership is reversible and HMR-safe.
 */
function forkEditableTarget(target) {
  return Boolean(target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || '')
    || (target.closest && target.closest('[contenteditable="true"], [role="textbox"]'))));
}
function fabTop(sel, height) {
  const top = sel.fabSnapY == null ? (sel.fabPosition.startsWith('top') ? 16 : height - 72) : sel.fabSnapY * height;
  return Math.max(12, Math.min(Math.max(12, height - 68), top));
}
// The panel opens toward the larger half of the viewport. Limit it to that
// side's actual free space, not the whole viewport (a dragged dock may be mid-screen).
function fabPanelMaxHeight(top, height) {
  return Math.max(0, top > height / 2 ? top - 22 : height - top - 74);
}
function FloatingWallpaperControl() {
  useWeLocale();
  const sel = useStore();
  const [open, setOpen] = React.useState(false);
  const [listOpen, setListOpen] = React.useState(false);
  const [height, setHeight] = React.useState(() => window.innerHeight || 800);
  const rootRef = React.useRef(null);
  const drag = React.useRef(null);
  const suppressClick = React.useRef(false);
  React.useEffect(() => {
    if (!sel.fabEnabled) { setOpen(false); setListOpen(false); return; }
    const close = () => { setOpen(false); setListOpen(false); };
    const cancelDrag = () => {
      drag.current = null;
      const root = rootRef.current;
      if (root) { root.style.top = fabTop(selection, window.innerHeight || 800) + 'px'; root.style.left = selection.fabSnapY == null && selection.fabPosition.endsWith('left') ? '16px' : 'auto'; root.style.right = root.style.left === 'auto' ? '16px' : 'auto'; }
    };
    const move = (e) => {
      const d = drag.current; if (!d || e.pointerId !== d.id) return;
      if (Math.abs(e.clientY - d.start) < 5 && !d.moved) return;
      d.moved = true; suppressClick.current = true;
      d.top = Math.max(12, Math.min(window.innerHeight - 68, e.clientY - d.offset));
      if (rootRef.current) { rootRef.current.style.top = d.top + 'px'; rootRef.current.style.left = 'auto'; rootRef.current.style.right = '16px'; }
    };
    const up = (e) => {
      const d = drag.current; if (!d || e.pointerId !== d.id) return;
      if (d.moved) { setSetting('fabSnapY', d.top / Math.max(1, window.innerHeight)); emit(); }
      drag.current = null;
    };
    const outside = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) close(); };
    const blur = () => { cancelDrag(); close(); };
    const resize = () => { cancelDrag(); setHeight(window.innerHeight || 800); };
    const key = (e) => {
      if (forkEditableTarget(e.target) || e.isComposing) return;
      if (e.key === 'Escape') { cancelDrag(); close(); return; }
      if (!e.ctrlKey || !e.altKey || e.metaKey || e.shiftKey || e.repeat) return;
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
  const playbackLive = playbackIsVideoLike(sel) ? sel.videoPlaying : sel.playing;
  const action = (label, text, fn) => React.createElement('button', { type:'button', className:'we-picker__btn', title:label, 'aria-label':label, onClick:fn }, text);
  return React.createElement('div', { className:'we-fab', ref:rootRef, style:{top:top+'px',left:left?'16px':'auto',right:left?'auto':'16px'} },
    React.createElement('button', { type:'button', className:'we-fab__disc', 'aria-label':weT('悬浮播放控制'), 'aria-expanded':open,
      onPointerDown:(e) => { if (e.button !== 0) return; suppressClick.current = false; drag.current = {id:e.pointerId,start:e.clientY,offset:e.clientY-top,top,moved:false}; },
      onClick:() => { if (suppressClick.current) { suppressClick.current=false; return; } setOpen(!open); } }, '♫'),
    open && React.createElement('section', { className:'we-fab__panel', 'aria-label':weT('悬浮播放控制'), style:{[left?'left':'right']:0, [top>height/2?'bottom':'top']:'62px',maxHeight:fabPanelMaxHeight(top,height)+'px'} },
      React.createElement('div',{className:'we-fab__title',title:current ? current.title : ''},current ? current.title : weT('未选择壁纸')),
      React.createElement('div',{className:'we-fab__actions'},
        action(weT('上一张'),'◀',()=>stepWallpaperVideo(-1)),
        action(playbackLive ? weT('暂停') : weT('播放', null, 'play'),playbackLive?'Ⅱ':'▶',onTogglePlay),
        action(weT('下一张'),'▶',onNextWallpaper),
        action(weT('从头播放'),'↺',restartWallpaperVideo),
        action(weT('壁纸列表'),'☷',()=>setListOpen(!listOpen)),
        action(weT('收起控制面板'),'×',()=>{setOpen(false);setListOpen(false);})
      ),
      listOpen && React.createElement(QuickPanel,{dock:true})
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
