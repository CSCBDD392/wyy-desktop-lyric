/**
 * 主世界脚本（world: MAIN）—— 面板本体。
 *
 * 为什么要跑在主世界：网易网页版播放器把歌曲信息挂在页面自己的对象上
 * （window.player.getPlaying()、#g_player 上的实例），隔离世界读不到。
 * 这里读信息、画面板；实际取词交给 content.js（那边才有扩展权限）。
 *
 * 面板完全自绘，只借用播放器元素来「读」进度和「写」跳转，不依赖网易的 CSS。
 */

(() => {
  'use strict';

  if (window.__WYY_LYRIC_PANEL__) return;
  window.__WYY_LYRIC_PANEL__ = true;

  // ---------------------------------------------------------------- 常量
  const BAR_SEL = '.m-playbar';
  const PLAYER_SEL = '#g_player, .m-playbar .wrap';
  const PLAYBAR_COLLAPSE_PX = 90;

  const DEFAULT_SETTINGS = {
    enabled: true,
    compact: false,
    showTranslation: true,
    showRoman: false,
    fontSize: 15,
    opacity: 92,
    source: 'netease',
    seekOnClick: true,
    autoHideNav: true,
  };

  const state = {
    songId: null,
    playing: false,
    songName: '',
    artist: '',
    elapsed: 0,
    duration: 0,
    hasProgress: false,
    detectMethod: '',
  };

  let settings = { ...DEFAULT_SETTINGS };
  let payload = null;        // { lines, hasTranslation, hasRoman, origin, by, note, empty, msg }
  let renderedFor = null;    // 当前渲染的 songId
  let activeIndex = -1;
  let userScrolling = false;
  let userScrollTimer = 0;
  let ready = false;
  let debugLines = [];
  let notifyTimer = 0;
  let override = null;   // 手动接管播放状态（排障用）
  let desktopOnline = null;  // 桌面歌词服务连通状态

  const el = {};
  const pos = { x: null, y: null };      // 展开态位置
  const cpos = { x: null, y: null };     // 小窗位置

  // ---------------------------------------------------------------- 小工具
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const isFilled = (v) => v !== null && v !== undefined && v !== '';

  function num(v) {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      if (isFinite(n)) return n;
    }
    return 0;
  }

  function str(v) {
    if (typeof v === 'string') return v.trim();
    if (Array.isArray(v)) return v.map(str).filter(Boolean).join(' / ');
    if (v && typeof v === 'object') {
      const inner = firstString(v, ['name', 'nickname', 'title', 'artistName']);
      return inner || '';
    }
    return '';
  }

  function firstString(obj, keys) {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  }

  function mmss(sec) {
    if (!isFinite(sec) || sec < 0) return '--:--';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function parseClock(text) {
    const m = /(\d{1,3}):(\d{1,2})/.exec(String(text || ''));
    return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
  }

  const parseDurationStr = (v) => {
    if (typeof v === 'number' && isFinite(v)) return v > 1000 ? v / 1000 : v;
    const mm = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
    return mm ? parseInt(mm[1], 10) * 60 + parseInt(mm[2], 10) : null;
  };

  function looksLikeId(v) {
    const s = String(v == null ? '' : v);
    return /^\d{4,12}$/.test(s);
  }

  function log(stage, extra) {
    // 只留最近若干条，给弹窗排障用；tick 级别的事件不记录，避免刷屏
    debugLines.push({ stage, extra, at: new Date().toISOString() });
    if (debugLines.length > 40) debugLines.splice(0, debugLines.length - 40);
    if (window.__WYY_DEBUG__) console.log('[wyy-lyric]', stage, extra || '');
  }

  function send(type, detail) {
    try {
      document.dispatchEvent(new CustomEvent(type, { detail }));
    } catch (err) { /* ignore */ }
  }

  // ---------------------------------------------------------------- 播放器探测
  function playerApi() {
    try {
      const p = window.player;
      return p && typeof p.getPlaying === 'function' ? p : null;
    } catch (err) {
      return null;
    }
  }

  function isActuallyPlaying(info) {
    const v = info.playing;
    if (typeof v === 'boolean') return v;
    return num(info.played) > 0.5 && num(info.duration) > 0 && num(info.played) < num(info.duration) - 0.5;
  }

  function detectFromApi() {
    const api = playerApi();
    if (!api) return null;
    let info;
    try { info = api.getPlaying(); } catch (err) { return null; }
    if (!info || typeof info !== 'object') return null;

    // 网易的 getPlaying() 实际返回 { track: {...}, playing: bool }
    const track = info.track && typeof info.track === 'object' ? info.track : info;

    let id = null;
    for (const k of ['id', 'songId', 'musicId', 'trackId', 'resourceId']) {
      if (looksLikeId(track[k])) { id = String(track[k]); break; }
    }
    if (!id) return null;

    const name = firstString(track, ['name', 'songName', 'title']);
    const artist = str(track.artist !== undefined ? track.artist : track.artists) ||
      firstString(track, ['artistName', 'singer', 'author']);
    const duration = num(track.duration) > 1000 ? num(track.duration) / 1000 : num(track.duration);

    return {
      id,
      name,
      artist,
      playing: isActuallyPlaying(info),
      duration: duration || 0,
      method: info.track ? 'window.player.getPlaying().track' : 'window.player.getPlaying()',
    };
  }

  /** 兜底：从 #g_player 上的播放器实例里嗅探「正在播放」对象（不依赖具体字段名）。 */
  function detectFromInstance() {
    let scope = null;
    try { scope = document.getElementById('g_player') || document.querySelector(PLAYER_SEL); } catch (err) { scope = null; }
    const roots = [scope, window.player];
    for (const root of roots) {
      if (!root) continue;
      const names = new Set([...Object.keys(root), ...Object.getOwnPropertyNames(root)]);
      for (const n of names) {
        if (!/play|song|music|track|cur/i.test(n)) continue;
        let target = null;
        let getter = null;
        try { getter = Object.getOwnPropertyDescriptor(root, n); } catch (err) { getter = null; }
        try { target = root[n]; } catch (err) { continue; }
        if (!target) continue;
        // 函数优先调用一次（如 getPlaying / getCurrentSong）
        if (typeof target === 'function') {
          try { target = target.call(root); } catch (err) { continue; }
        }
        if (!target || typeof target !== 'object') continue;
        const id = target.id !== undefined ? target.id
          : (target.songId !== undefined ? target.songId
            : (target.playingId !== undefined ? target.playingId : null));
        if (!looksLikeId(id)) continue;
        const name = firstString(target, ['name', 'songName', 'title']);
        const artist = str(target.artist !== undefined ? target.artist : target.artists) ||
          firstString(target, ['artistName', 'singer']);
        return {
          id: String(id),
          name,
          artist,
          playing: !!target.playing || isActuallyPlaying(target),
          duration: (num(target.duration) > 1000 ? num(target.duration) / 1000 : num(target.duration)) || 0,
          method: 'instance:' + n + (getter && getter.get ? '(getter)' : ''),
        };
      }
    }
    return null;
  }

  /** 播放条上的歌名容器：真歌名在 `#g_player .play .words` 里的链接上。 */
  function wordsNode() {
    const gp = document.getElementById('g_player');
    if (gp) {
      const w = gp.querySelector('.play .words') || gp.querySelector('.words');
      if (w) return w;
    }
    const bar = document.querySelector(BAR_SEL);
    return bar ? bar.querySelector('.play .words') || bar.querySelector('.words') : null;
  }

  // 播放条上的按钮文案不是歌名，必须排除
  const UI_LABEL_RE = /^(去客户端播放|去下载|还没有客户端|播放|暂停|上一首|下一首|收藏|分享|下载|评论|画中画歌词|展开播放条|收起播放条|添加|删除|清空|循环|单曲循环|随机播放|顺序播放|音量|播放列表|歌词|更多|登录|注册|搜索)$/;

  function plausibleSongName(name) {
    const s = String(name || '').trim();
    if (s.length < 1 || s.length > 120) return false;
    if (UI_LABEL_RE.test(s)) return false;
    if (/还没有客户端|客户端播放|扫码登录|开通|立即|点击/.test(s)) return false;
    return true;
  }

  /** 最后兜底：直接读播放条上的歌名（拿不到 id，但名字能喂备用源）。 */
  function detectFromDom() {
    const w = wordsNode();
    if (!w) return null;
    const links = [...w.querySelectorAll('a')].filter((a) => (a.textContent || '').trim());
    if (!links.length) return null;
    // 第一个链接是歌名，其后带 title 的是歌手
    const nameLink = links.find((a) => plausibleSongName(a.textContent)) || links[0];
    const name = (nameLink.textContent || '').trim();
    if (!plausibleSongName(name)) return null;
    const artist = links
      .filter((a) => a !== nameLink && a.title && a.title.trim() && a.title.trim() !== name)
      .map((a) => a.title.trim())
      .join(' / ');
    return { id: null, name, artist, playing: isPlayingByDom(), duration: 0, method: 'dom:.words' };
  }

  function isPlayingByDom() {
    const bar = document.querySelector(BAR_SEL);
    const b = bar && bar.querySelector('.btns .ply');
    if (!b) return false;
    const cls = ' ' + String(b.className || '') + ' ';
    if (/\bpas\b/.test(cls)) return true;
    if (/\bply\b/.test(cls)) return false;
    return state.playing;
  }

  function readProgress() {
    const bar = document.querySelector(BAR_SEL);
    if (!bar) return;
    const timeEl = bar.querySelector('.m-pbar .time') || bar.querySelector('.time');
    const cur = bar.querySelector('.m-pbar .cur');
    const total = bar.querySelector('.m-pbar .barbg');
    if (timeEl) {
      const txt = timeEl.innerText || timeEl.textContent || '';
      const parts = String(txt).split('/');
      const elapsed = parseClock(parts[0]);
      const duration = parts[1] ? parseClock(parts[1]) : null;
      if (elapsed !== null) {
        state.elapsed = elapsed;
        state.hasProgress = true;
      }
      if (duration) state.duration = duration;
      return;
    }
    if (cur && total) {
      const w = parseFloat(cur.style.width) || 0;
      const tw = total.getBoundingClientRect().width || 0;
      if (tw > 0) {
        state.elapsed = (w / 100) * (state.duration || 0);
        state.hasProgress = true;
      }
    }
  }

  // ---------------------------------------------------------------- 通信
  function mainStateLine(extra) {
    return {
      songId: state.songId,
      playing: state.playing,
      songName: state.songName,
      artist: state.artist,
      elapsed: state.elapsed,
      duration: state.duration,
      method: state.detectMethod,
      extra: extra || '',
    };
  }

  function publish(changed) {
    clearTimeout(notifyTimer);
    notifyTimer = setTimeout(() => send('wyy:state', mainStateLine(changed ? 'changed' : 'tick')), 60);
    if (changed) send('wyy:state', mainStateLine('changed'));
    // 事件在跨世界传递上出过幺蛾子，额外把状态挂到 DOM 上做兜底（隔离世界会轮询这里，
    // 同时省掉每个 tick 都发一次事件的开销）
    try {
      if (el.root) {
        el.root.setAttribute('data-wyy-state', JSON.stringify({
          songId: state.songId, playing: state.playing,
          songName: state.songName, artist: state.artist,
        }));
      }
    } catch (err) { /* ignore */ }
  }

  // ---------------------------------------------------------------- 面板
  function buildPanel() {
    const root = document.createElement('div');
    root.id = 'wyy-panel';
    root.className = 'wyy-panel wyy-hidden';
    root.innerHTML = `
      <div class="wyy-grip" data-wyy="grip"></div>
      <div class="wyy-head">
        <div class="wyy-title"><b data-wyy="song">暂无播放</b><small data-wyy="artist"></small></div>
        <div class="wyy-head-actions">
          <button class="wyy-icon" data-wyy="reload" title="重新获取歌词" aria-label="重新获取歌词">↻</button>
          <button class="wyy-icon" data-wyy="compact" title="小窗模式" aria-label="小窗模式">–</button>
          <button class="wyy-icon" data-wyy="hide" title="隐藏面板（Alt+L 恢复）" aria-label="隐藏面板">×</button>
        </div>
      </div>
      <div class="wyy-body" data-wyy="body">
        <div class="wyy-list" data-wyy="list"></div>
        <div class="wyy-empty" data-wyy="empty"></div>
      </div>
      <div class="wyy-foot">
        <span class="wyy-chip" data-wyy="chip"></span>
        <div class="wyy-count">
          <button class="wyy-chip wyy-btn" data-wyy="tr" title="显示/隐藏翻译">译</button>
          <button class="wyy-chip wyy-btn" data-wyy="ro" title="显示/隐藏罗马音">音</button>
          <span class="wyy-time" data-wyy="time">0:00 / 0:00</span>
        </div>
      </div>`;

    const ref = (name) => root.querySelector(`[data-wyy="${name}"]`);
    el.root = root;
    el.grip = ref('grip');
    el.head = root.querySelector('.wyy-head');
    el.song = ref('song');
    el.artist = ref('artist');
    el.body = ref('body');
    el.list = ref('list');
    el.empty = ref('empty');
    el.chip = ref('chip');
    el.time = ref('time');
    el.btnTr = ref('tr');
    el.btnRo = ref('ro');
    el.btnReload = ref('reload');
    el.btnCompact = ref('compact');
    el.btnHide = ref('hide');

    // 交互
    el.btnHide.addEventListener('click', (e) => { e.stopPropagation(); send('wyy:settings', { enabled: false }); });
    el.btnCompact.addEventListener('click', (e) => {
      e.stopPropagation();
      send('wyy:settings', { compact: !settings.compact });
    });
    el.btnReload.addEventListener('click', (e) => {
      e.stopPropagation();
      el.root.classList.remove('wyy-empty-state');
      send('wyy:retry', {});
    });
    el.btnTr.addEventListener('click', (e) => {
      e.stopPropagation();
      send('wyy:settings', { showTranslation: !settings.showTranslation });
    });
    el.btnRo.addEventListener('click', (e) => {
      e.stopPropagation();
      send('wyy:settings', { showRoman: !settings.showRoman });
    });

    // 拖动（展开态拖标题，小窗态拖整块）
    makeDraggable(el.grip, () => (settings.compact ? cpos : pos), () => applyPosition());
    makeDraggable(el.head, () => (settings.compact ? cpos : pos), () => applyPosition(), () => !settings.compact);

    // 手动滚动时暂时不要抢滚动条
    el.body.addEventListener('scroll', () => {
      if (programmaticScroll) return;
      userScrolling = true;
      clearTimeout(userScrollTimer);
      userScrollTimer = setTimeout(() => { userScrolling = false; }, 2500);
    }, { passive: true });

    el.body.addEventListener('click', (e) => {
      const line = e.target.closest ? e.target.closest('.wyy-line') : null;
      if (!line || !el.body.contains(line)) return;
      const t = parseFloat(line.getAttribute('data-t'));
      if (isFinite(t)) seekTo(t);
    });

    // 快捷键：Alt+L 显示/隐藏，Alt+C 小窗
    document.addEventListener('keydown', (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const k = String(e.key || '').toLowerCase();
      if (k === 'l') {
        e.preventDefault();
        send('wyy:settings', { enabled: !settings.enabled });
      } else if (k === 'c') {
        e.preventDefault();
        send('wyy:settings', { compact: !settings.compact });
      }
    }, true);

    document.body.appendChild(root);
    applySettings();
    applyPosition();
    return root;
  }

  let programmaticScroll = false;

  function makeDraggable(handle, getPos, after, skip) {
    if (!handle) return;
    handle.addEventListener('mousedown', (e) => {
      if (skip && skip()) return;
      if (e.button !== 0) return;
      const rect = el.root.getBoundingClientRect();
      const offX = e.clientX - rect.left;
      const offY = e.clientY - rect.top;
      const p = getPos();
      const onMove = (ev) => {
        p.x = clamp(ev.clientX - offX, 4, window.innerWidth - rect.width - 4);
        p.y = clamp(ev.clientY - offY, 4, window.innerHeight - 44);
        applyPosition(true);
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('mouseup', onUp, true);
        el.root.classList.remove('wyy-dragging');
        persistPosition();
        if (after) after();
      };
      el.root.classList.add('wyy-dragging');
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
      e.preventDefault();
    });
  }

  function barHeight() {
    const bar = document.querySelector(BAR_SEL);
    const h = bar ? bar.getBoundingClientRect().height : 0;
    return h > 0 ? Math.round(h) : 80;
  }

  function applyPosition(noTransition) {
    const compact = !!settings.compact;
    const p = compact ? cpos : pos;
    if (compact && p.y === null) {
      // 小窗默认贴在右下角：清掉展开态留下的内联 top，并避让底部播放条
      el.root.style.left = '';
      el.root.style.top = 'auto';
      el.root.style.bottom = Math.max(12, barHeight() + 8) + 'px';
      el.root.classList.toggle('wyy-nopos', p.x === null);
      return;
    }
    const rect = el.root.getBoundingClientRect();
    if (p.x === null) el.root.style.left = '';
    else el.root.style.left = clamp(p.x, 4, Math.max(4, window.innerWidth - (rect.width || 320) - 4)) + 'px';
    if (p.y === null) {
      el.root.style.top = '';
      el.root.style.bottom = '';
    } else {
      el.root.style.bottom = 'auto';   // 拖动后以 top 定位，避免和 .wyy-compact 的 bottom 打架
      el.root.style.top = clamp(p.y, 4, Math.max(4, window.innerHeight - 44)) + 'px';
    }
    el.root.classList.toggle('wyy-nopos', p.x === null && p.y === null);
    if (noTransition) el.root.classList.add('wyy-dragging');
  }

  function persistPosition() {
    // 位置只在会话里记（写 localStorage 会和站点自身存储混在一起，不划算）
  }

  /** 面板还没建好之前（document_start 阶段）所有 UI 操作都要空转，否则会打断脚本执行。 */
  function panelReady() {
    return !!(el.root && el.root.isConnected);
  }

  function applySettings() {
    if (!panelReady()) return;
    const enabled = settings.enabled !== false;
    el.root.classList.toggle('wyy-hidden', !enabled);
    el.root.classList.toggle('wyy-compact', !!settings.compact);
    el.root.style.setProperty('--wyy-font', (Number(settings.fontSize) || 15) + 'px');
    el.root.style.setProperty('--wyy-a', (clamp(Number(settings.opacity) || 92, 40, 100) / 100).toFixed(3));
    el.btnTr.classList.toggle('wyy-on', !!settings.showTranslation);
    el.btnRo.classList.toggle('wyy-on', !!settings.showRoman);
    el.root.classList.toggle('wyy-hide-nav', settings.autoHideNav !== false);
    el.root.style.width = settings.compact
      ? Math.max(260, Math.min(620, Math.round(window.innerWidth * 0.3))) + 'px'
      : '';
    applyPosition();
    renderLines();
  }

  function showLyricNotice(text, retryable) {
    el.empty.innerHTML = '';
    const p = document.createElement('div');
    p.className = 'wyy-empty-text';
    p.textContent = text;
    el.empty.appendChild(p);
    if (retryable) {
      const b = document.createElement('button');
      b.className = 'wyy-retry';
      b.textContent = '重新获取';
      b.addEventListener('click', () => send('wyy:retry', {}));
      el.empty.appendChild(b);
    }
    el.empty.classList.add('wyy-show');
    el.list.style.display = 'none';
    if (el.body) el.body.classList.add('wyy-list-hidden');
  }

  function hideNotice() {
    el.empty.classList.remove('wyy-show');
    el.list.style.display = '';
    if (el.body) el.body.classList.remove('wyy-list-hidden');
  }

  // ---------------------------------------------------------------- 渲染
  /** 过滤掉既没原文、也没可显示的译文/音译的空行（网易歌词里这种空行不少）。 */
  function hasContent(l) {
    if (l.text && l.text.trim()) return true;
    if (settings.showTranslation && l.tr && l.tr.trim()) return true;
    if (settings.showRoman && l.ro && l.ro.trim()) return true;
    return false;
  }

  function visibleLines() {
    if (!payload || !payload.lines) return [];
    return payload.lines.filter(hasContent);
  }

  function renderLines() {
    if (!payload) {
      el.list.innerHTML = '';
      return;
    }
    const lines = visibleLines();
    if (!lines.length) {
      log('render-empty', { total: payload.lines ? payload.lines.length : 0, msg: payload.msg || '' });
      showLyricNotice(payload.msg || '这首歌还没有歌词', true);
      return;
    }
    hideNotice();
    const frag = document.createDocumentFragment();
    lines.forEach((line, i) => {
      const div = document.createElement('div');
      div.className = 'wyy-line' + (line.credit ? ' wyy-credit' : '');
      div.setAttribute('data-i', String(i));
      if (isFinite(line.t)) div.setAttribute('data-t', String(line.t));

      const main = document.createElement('div');
      main.className = 'wyy-txt';
      main.textContent = line.text || line.tr || line.ro || '';
      div.appendChild(main);

      if (settings.showRoman && line.ro && line.ro !== line.text) {
        const ro = document.createElement('div');
        ro.className = 'wyy-ro';
        ro.textContent = line.ro;
        div.appendChild(ro);
      }
      if (settings.showTranslation && line.tr && line.tr !== line.text) {
        const tr = document.createElement('div');
        tr.className = 'wyy-tr';
        tr.textContent = line.tr;
        div.appendChild(tr);
      }
      frag.appendChild(div);
    });
    el.list.innerHTML = '';
    el.list.appendChild(frag);
    el.root.classList.toggle('wyy-empty-state', false);
    activeIndex = -1;
    syncActive(true);
  }

  function findIndex(lines, t) {
    let lo = 0, hi = lines.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].t <= t + 0.12) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  function scrollToActive(node) {
    if (!node) return;
    const bodyRect = el.body.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    const compact = !!settings.compact;
    const target = el.body.scrollTop + (nodeRect.top - bodyRect.top)
      - (compact ? 0 : Math.max(0, (bodyRect.height - nodeRect.height) / 2 - 10));
    programmaticScroll = true;
    el.body.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    clearTimeout(scrollToActive._t);
    scrollToActive._t = setTimeout(() => { programmaticScroll = false; }, 420);
  }

  function syncActive(force) {
    if (!payload || !panelReady()) return;
    const lines = visibleLines();
    if (!lines.length) return;
    const t = state.elapsed;
    const idx = findIndex(lines, t);
    if (!force && idx === activeIndex) return;
    if (activeIndex >= 0) {
      const prev = el.list.querySelector(`.wyy-line[data-i="${activeIndex}"]`);
      if (prev) prev.classList.remove('wyy-active');
    }
    activeIndex = idx;
    if (idx >= 0) {
      const node = el.list.querySelector(`.wyy-line[data-i="${idx}"]`);
      if (node) {
        node.classList.add('wyy-active');
        if (!userScrolling) scrollToActive(node);
      }
    }
    el.root.classList.toggle('wyy-paused', !state.playing);
  }

  function updateHeader() {
    if (!panelReady()) return;
    const name = state.songName || (payload && payload.name) || '未知歌曲';
    el.song.textContent = name;
    el.artist.textContent = state.artist || '';
    el.time.textContent = `${mmss(state.elapsed)} / ${state.duration ? mmss(state.duration) : '--:--'}`;
    let chip = '';
    if (payload) {
      if (payload.origin) chip = payload.origin;
      if (payload.by) chip += (chip ? ' · ' : '') + '歌词：' + payload.by;
      if (payload.note) chip += (chip ? ' · ' : '') + payload.note;
    }
    if (desktopOnline !== null) {
      chip += (chip ? ' · ' : '') + (desktopOnline ? '桌面歌词已连接' : '桌面歌词未连接');
      el.chip.classList.toggle('wyy-chip-bad', desktopOnline === false);
    } else {
      el.chip.classList.remove('wyy-chip-bad');
    }
    el.chip.textContent = chip;
    el.chip.title = desktopOnline === false
      ? '桌面歌词服务没响应：请运行 wyy-desktop\\启动.cmd'
      : chip;
  }

  // ---------------------------------------------------------------- 跳转
  function pbar() {
    const bar = document.querySelector(BAR_SEL);
    return bar ? bar.querySelector('.m-pbar .barbg') || bar.querySelector('.m-pbar') : null;
  }

  function seekTo(seconds) {
    if (!settings.seekOnClick) return;
    const track = pbar();
    if (!track) {
      log('seek-failed', 'no progress bar');
      return;
    }
    const rect = track.getBoundingClientRect();
    if (!rect.width) return;
    const ratio = clamp((seconds - 0) / ((state.duration || 0) || 1), 0, 0.999);
    const x = rect.left + ratio * rect.width;
    const y = rect.top + rect.height / 2;
    for (const type of ['mousedown', 'mouseup', 'click']) {
      track.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
    }
    userScrolling = false;
    state.elapsed = seconds;
    syncActive(true);
  }

  // ---------------------------------------------------------------- 监听
  function watchPlayer() {
    document.addEventListener('click', (e) => {
      const bar = e.target && e.target.closest ? e.target.closest(BAR_SEL) : null;
      if (!bar) return;
      const action = e.target.closest && e.target.closest('[data-action]');
      const act = action && action.getAttribute('data-action');
      if (act && /play|prev|next|pause/.test(act)) {
        setTimeout(() => syncSong('click:' + act), 180);
        setTimeout(() => syncSong('click-late:' + act), 900);
      }
    }, true);

    window.addEventListener('hashchange', () => setTimeout(() => syncSong('hashchange'), 200));
    window.addEventListener('popstate', () => setTimeout(() => syncSong('popstate'), 200));

    const mo = new MutationObserver(() => {
      const bar = document.querySelector(BAR_SEL);
      if (bar) {
        // 只需低频纠正
        const now = Date.now();
        if (!mo._last || now - mo._last > 800) { mo._last = now; syncSong('mutation'); }
      }
    });
    try { mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] }); } catch (err) { /* ignore */ }

    window.addEventListener('resize', () => applyPosition());
  }

  let lastSig = '';
  function syncSong(reason) {
    if (override) {
      // 接管模式下进度由外部喂，别被页面里真实的 0% 进度覆盖
      state.detectMethod = 'override';
      if (override.simulate) state.elapsed = Number(override.elapsed) || 0;
      updateHeader();
      syncActive(false);
      return;
    }
    let info = detectFromApi() || detectFromInstance() || detectFromDom();
    if (!info) {
      if (state.songId) {
        state.songId = null;
        state.songName = '';
        state.artist = '';
        publish(true);
      }
      return;
    }
    readProgress();
    const sig = [info.id || '', info.name || '', info.artist || '', info.playing ? 1 : 0, info.method || ''].join('|');
    const changed = sig !== lastSig;
    state.detectMethod = info.method || state.detectMethod;
    if (info.id) state.songId = info.id;
    if (info.name) state.songName = info.name;
    if (info.artist) state.artist = info.artist;
    if (typeof info.playing === 'boolean') state.playing = info.playing;
    if (info.duration) state.duration = info.duration;
    if (changed) {
      lastSig = sig;
      log('detect', { id: state.songId, name: state.songName, artist: state.artist, method: state.detectMethod, playing: state.playing });
      if (!info.id && state.songName) {
        // 只有歌名时，问一次详情接口，拿回真正的歌曲 ID
        resolveIdByName(state.songName, state.artist);
      }
      publish(true);
    }
    updateHeader();
  }

  function resolveIdByName(name, artist) {
    // 只有歌名靠得住才去搜 ID，避免把界面文案当成歌名搜出一首风马牛不相及的歌
    if (!plausibleSongName(name) || String(name).trim().length < 2) return;
    try {
      const url = `https://music.163.com/api/search/get/web?csrf_token=&hlpretag=&hlposttag=&s=${encodeURIComponent((name + ' ' + (artist || '')).trim())}&type=1&offset=0&total=true&limit=3`;
      fetch(url, { credentials: 'include' })
        .then((r) => r.json())
        .then((j) => {
          const songs = (j && j.result && j.result.songs) || [];
          if (!songs.length) return;
          // 歌名对不上的结果直接丢掉，宁可没有歌词也不要张冠李戴
          const norm = (s) => String(s || '').replace(/[\s\u3000]+/g, '').toLowerCase();
          const hit = songs.find((s) => norm(s.name) === norm(name)) || songs.find((s) => norm(s.name).includes(norm(name)));
          if (!hit || !hit.id) {
            log('resolve-id-miss', { name, candidates: songs.slice(0, 3).map((s) => s.name) });
            return;
          }
          state.songId = String(hit.id);
          log('resolve-id', { name, id: state.songId, matched: hit.name });
          publish(true);
        })
        .catch(() => {});
    } catch (err) { /* ignore */ }
  }

  // 进度心跳：200ms 足够顺滑，且几乎不吃 CPU
  function tick() {
    if (override && override.simulate) {
      override.elapsed = (Number(override.elapsed) || 0) + 0.2;
      state.elapsed = override.elapsed;
    } else {
      readProgress();
    }
    if (!state.hasProgress && !(override && override.simulate)) return;
    syncActive(false);
    updateHeader();
    if (state.songId) publish(false);
  }

  setInterval(tick, 200);
  setInterval(() => syncSong('poll'), 1500);

  // ---------------------------------------------------------------- 设置 / 歌词事件
  document.addEventListener('wyy:settings', (ev) => {
    const patch = (ev && ev.detail) || {};
    settings = { ...settings, ...patch };
    if (!panelReady()) return;   // 面板建好后 boot() 会统一套用一次
    applySettings();
    renderLines();
  });

  document.addEventListener('wyy:loading', (ev) => {
    const d = ev.detail || {};
    if (!panelReady()) return;
    if (String(d.songId) !== String(state.songId)) return;
    el.root.classList.add('wyy-loading');
  });

  document.addEventListener('wyy:meta', (ev) => {
    const m = ev.detail || {};
    if (m.name) state.songName = m.name;
    if (m.artist) state.artist = m.artist;
    if (m.duration && !state.duration) state.duration = m.duration > 1000 ? m.duration / 1000 : m.duration;
    updateHeader();
  });

  document.addEventListener('wyy:lyric', (ev) => {
    const d = (ev && ev.detail) || {};
    if (!panelReady()) return;
    if (String(d.songId) !== String(state.songId)) return;
    el.root.classList.remove('wyy-loading');
    payload = {
      lines: d.lines || [],
      hasTranslation: !!d.hasTranslation,
      hasRoman: !!d.hasRoman,
      origin: d.origin || '',
      by: d.by || '',
      note: d.note || '',
      empty: !!d.empty,
      msg: d.msg || '',
    };
    // 没有翻译/罗马音时自动把按钮置灰，避免白点
    el.btnTr.disabled = !payload.hasTranslation;
    el.btnRo.disabled = !payload.hasRoman;
    el.btnTr.title = payload.hasTranslation ? '显示/隐藏翻译' : '这首歌没有翻译';
    el.btnRo.title = payload.hasRoman ? '显示/隐藏罗马音' : '这首歌没有罗马音';
    renderLines();
    renderedFor = state.songId;
    updateHeader();
  });

  document.addEventListener('wyy:debug', (ev) => {
    log('content:' + ((ev.detail && ev.detail.stage) || '?'), ev.detail && ev.detail.extra);
  });

  document.addEventListener('wyy:desktop', (ev) => {
    const d = (ev && ev.detail) || {};
    desktopOnline = d.online === true ? true : (d.online === false ? false : null);
    updateHeader();
  });

  // 给 popup / 手动排障用
  window.__WYY_LYRIC_API__ = {
    status: () => ({
      songId: state.songId,
      songName: state.songName,
      artist: state.artist,
      playing: state.playing,
      elapsed: state.elapsed,
      duration: state.duration,
      method: state.detectMethod,
      hasBar: !!document.querySelector(BAR_SEL),
      hasPlayer: !!playerApi(),
      getPlaying: (() => { try { return playerApi() ? playerApi().getPlaying() : null; } catch (e) { return 'ERR'; } })(),
      lyricLines: payload ? payload.lines.length : 0,
      lyricOrigin: payload ? payload.origin : '',
      renderedFor,
      log: debugLines.slice(-20),
    }),
    refresh: () => send('wyy:retry', {}),
    toggle: () => send('wyy:settings', { enabled: !settings.enabled }),
    debug: (on) => { window.__WYY_DEBUG__ = !!on; },
    /** 手动接管播放状态（排障/预览用），传 null 恢复自动探测。simulate:true 会让时间自己往前走。 */
    override: (s) => {
      if (!s) { override = null; syncSong('override-off'); return; }
      override = { ...s };
      if (override.songId) state.songId = String(override.songId);
      if (override.songName) state.songName = override.songName;
      if (override.artist !== undefined) state.artist = override.artist;
      if (override.playing !== undefined) state.playing = !!override.playing;
      if (override.elapsed !== undefined) { state.elapsed = Number(override.elapsed) || 0; state.hasProgress = true; }
      if (override.duration !== undefined) state.duration = Number(override.duration) || 0;
      state.detectMethod = 'override';
      updateHeader();
      syncActive(true);
      publish(true);
    },
  };

  // ---------------------------------------------------------------- 启动
  function boot() {
    if (!document.body) return;
    buildPanel();
    ready = true;
    syncSong('boot');
    send('wyy:main-ready', { at: Date.now() });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  // SPA：地址变了也重新探一次
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      syncSong('href');
    }
  }, 800);
})();
