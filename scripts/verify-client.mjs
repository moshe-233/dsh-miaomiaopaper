// Verify the emitted client bundle materializes + drives the DOM correctly
// under the DSH module-loader contract. Exercises apply(), syncLayers(), and
// confirms: wallpaper + scrim layers are `<body>` children (no shell.overlay),
// the four effect knobs (wallpaper blur/scrim/border/glass blur) push CSS
// variables, the picker renders, and automatic rotation is scoped to a
// user-defined rotation group (list) with its own interval.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const React = {
  Fragment: 'Fragment',
  // Function initializers are invoked (lazy useState), matching real React.
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
  // Minimal-but-real renderer: invoke function components so the picker tree
  // actually materializes (descriptors only for host elements).
  createElement: (type, props, ...children) =>
    typeof type === 'function' ? type(props || {}) : ({ type, props: props || null, children }),
};

let byId = {};
const rotationTimers = [];
const sceneFrameHeadCalls = [];
const sceneFrameDeleteCalls = [];
// CPU scene-anim 后台渲染的探针：queueSceneAnimUpgrade 建的 <video>.src 指向
// /scene-anim/<token>?fmt=mp4 —— 它出现就代表「CPU 渲染真的启动了」。
const animProbeSrcs = [];
// 同一个 src 赋值也记录**元素**：用于区分「探测视频」与「上屏的层内视频」
// （层内视频的 _parent 是 LAYER_ID 那个层节点）。
const animVideoEls = [];
const imgEls = [];
// [local-patch] live MutationObserver instances (see the sandbox stub) so tests
// can fire DOM-change callbacks on demand.
const mutationObservers = [];
// [local-patch] tiny selector matcher for the mock DOM: enough for the FAB
// in-place refresh path (class selectors + [data-*] attribute selectors,
// comma lists) so querySelector(All) finds real nodes instead of nulls.
function matchesMockSelector(node, sel) {
  const cls = typeof node.className === 'string' ? node.className.split(/\s+/).filter(Boolean) : [];
  const attrs = node.attributes || {};
  const data = node.dataset || {};
  for (const part of String(sel || '').split(',')) {
    const s = part.trim();
    if (!s) continue;
    // Two shapes the FAB code actually uses: ".cls" / ".cls[attr]" and the
    // bare attribute form "[data-we-fab-mute]" (no leading class).
    const m = s.match(/^(?:\.([A-Za-z0-9_-]+))?\[([^\]=]+)(?:="([^"]*)")?\]$/)
      || s.match(/^\.([A-Za-z0-9_-]+)$/);
    if (!m) continue;
    if (m[0].includes('[')) {
      if (m[1] && !cls.includes(m[1])) continue;
      const attrName = m[2];
      // data-foo-bar → dataset.fooBar (the DOM's own camelCase mapping); the
      // code sets dataset.<camel> directly, so the raw attribute name misses.
      const key = attrName.startsWith('data-')
        ? attrName.slice(5).replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())
        : attrName;
      const val = data[key] ?? attrs[attrName];
      if (m[3] === undefined) {
        if (val !== undefined && val !== null) return true;
      } else if (String(val) === m[3]) return true;
    } else if (cls.includes(m[1])) {
      return true;
    }
  }
  return false;
}
function queryMock(root, sel) {
  // [local-patch] Real DOM semantics: an element ALSO matches its own selector
  // (e.g. body.querySelector('[data-composer-seat]') finds a direct child, and
  // orb.querySelector('.we-fab__menu') finds the panel itself).
  const match = (node) => {
    if (!node || typeof node !== 'object') return null;
    if (matchesMockSelector(node, sel)) return node;
    for (const c of (node.children || [])) {
      const hit = match(c);
      if (hit) return hit;
    }
    return null;
  };
  for (const c of root.children || []) {
    const hit = match(c);
    if (hit) return hit;
  }
  return null;
}
function queryAllMock(root, sel) {
  const hits = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (matchesMockSelector(node, sel)) hits.push(node);
    for (const c of (node.children || [])) walk(c);
  };
  for (const c of root.children || []) walk(c);
  return hits;
}
function makeEl(tag) {
  const el = {
    tagName: tag.toUpperCase(),
    children: [],
    dataset: {},
    attributes: {},
    style: { _props: {}, setProperty(k, v) { this._props[k] = v; }, removeProperty(k) { delete this._props[k]; } },
    className: "",
    appendChild(c) { this.children.push(c); if (c._parent) c._parent.removeChild(c); c._parent = this; if (c.id) byId[c.id] = c; return c; },
    remove() { if (this._parent) { const i = this._parent.children.indexOf(this); if (i >= 0) this._parent.children.splice(i, 1); delete this._parent; } if (this.id) delete byId[this.id]; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); },
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k] ?? null; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k); },
    removeAttribute(k) { delete this.attributes[k]; },
    querySelector(sel) { return queryMock(this, sel); },
    querySelectorAll(sel) { return queryAllMock(this, sel); },
    // [local-patch] real DOM elements expose these; the FAB volume slider and
    // outside-dismiss/hotkey wiring depend on them.
    addEventListener() {},
    removeEventListener() {},
    setPointerCapture() {},
    releasePointerCapture() {},
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    closest() { return null; },
    insertBefore(c, ref) {
      if (c && c._parent) c._parent.removeChild(c);
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i >= 0) this.children.splice(i, 0, c);
      else this.children.unshift(c);
      if (c) { c._parent = this; if (c.id) byId[c.id] = c; }
      return c;
    },
  };
  el.classList = {
    add: (...names) => {
      const set = new Set(String(el.className || '').split(/\s+/).filter(Boolean));
      for (const n of names) if (n) set.add(n);
      el.className = [...set].join(' ');
    },
    remove: (...names) => {
      const drop = new Set(names);
      el.className = String(el.className || '').split(/\s+/).filter((c) => c && !drop.has(c)).join(' ');
    },
    toggle: (name, force) => {
      const set = new Set(String(el.className || '').split(/\s+/).filter(Boolean));
      const want = force === undefined ? !set.has(name) : !!force;
      if (want) set.add(name); else set.delete(name);
      el.className = [...set].join(' ');
      return want;
    },
    contains: (name) => String(el.className || '').split(/\s+/).includes(name),
  };
  // [local-patch] emulate innerHTML assignment clearing children, as real DOM
  // does — renderOrbContent() wipes the orb with container.innerHTML = "". The
  // last assigned string is remembered so the FAB icon assertions can read the
  // markup back (real DOM would parse it into children; the glyph SVGs are
  // opaque to the recursive findClass walk, so the raw string is what we check).
  el._innerHTML = '';
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._innerHTML; },
    set(v) { el._innerHTML = String(v ?? ''); el.children = []; },
  });
  return el;
}

const bodyEl = makeEl("body");
const document = {
  createElement: (t) => {
    const el = makeEl(t);
    if (t === 'video' || t === 'audio') {
      let _src = '';
      Object.defineProperty(el, 'src', {
        get: () => _src,
        set: (v) => {
          _src = String(v || '');
          if (_src.includes('/scene-anim/')) { animProbeSrcs.push(_src); animVideoEls.push({ el, src: _src }); }
        },
      });
      // [local-patch] media-element surface the layer sync touches
      // (play/pause/load + paused/ended/error reads); play() resolves so the
      // playback-convergence path treats the mock as "playing".
      el.paused = false;
      el.ended = false;
      el.error = null;
      el.play = () => Promise.resolve();
      el.pause = () => { el.paused = true; };
      el.load = () => {};
    }
    if (t === 'img') {
      // 静态帧层（buildMedia 的 img 分支）的 src：用于锁定「回退静态帧必须带画面档位」。
      let _src = '';
      Object.defineProperty(el, 'src', {
        get: () => _src,
        set: (v) => { _src = String(v || ''); imgEls.push({ el, src: _src }); },
      });
    }
    return el;
  },
  getElementById: (id) => byId[id] || null,
  querySelector: () => null,
  querySelectorAll: () => [],
  head: makeEl("head"),
  body: bodyEl,
  documentElement: makeEl("html"),
  // [local-patch] document-level lookups. probeComposer() asks for
  // "[data-composer-seat]" first; the headless host has no real CSS engine, so
  // walk the tree with the same matcher the element-level querySelector uses.
  querySelector(sel) { return queryMock(bodyEl, sel); },
  querySelectorAll(sel) { return queryAllMock(bodyEl, sel); },
  // [local-patch] stub the add/removeEventListener pair used by the FAB
  // outside-click dismissal and global hotkey wiring.
  addEventListener: () => {},
  removeEventListener: () => {},
};

const localStorage = {
  // Select a wallpaper and enable rotation over a user-defined group; omit
  // effect knobs so the new DEFAULTS (scrim 0.25, border 0.35, blur 24) apply.
  _store: { 'dsh-wallpaper-engine:selection': JSON.stringify({
    id: 'a',
    rotationGroupId: 'g1',
    rotationEnabled: true,
    rotationGroups: [
      { id: 'g1', name: 'My list', interval: 5, order: 'sequence', wallpaperIds: ['a', 'b'] },
    ],
    // 打开实验性场景动画：CPU scene-anim 升级路径必须被走到，才能验证
    // 「槽位已有 GPU 帧 → 不跑 CPU 渲染」这条门禁。
    betaSceneAnim: true,
    // 场景 C 记着画面档位 3：锁定「回退静态帧必须按该壁纸记住的档位加载」。
    frameVariants: { c: 3 },
  }) },
  getItem(k) { return this._store[k] ?? null; },
  setItem(k, v) { this._store[k] = v; },
  removeItem(k) { delete this._store[k]; },
};
// 槽位是否已有 GPU 抓帧（场景 C）：DELETE 后翻假，模拟真宿主的磁盘状态。
let cccGpuPinned = true;
// P2-L：宿主 unlink 失败时回 200 + removed:false（文件其实还在磁盘上）。
let cccClearUnlinkFails = false;
const fetch = (url, opts) => {
  const u = String(url);
  const method = (opts && opts.method) || 'GET';
  // GPU 抓帧缓存的 HEAD 探测 / DELETE 清除（面板提示与清除入口）：
  // 场景 C（/scene-frame/ccc）假装缓存里已有 _gpu.png。
  if (method === 'HEAD') {
    sceneFrameHeadCalls.push(u);
    return Promise.resolve({
      ok: true, status: 204,
      headers: { get: (k) => (String(k).toLowerCase() === 'x-we-gpu'
        ? (u.includes('/scene-frame/ccc') && cccGpuPinned ? '1' : '0') : null) },
    });
  }
  if (method === 'DELETE') {
    sceneFrameDeleteCalls.push(u);
    if (cccClearUnlinkFails) {
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ ok: true, removed: false, error: 'unlink-failed' }),
      });
    }
    // 真宿主语义：DELETE 删掉 <key>_gpu.png → 之后 HEAD 回到 X-WE-GPU=0。
    if (u.includes('/scene-frame-cache/ccc')) cccGpuPinned = false;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, removed: true }) });
  }
  // scene-anim 进度轮询：直接报 100% → 触发「渲染完成切换」主动路径
  //（trySwitch）。修复前该判定的全等比较在这些情形下恒不成立，产物永不上屏。
  if (u.includes('/scene-anim-progress/')) {
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ percent: 100 }) });
  }
  // Route the settings GET: host reports dsh-better-sidebar as installed +
  // enabled (→ the 侧栏玻璃 control group must render), while keeping settings
  // empty so loadPersisted takes the "host has nothing yet → migrate the
  // localStorage seed" path the rest of the harness relies on.
  if (u.includes('/wallpaper-engine/settings')) {
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, betterSidebar: true }) });
  }
  return Promise.resolve({
  ok: true, status: 200,
  json: () => Promise.resolve({
    installDir: "D:/we", total: 34, portableCount: 33,
    playlists: [
      { id: "p1", name: "Test playlist", order: "sequence", wallpaperIds: ["a", "b", "c"], total: 3, portableCount: 2 },
    ],
    wallpapers: [
      // 30 synthetic videos force pagination (33 playable cards → 2 pages at 24/page).
      // All carry contentrating "Everyone" so they stay visible under the
      // default Everyone filter.
      ...Array.from({ length: 30 }, (_, i) => ({
        id: "w" + i, title: "Wall " + i, type: "video", playable: true, media: "/wallpaper-engine/media/w" + i, preview: null,
        contentrating: "Everyone",
      })),
      { id: "a", title: "Video A", type: "video", playable: true, media: "/wallpaper-engine/media/xyz", preview: null, contentrating: "Everyone" },
      { id: "b", title: "Video B", type: "video", playable: true, media: "/wallpaper-engine/media/def", preview: null, contentrating: "Everyone" },
      { id: "c", title: "Scene C", type: "scene", playable: false, media: null, preview: "/wallpaper-engine/preview/ccc", frameUrl: "/wallpaper-engine/scene-frame/ccc", contentrating: "Everyone" },
      { id: "d", title: "Scene D (no frame)", type: "scene", playable: false, media: null, preview: null, frameUrl: null, contentrating: "Everyone" },
      // e is PG13 and must be excluded under the default Everyone filter.
      { id: "e", title: "PG13 E", type: "web", playable: true, media: "/wallpaper-engine/media/pg", preview: null, contentrating: "PG13" },
    ],
  }),
  });
};

// 变异测试钩子：默认读构建产物，DSH_MUT_LIB 指向变异副本时读它。
const code = readFileSync(process.env.DSH_MUT_LIB || new URL('../lib/client.js', import.meta.url), 'utf8');
const independentSidebarSelector = 'body[data-we-sidebar-glass] [data-dsh-better-sidebar] [class*="_panel"]';
const wallpaperGatedSidebarSelector = 'body[data-we-sidebar-glass][data-we-wallpaper] [data-dsh-better-sidebar]';
assert.ok(code.includes(independentSidebarSelector), 'sidebar glass must not require an active wallpaper');
assert.ok(!code.includes(wallpaperGatedSidebarSelector), 'legacy wallpaper-gated sidebar selector must be removed');
assert.ok(
  code.includes('body[data-we-sidebar-glass] [data-dsh-better-sidebar] .cm-editor'),
  'sidebar content surfaces must follow the sidebar master switch',
);
assert.ok(code.includes('body[data-we-wallpaper] {'), 'non-sidebar wallpaper effects must remain wallpaper-gated');
console.log('sidebar glass selectors are wallpaper-independent: true');
const cap = { handoff: null };
const sandbox = {
  window: {
    __ModuleLoader__: { load: (h) => { cap.handoff = h; } },
    // [local-patch] the FAB drag rail reads viewport size + window listeners;
    // without these setupFabDrag bails and dockFabPosition no-ops in the mock.
    innerWidth: 1920,
    innerHeight: 1080,
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: (fn, ms) => {
      const token = { fn, ms, cleared: false };
      rotationTimers.push(token);
      return token;
    },
    clearTimeout: (token) => { if (token) token.cleared = true; },
  },
  document, localStorage, fetch, React,
  // 浏览器里裸 setTimeout/setInterval 就是 window 上的 —— 沙箱必须同样提供：
  // 只用裸全局的代码路径（scene-anim 进度轮询、live 心跳）否则会静默抛错，
  // 让「CPU 渲染是否启动」这类断言变成假绿。
  setTimeout: (fn, ms) => {
    const token = { fn, ms, cleared: false };
    rotationTimers.push(token);
    return token;
  },
  clearTimeout: (token) => { if (token) token.cleared = true; },
  setInterval: (fn, ms) => {
    const token = { fn, ms, cleared: false, interval: true };
    rotationTimers.push(token);
    return token;
  },
  clearInterval: (token) => { if (token) token.cleared = true; },
  // [local-patch] 可控 MutationObserver：mock 树不会自己派发变更，所以记录每个
  // observer 的回调，测试里手动 fire() 来模拟「宿主重挂了输入框」这类 DOM 变更。
  // 缺了它，refreshComposerBinding（宿主重挂时唯一重新接管的路径）永远不被执行，
  // 「折叠态跨重挂存活」就会变成无人验证的死代码。
  MutationObserver: function MutationObserver(cb) {
    this._cb = cb;
    this._targets = [];
    mutationObservers.push(this);
  },
};
sandbox.MutationObserver.prototype.observe = function observe(target, opts) {
  this._targets.push({ target, opts });
};
sandbox.MutationObserver.prototype.disconnect = function disconnect() {
  this._targets = [];
  const i = mutationObservers.indexOf(this);
  if (i >= 0) mutationObservers.splice(i, 1);
};
// 可控时钟：「帧率上限」按钮只有走到门禁的**冷缓存**分支（probeGpuFramePin 的
// 30s TTL 过期）才能被行为断言测出是否真的走了门禁 —— 否则按钮路径与「选壁纸」
// 路径共用同一条 gpuFramePins 缓存命中，改回直调也照样绿。
const RealDate = Date;
let nowOffset = 0;
const FakeDate = function (...a) { return a.length ? new RealDate(...a) : new RealDate(RealDate.now() + nowOffset); };
FakeDate.now = () => RealDate.now() + nowOffset;
FakeDate.parse = RealDate.parse; FakeDate.UTC = RealDate.UTC; FakeDate.prototype = RealDate.prototype;
sandbox.Date = FakeDate;
vm.createContext(sandbox);
new vm.Script(code, { filename: 'client.js' }).runInContext(sandbox);

const { id, factory } = cap.handoff;
console.log('registered id:', id);

const requireMock = (spec) => {
  if (spec === 'react') return React;
  if (spec === 'react-dom') return { createPortal: (node) => node }; // modal renders inline in the mock
  throw new Error('unexpected require: ' + spec);
};
const exportsObj = factory(requireMock);
console.log('factory keys:', Object.keys(exportsObj));
console.log('inject:', JSON.stringify(exportsObj.inject));
console.log('Symbol.toStringTag:', Object.prototype.toString.call(exportsObj));

const registrations = [];
const effects = [];
const pickerRenders = [];
// [local-patch] slot render callbacks keyed by slot name — the sidebar
// composer-toggle test renders its component directly, so the settings
// picker and the sidebar entry must not share one flat list.
const slotRenders = {};
const slots = {
  inject: (key, cb) => cb(),
  register: (opts, render) => {
    registrations.push({ key: opts.name, id: opts.id, label: opts.label, order: opts.order });
    if (opts.name === 'settings.section') pickerRenders.push(render);
    slotRenders[opts.name] = slotRenders[opts.name] || [];
    slotRenders[opts.name].push({ opts, render });
  },
};
// [local-patch] The composer seat the sidebar toggle folds. A real element (not
// a stub) so the collapse path writes/restores inline styles exactly as it does
// against DSH, and `probeComposer` succeeds via its [data-composer-seat] branch.
const composerSeat = makeEl('div');
composerSeat.setAttribute('data-composer-seat', '');
composerSeat.style.height = '120px';
composerSeat.style.opacity = '1';
composerSeat.style.paddingTop = '8px';
composerSeat.style.paddingBottom = '8px';
bodyEl.appendChild(composerSeat);
const ctx = { slots, effect(fn) { effects.push(fn); fn(); return fn; } };

let thrown = null;
try { exportsObj.apply(ctx); } catch (e) { thrown = e && e.message; }
console.log('apply threw:', thrown || '(none)');
console.log('slot registrations:', JSON.stringify(registrations));

const sectionReg = registrations.find((r) => r.key === 'settings.section');
console.log('registered as first-level settings.section:', !!sectionReg);
console.log('section id:', sectionReg ? sectionReg.id : '(missing)');
console.log('section label:', sectionReg ? sectionReg.label : '(missing)');
console.log('no longer registered as general item:', !registrations.some((r) => r.key === 'settings.general.item'));

setTimeout(async () => {
  console.log('body children ids:', JSON.stringify(bodyEl.children.map((c) => c.id)));
  console.log('has wallpaper layer:', !!document.getElementById('dsh-wallpaper-engine-layer'));
  console.log('has scrim:', !!document.getElementById('dsh-wallpaper-engine-scrim'));
  console.log('body[data-we-wallpaper]:', JSON.stringify(bodyEl.attributes['data-we-wallpaper']));
  const p = bodyEl.style._props;
  console.log('--we-scrim-color:', JSON.stringify(p['--we-scrim-color']));
  console.log('--we-border-alpha:', JSON.stringify(p['--we-border-alpha']));
  console.log('--we-blur:', JSON.stringify(p['--we-blur']));
  console.log('--we-wallpaper-blur:', JSON.stringify(p['--we-wallpaper-blur']));
  console.log('--we-wallpaper-scale:', JSON.stringify(p['--we-wallpaper-scale']));
  console.log('--we-wallpaper-opacity (default 0% → unset):', JSON.stringify(p['--we-wallpaper-opacity']));
  assert.equal(p['--we-wallpaper-opacity'], undefined, 'wallpaper opacity must stay untouched by default (no identity-opacity compositing layer)');
  console.log('--we-accent:', JSON.stringify(p['--we-accent']));
  console.log('--we-glass-alpha:', JSON.stringify(p['--we-glass-alpha']));
  console.log('--we-glass-color:', JSON.stringify(p['--we-glass-color']));
  console.log('body[data-we-glass-window] (default on):', JSON.stringify(bodyEl.attributes['data-we-glass-window']));
  // ── 轮换「就绪后切换 + 渐变」断言 ─────────────────────────────────
  // mock 环境无 addEventListener/Image → 准备管线特性探测失败即同步直通提交。
  // 按 5 分钟（300000ms）定位真正的轮换定时器，绕开 persist 防抖的 200ms
  // 定时器；提交结果同步看新层 dataset.weKey（含 selection.url），持久化
  // 需再手动 flush 200ms 的 persist 写。
  // 断言走 assert.ok：任何一条不成立 → 非零退出（评审指出此前全是
  // console.log，把轮换打回元素级领养也能 exit 0）。
  const rotCheck = (label, cond) => { assert.ok(cond, label); console.log('  ✓ ' + label); };
  const flushPersistWrites = () => {
    for (const t of rotationTimers.filter((item) => !item.cleared && !item.fired && item.ms === 200)) {
      t.fired = true;
      try { t.fn(); } catch (e) { console.log('persist flush threw:', e && e.message); }
    }
  };
  const findRotTimer = () => rotationTimers.find((item) => !item.cleared && !item.fired && item.ms === 5 * 60 * 1000);
  const fireRot = (t) => { t.fired = true; t.fn(); };
  const preLayer = document.getElementById('dsh-wallpaper-engine-layer');
  const rotTimer = findRotTimer();
  rotCheck('rotation timer scheduled (5min)', !!rotTimer);
  if (rotTimer) {
    fireRot(rotTimer); // a → b（直通提交）
    const postLayer = document.getElementById('dsh-wallpaper-engine-layer');
    const weKey1 = postLayer && postLayer.dataset ? postLayer.dataset.weKey : '';
    rotCheck('rotation prepare: ready-commit switches layer to next (b/media/def)',
      !!postLayer && postLayer !== preLayer && weKey1.indexOf('/wallpaper-engine/media/def') !== -1);
    rotCheck('rotation fade: old layer marked weFading', !!preLayer && preLayer.dataset.weFading === '1');
    rotCheck('rotation fade: old layer yielded LAYER_ID', !!preLayer && preLayer.id === '');
    rotCheck('rotation fade: new layer carries fadein classes', !!postLayer
      && postLayer.className.indexOf('we-layer--fadein') !== -1
      && postLayer.className.indexOf('we-layer--fadein-on') !== -1);
    flushPersistWrites();
    rotCheck('rotation prepare: commit persisted (id b)',
      JSON.parse(localStorage._store['dsh-wallpaper-engine:selection']).id === 'b');
    // 第二次 fire（wrap）：上一份 fading 层被即时退役，选择绕回 a。
    const rotTimer2 = findRotTimer();
    rotCheck('rotation prepare: timer re-armed after commit', !!rotTimer2);
    if (rotTimer2) {
      fireRot(rotTimer2);
      const layer2 = document.getElementById('dsh-wallpaper-engine-layer');
      const weKey2 = layer2 && layer2.dataset ? layer2.dataset.weKey : '';
      rotCheck('rotation prepare: second ready-commit wraps (a/media/xyz)',
        !!layer2 && layer2 !== postLayer && weKey2.indexOf('/wallpaper-engine/media/xyz') !== -1);
      rotCheck('rotation fade: second switch also fades', !!layer2
        && layer2.className.indexOf('we-layer--fadein') !== -1);
      rotCheck('rotation fade: previous fading layer retired immediately',
        bodyEl.children.indexOf(preLayer) === -1);
      flushPersistWrites();
    }
  }
  console.log('picker renders:', pickerRenders.length > 0);
  if (pickerRenders.length) {
// ── Tabbed IA: the picker splits into six tabs (壁纸/外观/字体/吉祥物/效果/
    //    高级). Each WallpaperPicker instance keeps its active tab in
    //    localStorage; mock React's useState returns the initializer value, so
    //    re-seeding the key + re-rendering switches tabs deterministically. ──
    const TAB_KEY = 'dsh-wallpaper-engine:picker-tab';
    const setTab = (id) => localStorage.setItem(TAB_KEY, id);
    const renderPicker = () => {
      try { return pickerRenders[0](); } catch (e) { console.log('picker render threw:', e && e.message); return null; }
    };
    const countMatches = (root, re) => (JSON.stringify(root).match(re) || []).length;
    // Find the .we-picker__ctl row whose subtree mentions `text`, then the
    // first input with onChange inside it — the pill-switch input is nested
    // inside label.we-picker__switch within that SAME row.
    const findCtlInput = (root, text) => {
      let row = null;
      (function walk(node) {
        if (row || !node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(walk); return; }
        const cls = typeof node.props?.className === 'string' ? node.props.className : '';
        if (cls.includes('we-picker__ctl') && JSON.stringify(node).includes(text)) { row = node; return; }
        if (Array.isArray(node.children)) node.children.forEach(walk);
      })(root);
      let hit = null;
      (function find(node) {
        if (hit || !node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(find); return; }
        if (node.type === 'input' && node.props && typeof node.props.onChange === 'function') { hit = node; return; }
        if (Array.isArray(node.children)) node.children.forEach(find);
      })(row);
      return hit;
    };
    const findSliderRow = (root, label) => {
      let hit = null;
      (function walk(node) {
        if (hit || !node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(walk); return; }
        const cls = typeof node.props?.className === 'string' ? node.props.className : '';
        const children = Array.isArray(node.children) ? node.children : [];
        const lbl = children.find((c) => c && typeof c === 'object' && Array.isArray(c.children) && c.children.includes(label));
        if (cls.includes('we-picker__slider-row') && lbl) hit = node;
        if (Array.isArray(node.children)) node.children.forEach(walk);
      })(root);
      return hit;
    };
    const sliderMax = (row) => (row ? JSON.stringify(row).match(/"max":"(\d+)"/)?.[1] : null);
    const findRangeInput = (row) =>
      (Array.isArray(row?.children) ? row.children : [])
        .find((c) => c && typeof c === 'object' && c.type === 'input');

    // ── 壁纸 tab (default): card head + tab bar + wallpaper controls. ──
    localStorage.removeItem(TAB_KEY);
    let tree = renderPicker();
    let treeText = JSON.stringify(tree);
    console.log('tab bar renders (6 tabs):', countMatches(tree, /"role":"tab"/g) === 6);
    console.log('default tab is 壁纸:', treeText.includes('"we-tabs__tab we-tabs__tab--active"') && treeText.includes('自动轮播'));
    console.log('wallpaper tab has 选择壁纸:', treeText.includes('"选择壁纸"'));
    console.log('wallpaper tab has 自定义壁纸:', treeText.includes('自定义壁纸'));
    console.log('other tabs keep their controls out of the tree:',
      !treeText.includes('玻璃透明度') && !treeText.includes('字体自定义') && !treeText.includes('吉祥物大小'));

    // ── 外观 tab: swatches / sliders / sidebar-glass group. ──
    setTab('appearance');
    tree = renderPicker();
    treeText = JSON.stringify(tree);
    console.log('appearance tab active:', treeText.includes('"we-tabs__tab we-tabs__tab--active"'));
    console.log('accent preset swatches (expect 6):', (treeText.match(/"aria-label":"配色 /g) || []).length);
    console.log('glass-color preset swatches (expect 6):', (treeText.match(/"aria-label":"玻璃颜色 /g) || []).length);
    console.log('glass color custom input present:', treeText.includes('自定义玻璃颜色'));
    console.log('custom color input present:', treeText.includes('type":"color"'));
    console.log('glass transparency slider row present:', treeText.includes('玻璃透明度'));
    console.log('sidebar-glass master switch present:', treeText.includes('侧栏液态玻璃'));
    console.log('sidebar blur slider present:', treeText.includes('侧栏模糊'));
    console.log('sidebar alpha slider present:', treeText.includes('侧栏透明度'));
    console.log('sidebar glass-color swatches (expect 6):', (treeText.match(/"aria-label":"侧栏玻璃颜色 /g) || []).length);
    console.log('sidebar glass color custom input present:', treeText.includes('自定义侧栏玻璃颜色'));
    // The three detail knobs (侧栏模糊 / 侧栏透明度 / 侧栏玻璃颜色) are
    // conditional on the 侧栏液态玻璃 master switch: off → hidden, on →
    // restored, in the SAME render pass (the toggle re-emits synchronously).
    const sidebarSwitch = findCtlInput(tree, '侧栏液态玻璃');
    if (sidebarSwitch) {
      sidebarSwitch.props.onChange({ target: { checked: false } });
      assert.equal(bodyEl.attributes['data-we-sidebar-glass'], undefined, 'sidebar master off must restore native surfaces');
      tree = renderPicker();
      const offText = JSON.stringify(tree);
      console.log('switch off hides the three detail knobs:',
        !offText.includes('侧栏模糊') && !offText.includes('侧栏透明度') && !offText.includes('侧栏玻璃颜色'));
      console.log('switch itself stays visible when off:', offText.includes('侧栏液态玻璃'));
      sidebarSwitch.props.onChange({ target: { checked: true } });
      assert.equal(bodyEl.attributes['data-we-sidebar-glass'], 'on', 'sidebar master on must re-arm sidebar surfaces');
      tree = renderPicker();
      console.log('switch back on restores the detail knobs:',
        JSON.stringify(tree).includes('侧栏模糊') && JSON.stringify(tree).includes('侧栏透明度') && JSON.stringify(tree).includes('侧栏玻璃颜色'));
    } else {
      console.log('switch off hides the three detail knobs: false (switch not found)');
    }
    console.log('sidebar blur slider max (expect 200):', sliderMax(findSliderRow(tree, '侧栏模糊')));
    console.log('sidebar alpha slider max (expect 200):', sliderMax(findSliderRow(tree, '侧栏透明度')));
    console.log('whole-window glass master switch present:', treeText.includes('设置窗口液态玻璃'));
    console.log('window glass tooltip present:', treeText.includes('整个设置窗口'));

    // ── 字体 tab: master switch + conditional trio (颜色/字重/字体族). ──
    setTab('font');
    tree = renderPicker();
    treeText = JSON.stringify(tree);
    console.log('font tab has 字体自定义 switch:', treeText.includes('字体自定义'));
    const fontSwitch = findCtlInput(tree, '字体自定义');
    if (fontSwitch) {
      fontSwitch.props.onChange({ target: { checked: true } });
      tree = renderPicker();
      treeText = JSON.stringify(tree);
      console.log('font on reveals 颜色/字重/字体族 chips (expect 7):',
        treeText.includes('字体颜色') && treeText.includes('字重') && (treeText.match(/"aria-label":"字体 /g) || []).length === 7);
      fontSwitch.props.onChange({ target: { checked: false } });
      tree = renderPicker();
      treeText = JSON.stringify(tree);
    }

    // ── 输入光标（#83）: caret color swatches live on the font tab and are
    //    INDEPENDENT of the 字体自定义 master switch (visible while it is off). ──
    console.log('font tab has 输入光标 section:', treeText.includes('输入光标'));
    console.log('caret swatches (expect 7: 自动 + 6 presets):', (treeText.match(/"aria-label":"光标颜色 /g) || []).length);
    console.log('caret custom color input present:', treeText.includes('自定义光标颜色'));
    const findSwatch = (root, aria) => {
      let hit = null;
      (function walk(node) {
        if (hit || !node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (node.props && node.props['aria-label'] === aria) { hit = node; return; }
        if (Array.isArray(node.children)) node.children.forEach(walk);
      })(root);
      return hit;
    };
    const caretWhite = findSwatch(tree, '光标颜色 #ffffff');
    const caretAuto = findSwatch(tree, '光标颜色 自动');
    console.log('caret 白 preset + 自动 buttons present:', !!caretWhite && !!caretAuto);
    if (caretWhite && caretAuto) {
      caretWhite.props.onClick();
      tree = renderPicker();
      assert.equal(p['--we-caret-color'], '#ffffff', 'picking a caret color must arm --we-caret-color');
      const caretSt = document.getElementById('we-caret-patch');
      console.log('caret style injected with caret-color rule:',
        !!caretSt && String(caretSt.textContent || '').includes('caret-color: var(--we-caret-color) !important'));
      assert.ok(caretSt, 'we-caret-patch style element must exist while a caret color is set');
      caretAuto.props.onClick();
      tree = renderPicker();
      assert.equal(p['--we-caret-color'], undefined, '自动 must clear --we-caret-color');
      assert.equal(document.getElementById('we-caret-patch'), null, '自动 must remove the caret style element');
      console.log('caret 自动 restores native caret: true');
    }

    // ── 吉祥物 tab: rope toggle + form cards (live preview) + size slider. ──
    setTab('mascot');
    tree = renderPicker();
    const ropeToggle = findCtlInput(tree, '显示吉祥物');
    console.log('mascot rope toggle present:', !!ropeToggle);
    if (ropeToggle) {
      console.log('rope toggle checked by default:', ropeToggle.props.checked === true);
      ropeToggle.props.onChange({ target: { checked: false } });
      tree = renderPicker();
      const ropeOff = findCtlInput(tree, '显示吉祥物');
      console.log('unchecking hides the rope (checkbox off):', !!ropeOff && ropeOff.props.checked === false);
      ropeToggle.props.onChange({ target: { checked: true } });
      tree = renderPicker();
      const ropeOn = findCtlInput(tree, '显示吉祥物');
      console.log('re-checking restores the rope (checkbox on):', !!ropeOn && ropeOn.props.checked === true);
    } else {
      console.log('mascot rope toggle: false (not found)');
    }
    // Mascot form is now a pair of live-preview cards (aria-pressed = active).
    const findMascotCards = (root) => {
      const found = [];
      (function walk(node) {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(walk); return; }
        const cls = typeof node.props?.className === 'string' ? node.props.className : '';
        if (cls.includes('we-picker__mascot-card')) found.push(node);
        if (Array.isArray(node.children)) node.children.forEach(walk);
      })(root);
      return found;
    };
    const activeForm = (cards) => cards.find((c) => String(c.props.className).includes('--active'));
    let mascotCards = findMascotCards(tree);
    console.log('mascot form cards (expect 2):', mascotCards.length === 2);
    console.log('default form is maid:', !!activeForm(mascotCards) && activeForm(mascotCards).props.title === '小女仆');
    const whaleCard = mascotCards.find((c) => c.props.title === '鲸御姐');
    if (whaleCard) { whaleCard.props.onClick(); tree = renderPicker(); }
    mascotCards = findMascotCards(tree);
    console.log('form switches to whale:', !!activeForm(mascotCards) && activeForm(mascotCards).props.title === '鲸御姐');
    const maidCard = mascotCards.find((c) => c.props.title === '小女仆');
    if (maidCard) { maidCard.props.onClick(); tree = renderPicker(); }
    mascotCards = findMascotCards(tree);
    console.log('form switches back to maid:', !!activeForm(mascotCards) && activeForm(mascotCards).props.title === '小女仆');
    const ropeScaleSlider = findSliderRow(tree, '吉祥物大小');
    console.log('mascot rope size slider present:', !!ropeScaleSlider);
    if (ropeScaleSlider) {
      const ri = findRangeInput(ropeScaleSlider);
      console.log('rope size slider min/max (0.5/2.5):',
        ri && String(ri.props.min) === '0.5' && String(ri.props.max) === '2.5');
      console.log('rope size default scale (1):', ri && String(ri.props.value) === '1');
      if (ri) ri.props.onInput({ target: { value: '1.5' } });
      tree = renderPicker();
      const ri2 = findRangeInput(findSliderRow(tree, '吉祥物大小'));
      console.log('rope size slider updates to 1.5:', ri2 && String(ri2.props.value) === '1.5');
      if (ri2) ri2.props.onInput({ target: { value: '1' } });
      tree = renderPicker();
    } else {
      console.log('mascot rope size slider: false (not found)');
    }

    // ── 效果 tab: 玻璃 slider spans 0–60 px (wallpaper 'a' is active). ──
    setTab('effects');
    tree = renderPicker();
    console.log('effects tab has empty-state-free sliders:', JSON.stringify(tree).includes('壁纸模糊'));
    console.log('玻璃 slider max (expect 60):', sliderMax(findSliderRow(tree, '玻璃')));

    // ── 壁纸透明度（#82）: slider max 90; 60% → layer opacity 0.4; 0% unsets. ──
    const wpOpacityRow = findSliderRow(tree, '壁纸透明度');
    console.log('壁纸透明度 slider max (expect 90):', sliderMax(wpOpacityRow));
    const wpOpacityInput = findRangeInput(wpOpacityRow);
    if (wpOpacityInput) {
      wpOpacityInput.props.onInput({ target: { value: '60' } });
      tree = renderPicker();
      assert.equal(p['--we-wallpaper-opacity'], '0.4', '壁纸透明度 60% must drive layer opacity 0.4');
      const wpReset = findRangeInput(findSliderRow(tree, '壁纸透明度'));
      if (wpReset) wpReset.props.onInput({ target: { value: '0' } });
      tree = renderPicker();
      assert.equal(p['--we-wallpaper-opacity'], undefined, '壁纸透明度 0% must unset the variable (identity opacity)');
      console.log('壁纸透明度 drives --we-wallpaper-opacity (0.4 @60%, unset @0%): true');
    }

    // ── 壁纸 tab again: modal / pagination / close card / sidebar stays armed.
    setTab('wallpaper');
    tree = renderPicker();
    // The thumbnail grid lives inside the picker MODAL now (settings page
    // shows only the summary + "选择壁纸" trigger). Open the modal by
    // invoking the trigger button's onClick, re-render, then count cards.
    const openBtn = [];
    (function walk(node) {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (!node || typeof node !== 'object') return;
      const cls = typeof node.props?.className === 'string' ? node.props.className : '';
      if (cls.includes('we-picker__btn') && Array.isArray(node.children) && node.children.length === 1 && node.children[0] === '选择壁纸') openBtn.push(node);
      if (Array.isArray(node.children)) node.children.forEach(walk);
    })(tree);
    if (openBtn.length && typeof openBtn[0].props.onClick === 'function') {
      try { openBtn[0].props.onClick(); } catch (e) { console.log('open modal onClick threw:', e && e.message); }
    }
    tree = renderPicker();
    const collectCards = (root) => {
      const cards = [];
      (function walk2(node) {
        if (Array.isArray(node)) { node.forEach(walk2); return; }
        if (!node || typeof node !== 'object') return;
        const cls = typeof node.props?.className === 'string' ? node.props.className : '';
        if (cls === 'we-picker__card' || cls === 'we-picker__card we-picker__card--selected') cards.push(node);
        if (Array.isArray(node.children)) node.children.forEach(walk2);
      })(root);
      return cards;
    };
    const clickPager = (root, label) => {
      let hit = null;
      (function walk(node) {
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (!node || typeof node !== 'object') return;
        const cls = typeof node.props?.className === 'string' ? node.props.className : '';
        if (cls.includes('we-picker__btn') && Array.isArray(node.children) && node.children.length === 1 && node.children[0] === label) hit = node;
        if (Array.isArray(node.children)) node.children.forEach(walk);
      })(root);
      if (hit && typeof hit.props.onClick === 'function') { try { hit.props.onClick(); } catch (e) { console.log('pager click threw:', e && e.message); } }
      return hit;
    };
    // Page 1: 33 playable wallpapers → 2 pages @ 24; grid = close card + 24.
    let cards = collectCards(tree);
    console.log('page 1 cards (expect 25: close + 24):', cards.length);
    console.log('pager rendered (pages > 1):', JSON.stringify(tree).includes('we-picker__pager'));
    const page1Text = JSON.stringify(cards);
    console.log('page 1 shows first wallpaper (Wall 0):', page1Text.includes('Wall 0'));
    console.log('page 1 does NOT show page-2 item (Wall 30):', !page1Text.includes('Wall 30'));
    console.log('scene D (no frameUrl) excluded from grid:', !page1Text.includes('Scene D'));
    console.log('pg13 wallpaper excluded under default Everyone filter:', !page1Text.includes('PG13 E'));
    // Flip to page 2 → 33 - 24 = 9 wallpapers + close card = 10.
    clickPager(tree, '下一页 ›');
    tree = renderPicker();
    cards = collectCards(tree);
    console.log('page 2 cards (expect 10: close + 9):', cards.length);
    const page2Text = JSON.stringify(cards);
    console.log('page 2 shows last wallpaper (Wall 29):', page2Text.includes('Wall 29'));
    console.log('page 2 no longer shows page-1 item (Wall 0):', !page2Text.includes('Wall 0'));
    console.log('scene C (frameUrl) in grid:', page2Text.includes('Scene C'));

    // Turn the active wallpaper off through the real picker callback. Sidebar
    // theming must remain armed because it is an independent feature; only
    // wallpaper-owned layers and the data-we-wallpaper marker disappear.
    const closeCard = cards.find((card) => JSON.stringify(card).includes('✕ 关闭'));
    assert.ok(closeCard && typeof closeCard.props.onClick === 'function', 'close-wallpaper card must be available');
    closeCard.props.onClick();
    assert.equal(bodyEl.attributes['data-we-wallpaper'], undefined, 'wallpaper marker must clear');
    assert.equal(bodyEl.attributes['data-we-sidebar-glass'], 'on', 'sidebar glass must remain enabled');
    assert.equal(typeof p['--we-sidebar-color'], 'string', 'sidebar color variable must remain available');
    assert.equal(typeof p['--we-sidebar-alpha'], 'string', 'sidebar alpha variable must remain available');
    assert.equal(typeof p['--we-sidebar-blur'], 'string', 'sidebar blur variable must remain available');
    console.log('sidebar glass remains armed without an active wallpaper: true');
  }

  // ── GPU 抓帧缓存：状态提示 + 清除入口（面板）──────────────────────────
  // 按用户决策：_gpu.png 存在时优先于「壁纸画面刷新」全部档位，所以切档位
  // 的前置动作是先清除。这里验证完整链路：选中场景 → HEAD 探测 → 面板出现
  // 「清除 GPU 帧」→ 点击 → DELETE 打到 host → 提示行消失。
  {
    // 与上文 setTab 同款：mock 的 useState 每次渲染都取 initializer，
    // 重新种 localStorage 再渲染即可确定性地切到目标 tab。
    // 「画面」section（壁纸画面刷新 + GPU 帧行）在「效果」tab 里。
    localStorage.setItem('dsh-wallpaper-engine:picker-tab', 'effects');
    assert.ok(pickerRenders.length > 0, 'picker render 回调必须已注册');
    // 等 boot 的 promise 链（loadPersisted → loadInventory →
    // revalidateSelection）全部落定：它会按持久化 id 覆盖选择。
    await new Promise((r) => setTimeout(r, 80));
    const renderPicker = () => {
      try { return pickerRenders[0](); } catch (e) { console.log('picker render threw:', e && e.message); return null; }
    };
    const reopenPicker = () => {
      let tree2 = renderPicker();
      const openBtn = [];
      (function walk(node) {
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (!node || typeof node !== 'object') return;
        const cls = typeof node.props?.className === 'string' ? node.props.className : '';
        if (cls.includes('we-picker__btn') && Array.isArray(node.children) && node.children.length === 1
          && node.children[0] === '选择壁纸') openBtn.push(node);
        if (Array.isArray(node.children)) node.children.forEach(walk);
      })(tree2);
      if (openBtn.length) { try { openBtn[0].props.onClick(); } catch { /* ignore */ } }
      return renderPicker();
    };
    const findBtn = (root, label) => {
      let hit = null;
      (function walk(node) {
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (!node || typeof node !== 'object') return;
        const cls = typeof node.props?.className === 'string' ? node.props.className : '';
        if (cls.includes('we-picker__btn') && Array.isArray(node.children) && node.children.length === 1
          && node.children[0] === label) hit = node;
        if (Array.isArray(node.children)) node.children.forEach(walk);
      })(root);
      return hit;
    };
    const findCard = (root, text) => {
      const cards = [];
      (function walk(node) {
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (!node || typeof node !== 'object') return;
        const cls = typeof node.props?.className === 'string' ? node.props.className : '';
        if (cls === 'we-picker__card' || cls.startsWith('we-picker__card ')) cards.push(node);
        if (Array.isArray(node.children)) node.children.forEach(walk);
      })(root);
      return cards.find((card) => JSON.stringify(card).includes(text));
    };
    let tree3 = reopenPicker();
    // 前置：先点选一张视频壁纸把层建出来（上文「无活动壁纸」用例清掉了层），
    // 否则 scene C 是首层、无旧层可淡，手动淡出的断言失去对象。Wall 0 在
    // 第 1 页：往前翻（上一页）找，翻到首页必现。
    let seedCard = findCard(tree3, 'Wall 0');
    for (let i = 0; i < 6 && !seedCard; i++) {
      const prev = findBtn(tree3, '‹ 上一页');
      if (!prev || prev.props.disabled) break;
      prev.props.onClick();
      tree3 = reopenPicker();
      seedCard = findCard(tree3, 'Wall 0');
    }
    // [local-patch] 真的把这张视频壁纸点起来：上面的「前置」注释描述的正是
    // 这一步，但选择被清空后从未恢复，于是 FAB 回归段一直在「没有活动壁纸
    // → orb 本就不该存在」的状态下跑 —— 全是 console.log，静默假绿。
    assert.ok(seedCard && typeof seedCard.props.onClick === 'function',
      'seed card (Wall 0) must be clickable to build an active video wallpaper');
    seedCard.props.onClick();
    assert.ok(!!document.getElementById('dsh-wallpaper-engine-layer'),
      'selecting a wallpaper must build the layer before the FAB assertions');
// ── [local-patch] FAB orb regression: open the quick-control menu over a
    // VIDEO wallpaper. The active wallpaper is a video, so the menu must render
    // the horizontal volume pane WITHOUT throwing — a past revision declared
    // volumeRow inside the if-block and the assembly step hit a ReferenceError,
    // wiping the orb mid-render (orb vanished).
    const fab = document.getElementById('dsh-wallpaper-engine-fab');
    assert.ok(!!fab, 'FAB orb must be mounted for an active wallpaper with fabEnabled');
    if (fab) {
      const trigger = fab.children.find((c) => typeof c.className === 'string' && c.className.includes('we-fab__trigger'));
      // ── [local-patch] Capsule-tap regression: tapping the trigger opens the
      // panel by MOUNTING it in place. The trigger node (and its disc) must
      // survive — the reported bug rebuilt the whole orb here, so the capsule
      // you just pressed was destroyed and you saw a flash.
      let openError = null;
      try { trigger && trigger.onclick && trigger.onclick({ stopPropagation() {} }); } catch (e) { openError = e && e.message; }
      console.log('FAB toggle threw:', openError || '(none)');
      assert.equal(openError, null, 'opening the FAB menu must not throw');
      const fabAfter = document.getElementById('dsh-wallpaper-engine-fab');
      const triggerAfterOpen = fabAfter.children.find((c) => typeof c.className === 'string' && c.className.includes('we-fab__trigger'));
      assert.equal(triggerAfterOpen, trigger,
        'the capsule must survive its own tap — a new node means the orb was rebuilt (the flash)');
      assert.ok(String(triggerAfterOpen.className).includes('we-fab__trigger--active'),
        'the capsule must pick up the --active class in place');
      const findClass = (node, needle, hits) => {
        if (!node || typeof node !== 'object') return;
        if (typeof node.className === 'string' && node.className.includes(needle)) hits.push(node);
        (node.children || []).forEach((c) => findClass(c, needle, hits));
      };
      const menus = [];
      const volRows = [];
      const sliders = [];
      if (fabAfter) {
        findClass(fabAfter, 'we-fab__menu', menus);
        findClass(fabAfter, 'we-fab__volume', volRows);
        findClass(fabAfter, 'we-fab__volume-slider', sliders);
      }
      console.log('expanded menu rendered after toggle:', menus.length > 0);
      console.log('horizontal volume row rendered (video wallpaper):', volRows.length > 0);
      console.log('volume slider present:', sliders.length > 0);
      assert.ok(menus.length > 0, 'the expanded quick-control menu must render');
      assert.ok(volRows.length > 0, 'a video wallpaper must render the volume row');
      assert.ok(sliders.length > 0, 'the volume row must carry a slider');
      const btnCount = (() => {
        const btns = []; if (fabAfter) findClass(fabAfter, 'we-fab__btn', btns); return btns.length;
      })();
      console.log('circular buttons count (expect 4: prev/play/next/mute):', btnCount);
      assert.equal(btnCount, 4, 'prev/play/next/mute must all render for a video wallpaper');
      // ── [local-patch] vertical wallpaper list: the current rotation group
      // (g1 = ['a','b']) renders two rows; clicking a row switches selection
      // and — critically — the orb must update IN PLACE. This is the
      // regression guard for the reported "press a FAB button → the orb hard
      // refreshes (flash)" bug: background emits used to reach syncFloatingOrb
      // with no options and wipe innerHTML, rebuilding every node.
      const rows = []; const listRows = [];
      if (fabAfter) findClass(fabAfter, 'we-fab__list-row', listRows);
      for (const r of listRows) rows.push(r);
      console.log('wallpaper list rows (expect 2 from group g1):', listRows.length);
      assert.equal(listRows.length, 2, 'the g1 rotation group must render two list rows');
      assert.ok(listRows.every((r) => r.dataset && r.dataset.weFabItemId),
        'each list row must carry its stable data-we-fab-item-id');
      const rowOf = (id) => listRows.find((r) => String(r.dataset.weFabItemId) === String(id));
      const activeRow = () => listRows.find((r) => String(r.className).includes('we-fab__list-row--active'));
      assert.equal(activeRow(), undefined,
        'the freshly seeded wallpaper is outside g1, so no row is highlighted yet');
      const rowA = rowOf('a');
      assert.ok(rowA && typeof rowA.onclick === 'function', 'list row for group entry "a" must be clickable');
      let listClickError = null;
      try { rowA.onclick({ stopPropagation() {} }); } catch (e) { listClickError = e && e.message; }
      console.log('list row click threw:', listClickError || '(none)');
      assert.equal(listClickError, null, 'clicking a list row must not throw');
      assert.equal(JSON.parse(localStorage._store['dsh-wallpaper-engine:selection']).id, 'a',
        'clicking the row must switch the selection to that entry');
      const fabAfterRow = document.getElementById('dsh-wallpaper-engine-fab');
      const rowsAfter = []; findClass(fabAfterRow, 'we-fab__list-row', rowsAfter);
      const rowAAfter = rowsAfter.find((r) => String(r.dataset.weFabItemId) === 'a');
      const rowBAfter = rowsAfter.find((r) => String(r.dataset.weFabItemId) === 'b');
      console.log('row "a" highlighted after click (in place):',
        !!rowAAfter && String(rowAAfter.className).includes('we-fab__list-row--active'));
      assert.ok(rowAAfter && String(rowAAfter.className).includes('we-fab__list-row--active'),
        'the clicked row must gain the --active highlight');
      assert.ok(rowBAfter && !String(rowBAfter.className).includes('--active'),
        'the previously highlighted row must lose it');
      assert.equal(rowAAfter, rowA,
        'the row node must be REUSED (in-place refresh), not rebuilt — a rebuilt node means a hard refresh');

      // ── [local-patch] In-place guard for the exact reported symptom: the
      // play button's handler runs syncLayers + refresh + emit(), and that
      // bare emit reaches the subscribed syncFloatingOrb. It must NOT rebuild
      // the orb (no flash, no restarted disc/marquee, no dropped drag).
      const playBtns = []; findClass(fabAfterRow, 'we-fab__btn--primary', playBtns);
      assert.equal(playBtns.length, 1, 'the play/pause button must be present');
      const playBtn = playBtns[0];
      const triggerBefore = fabAfterRow.children.find((c) => typeof c.className === 'string' && c.className.includes('we-fab__trigger'));
      let playClickError = null;
      try { playBtn.onclick({ stopPropagation() {} }); } catch (e) { playClickError = e && e.message; }
      console.log('play button click threw:', playClickError || '(none)');
      assert.equal(playClickError, null, 'the play button must not throw');
      const fabAfterPlay = document.getElementById('dsh-wallpaper-engine-fab');
      const triggerAfterPlay = fabAfterPlay.children.find((c) => typeof c.className === 'string' && c.className.includes('we-fab__trigger'));
      const playBtnsAfter = []; findClass(fabAfterPlay, 'we-fab__btn--primary', playBtnsAfter);
      console.log('play button survived the emit (no hard refresh):',
        playBtnsAfter.length === 1 && playBtnsAfter[0] === playBtn);
      assert.equal(triggerAfterPlay, triggerBefore,
        'the trigger node must survive a play-button emit (in-place refresh, no rebuild)');
      assert.ok(playBtnsAfter.length === 1 && playBtnsAfter[0] === playBtn,
        'the play button node must survive a play-button emit — a new node = the orb was rebuilt');

      // ── [local-patch] mute toggle: the speaker glyph must follow the state
      // through the IN-PLACE path (only a full rebuild used to swap it, so the
      // in-place refresh would have left a stale icon behind).
      const muteCandidates = []; findClass(fabAfterPlay, 'we-fab__btn', muteCandidates);
      // data-we-fab-mute is an empty marker attribute — test for presence.
      const muteBtn = muteCandidates.find((b) => b.dataset && 'weFabMute' in b.dataset);
      assert.ok(muteBtn, 'the mute button must be present for a video wallpaper');
      const loudGlyph = String(muteBtn.innerHTML).includes('<path');
      assert.equal(loudGlyph, true, 'a non-muted wallpaper shows the sound-waves glyph');
      let muteClickError = null;
      try { muteBtn.onclick({ stopPropagation() {} }); } catch (e) { muteClickError = e && e.message; }
      console.log('mute button click threw:', muteClickError || '(none)');
      assert.equal(muteClickError, null, 'the mute button must not throw');
      const fabAfterMute = document.getElementById('dsh-wallpaper-engine-fab');
      const muteBtnsNow = []; findClass(fabAfterMute, 'we-fab__btn', muteBtnsNow);
      const muteBtnNow = muteBtnsNow.find((b) => b.dataset && 'weFabMute' in b.dataset);
      const mutedGlyph = String(muteBtnNow.innerHTML).includes('<line');
      console.log('mute icon swapped in place (now muted glyph):', mutedGlyph);
      assert.equal(muteBtnNow, muteBtn, 'the mute button node must survive its own emit');
      assert.equal(mutedGlyph, true, 'muting must swap the speaker glyph in place');
      assert.ok(String(muteBtnNow.className).includes('we-fab__btn--active'),
        'the muted button must carry the --active class');

      // ── [local-patch] collapse (下拉) regression: the chevron flips the list
      // to --collapsed IN PLACE. This was the second reported flash: collapse
      // state used to sit in the structure fingerprint, so pressing the chevron
      // rebuilt the entire orb. Assert the very nodes survive.
      const collapseBtns = []; findClass(fabAfterPlay, 'we-fab__collapse-btn', collapseBtns);
      console.log('collapse button present:', collapseBtns.length > 0);
      assert.ok(collapseBtns.length > 0, 'the list collapse toggle must render');
      const collapseBtn = collapseBtns[0];
      const listsBefore = []; findClass(fabAfterPlay, 'we-fab__list', listsBefore);
      const listBefore = listsBefore.find((l) => String(l.className).split(/\s+/).includes('we-fab__list'));
      assert.ok(listBefore, 'the wallpaper list must be mounted before collapsing');
      let collapseError = null;
      try { collapseBtn.onclick({ stopPropagation() {} }); } catch (e) { collapseError = e && e.message; }
      console.log('collapse toggle threw:', collapseError || '(none)');
      assert.equal(collapseError, null, 'the collapse toggle must not throw');
      const listAfter = document.getElementById('dsh-wallpaper-engine-fab');
      const listsNow = []; findClass(listAfter, 'we-fab__list', listsNow);
      const listNow = listsNow.find((l) => String(l.className).split(/\s+/).includes('we-fab__list'));
      const collapsedNow = !!listNow && String(listNow.className).includes('--collapsed');
      console.log('list collapsed after toggle:', collapsedNow);
      assert.equal(collapsedNow, true, 'the collapse toggle must add --collapsed to the list');
      assert.equal(listNow, listBefore,
        'the list node must survive the chevron press — a new node means a rebuild (the flash)');
      const collapseBtnsNow = []; findClass(listAfter, 'we-fab__collapse-btn', collapseBtnsNow);
      assert.equal(collapseBtnsNow[0], collapseBtn,
        'the chevron node must survive its own press — a new node means a rebuild');
      assert.ok(String(collapseBtn.className).includes('we-fab__collapse-btn--collapsed'),
        'the chevron must pick up its collapsed class in place');
      const triggerAfterCollapse = listAfter.children.find((c) => typeof c.className === 'string' && c.className.includes('we-fab__trigger'));
      assert.equal(triggerAfterCollapse, trigger,
        'the capsule must survive the chevron press too');
    }

    // ── [local-patch] 界面收纳：侧栏「收起 / 展开输入框」按钮 ──────────────
    // 旧的底部白杠药丸（#dsh-we-trigger）已整体移除，触发入口改为注册进宿主
    // 左侧边栏 sidebar.footer.action 槽位的图标按钮。这一组断言锁定：
    //   ① 按钮确实按宿主契约注册（name/id/order）；
    //   ② 点击真的折叠输入框（写 height/opacity 0）并可再展开还原；
    //   ③ 两态图标与 aria-label 跟随状态切换；
    //   ④ 旧的固定药丸节点不再出现在 DOM 里。
    {
      const footerRegs = registrations.filter((r) => r.key === 'sidebar.footer.action');
      console.log('sidebar.footer.action registrations:', footerRegs.length);
      assert.equal(footerRegs.length, 1, 'exactly one sidebar footer action must be registered');
      assert.equal(footerRegs[0].id, 'wallpaper-engine-composer',
        'the sidebar action must use the plugin-owned id (never a shipped one)');
      assert.equal(footerRegs[0].order, -100,
        'the sidebar action must be ordered ahead of the host defaults');

      // 旧药丸必须彻底消失：宿主页面里不该再有那个 id 的节点。
      assert.equal(document.getElementById('dsh-we-trigger'), null,
        'the legacy bottom-pill trigger must no longer be mounted');

      const entry = (slotRenders['sidebar.footer.action'] || [])[0];
      assert.ok(entry && typeof entry.render === 'function', 'the sidebar entry must expose a render fn');
      const btn = entry.render({ wide: false });
      assert.ok(btn && btn.type === 'button', 'the sidebar entry must render a <button>');
      assert.ok(String(btn.props.className).includes('we-sidebar-collapse-btn'),
        'the button must carry the plugin sidebar class');

      // 未折叠：可用、下箭头（收起语义）、aria-pressed=false。
      console.log('sidebar toggle available:', !btn.props.disabled);
      assert.equal(btn.props.disabled, false,
        'the toggle must be enabled when the composer seat is present');
      assert.equal(btn.props['aria-pressed'], 'false', 'initial state must be expanded');
      assert.equal(btn.props.title, '收起输入框', 'initial tooltip must offer 「收起输入框」');

      // 折叠：点一次 → 输入框高度/透明度归零，按钮进入 is-collapsed。
      let clickErr = null;
      try { btn.props.onClick(); } catch (e) { clickErr = e && e.message; }
      console.log('sidebar toggle click threw:', clickErr || '(none)');
      assert.equal(clickErr, null, 'clicking the sidebar toggle must not throw');
      assert.equal(composerSeat.style.height, '0px',
        'the composer must be folded to height 0');
      assert.equal(composerSeat.style.opacity, '0',
        'the composer must be faded out while folded');
      assert.equal(composerSeat.style.overflow, 'hidden',
        'the folded composer must clip its content');

      const btnFolded = entry.render({ wide: false });
      assert.ok(String(btnFolded.props.className).includes('is-collapsed'),
        'the folded button must carry is-collapsed');
      assert.equal(btnFolded.props.title, '展开输入框',
        'the folded tooltip must offer 「展开输入框」');
      assert.equal(btnFolded.props['aria-pressed'], 'true', 'aria-pressed must flip to true');

      // 展开：再点一次 → 还原到原始内联样式（而不是清空成默认值）。
      btnFolded.props.onClick();
      assert.equal(composerSeat.style.height, '120px',
        'expanding must restore the original height, not blank it');
      assert.equal(composerSeat.style.opacity, '1', 'expanding must restore the original opacity');
      assert.equal(composerSeat.style.paddingTop, '8px',
        'expanding must restore the original padding');
      const btnBack = entry.render({ wide: false });
      assert.equal(btnBack.props['aria-pressed'], 'false', 'expanding must clear the pressed state');

      // 宽栏（wide=true）与窄轨（56px rail）都必须渲染同一个按钮 —— 宿主
      // 用 props.wide 区分，插件据此切换 is-rail（正方形、只图标）与文字标签。
      const btnWide = entry.render({ wide: true });
      assert.ok(btnWide && String(btnWide.props.className).includes('we-sidebar-collapse-btn'),
        'the toggle must render identically in the wide layout');
      assert.ok(!String(btnWide.props.className).includes('is-rail'),
        'the wide layout must NOT use the rail sizing');
      const btnRail = entry.render({ wide: false });
      assert.ok(String(btnRail.props.className).includes('is-rail'),
        'the 56px rail must use the square rail sizing');
      // 两者都要带文字标签节点（窄轨由 CSS 隐藏，而非不渲染 —— 保住可访问名）。
      const childKinds = (el) => (el.children || []).filter((c) => c && typeof c === 'object');
      console.log('sidebar toggle keeps its text label in both layouts:',
        childKinds(btnWide).some((c) => c.props && String(c.props.className).includes('we-sidebar-collapse-label')));
      assert.ok(childKinds(btnWide).some((c) => c.props && String(c.props.className).includes('we-sidebar-collapse-label')),
        'the wide button must carry a text label');
      assert.ok(childKinds(btnRail).some((c) => c.props && String(c.props.className).includes('we-sidebar-collapse-label')),
        'the rail button must still render the label node (CSS hides it)');

      // ── 宿主重挂输入框：折叠态必须跟着走，且旧节点的样式要被还原 ─────────
      // 切会话/路由变化时 DSH 会换掉 composer 容器。真实的接管路径是
      // MutationObserver → refreshComposerBinding（不是点击按钮）。若插件把
      // 「旧节点的原始内联值」写进新节点上，或丢掉折叠态让输入框自己弹回来，
      // 用户看到的就是「收了又开」。这里模拟一次重挂并断言两件事。
      const seat2 = makeEl('div');
      seat2.setAttribute('data-composer-seat', '');
      seat2.style.height = '200px';
      seat2.style.opacity = '1';
      // 先折叠（旧节点进入折叠态）。
      entry.render({ wide: false }).props.onClick();
      assert.equal(composerSeat.style.height, '0px', 'the first seat must be folded before the remount');
      // 宿主重挂：旧节点摘掉座位标记，新节点接上 —— 然后派发一次 DOM 变更。
      composerSeat.removeAttribute('data-composer-seat');
      bodyEl.appendChild(seat2);
      assert.ok(mutationObservers.length > 0, 'the composer watcher must install a MutationObserver');
      for (const mo of [...mutationObservers]) {
        if (mo._targets.length) mo._cb([]);
      }
      assert.equal(seat2.style.height, '0px',
        'a remounted composer container must pick up the folded state');
      // 旧节点不能停留在被折叠的样式上（它已不再是被接管的那个）。
      assert.equal(composerSeat.style.height, '120px',
        'the detached composer node must be restored, not left folded');
      // 展开：新节点回到它自己的原始值（200px），而不是旧节点的 120px。
      entry.render({ wide: false }).props.onClick();
      assert.equal(seat2.style.height, '200px',
        'expanding must restore the NEW container\'s own original height');
    }
  }
  console.log('effects ran:', effects.length);
  console.log('\nALL CLIENT CHECKS DONE');
}, 50);
