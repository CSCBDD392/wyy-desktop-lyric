/**
 * 隔离世界 content script —— 插件的“外脑”。
 *
 *  - 从 background 跨域取歌词（网易官方接口，失败时退回 QQ 音乐接口）
 *  - 解析 LRC（含翻译 / 罗马音 / offset / 多时间戳 / 纯音乐判定）
 *  - 通过 document 事件与主世界脚本通信（两边共享同一个 DOM）
 *
 * 事件协议
 *   main  -> content : wyy:main-ready、wyy:state（当前歌曲/播放状态）、wyy:settings（用户改了设置）
 *   content -> main  : wyy:settings（下发设置）、wyy:lyric（下发解析好的歌词）、wyy:debug
 */

(() => {
  'use strict';

  const TAG = 'wyy-lyric-panel';

  // ---------------------------------------------------------------- 默认设置
  const DEFAULTS = {
    enabled: true,
    compact: false,
    showTranslation: true,
    showRoman: false,
    fontSize: 15,
    opacity: 92,
    source: 'netease', // netease | qq
    seekOnClick: true,
    autoHideNav: true,
    desktop: true,         // 是否把播放状态推给桌面歌词服务（默认开：这是主要用法）
    desktopPort: 28123,
  };

  // ---------------------------------------------------------------- 工具函数
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function post(type, detail) {
    try {
      document.dispatchEvent(new CustomEvent(type, { detail }));
    } catch (err) {
      /* 极端情况下页面重写 CustomEvent，忽略 */
    }
  }

  function debug(stage, extra) {
    post('wyy:debug', { stage, extra, at: Date.now() });
    // 排查用：about:config 里打开面板的 __WYY_DEBUG__ 即可在控制台看到
    try {
      if (window.__WYY_DEBUG__) console.log('[wyy-lyric/content]', stage, extra);
    } catch (err) { /* ignore */ }
  }

  /** 扩展优先走 background（无 CORS 限制），失败再直接用页面自身同源请求。 */
  async function httpGet(url, { noCache = false } = {}) {
    const viaBg = await new Promise((resolve) => {
      let done = false;
      try {
        chrome.runtime.sendMessage({ type: 'wyy-fetch', url, noCache }, (res) => {
          done = true;
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(res || { ok: false, error: 'empty response' });
        });
      } catch (err) {
        resolve({ ok: false, error: String(err && err.message) });
      }
      setTimeout(() => { if (!done) resolve({ ok: false, error: 'background timeout' }); }, 14000);
    });
    if (viaBg && viaBg.ok) return viaBg;
    if (viaBg && viaBg.status) return viaBg;   // 带状态码的失败（如 404）原样往上抛

    try {
      const res = await fetch(url, { credentials: 'omit', cache: noCache ? 'no-store' : 'default' });
      const text = await res.text();
      if (res.ok) return { ok: true, status: res.status, text };
      return { ok: false, status: res.status, error: 'HTTP ' + res.status };
    } catch (err) {
      return { ok: false, error: (viaBg && viaBg.error ? viaBg.error + ' / ' : '') + String(err && err.message) };
    }
  }

  // ---------------------------------------------------------------- LRC 解析
  const TAG_RE = /\[(ar|ti|al|by|offset|re|ve|length|kana|language)\s*:\s*([^\]]*)\]/gi;
  const STAMP_RE = /\[(\d{1,4}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  const CREDIT_RE = /^\s*(作词|作曲|编曲|制作人|和声|吉他|贝斯|鼓|键盘|弦乐|混音|母带|录音|监制|统筹|出品|发行|OP|SP|词|曲|演唱|原唱|录音室|录音师|配唱|合声|和声编写|Program|Piano|Guitar|Bass|Drum|Strings|Mix|Mastering|Producer|Composer|Lyricist|Arranger|Written by|Music by|Lyrics by|Produced by|Mixed by)\s*[:：]/i;
  const CREDIT_TAIL_RE = /\s*[:：]\s*[^:：]{1,40}$/;

  function isCredit(text) {
    const t = text.trim();
    if (!t) return false;
    if (CREDIT_RE.test(t)) return true;
    // "[00:00.000] 作词 : 周杰伦" 这类，去掉时间戳后是 "词:xx" 的短句
    return t.length <= 24 && CREDIT_TAIL_RE.test(t) && /^[\u4e00-\u9fa5A-Za-z ()（）·\/&.-]{1,16}\s*[:：]/.test(t);
  }

  function parseText(raw) {
    const out = { meta: {}, lines: [] };
    if (typeof raw !== 'string' || !raw.trim()) return out;

    let offset = 0;
    let m;
    TAG_RE.lastIndex = 0;
    while ((m = TAG_RE.exec(raw))) {
      const key = m[1].toLowerCase();
      const val = m[2].trim();
      out.meta[key] = val;
      if (key === 'offset') {
        const n = parseInt(val, 10);
        if (!Number.isNaN(n)) offset = n;
      }
    }

    for (const rawLine of raw.split(/\r?\n/)) {
      const stamps = [];
      STAMP_RE.lastIndex = 0;
      let s;
      while ((s = STAMP_RE.exec(rawLine))) {
        const mm = parseInt(s[1], 10);
        const ss = parseInt(s[2], 10);
        let frac = 0;
        if (s[3] !== undefined) {
          const digits = s[3];
          frac = digits.length === 1 ? parseInt(digits, 10) / 10
            : digits.length === 2 ? parseInt(digits, 10) / 100
              : parseInt(digits, 10) / 1000;
        }
        stamps.push(mm * 60 + ss + frac);
      }
      if (!stamps.length) continue;
      const text = rawLine.replace(STAMP_RE, '').replace(/\s+$/, '').trim();
      for (const t of stamps) out.lines.push({ t, text });
    }

    if (offset) for (const l of out.lines) l.t += offset / 1000;
    out.lines.sort((a, b) => a.t - b.t);
    out.lines = out.lines.filter((l) => l.t >= -2);
    return out;
  }

  function mergeTracked(base, extra, field) {
    if (!extra || !extra.lines.length) return;
    const pool = extra.lines.filter((l) => l.text);
    if (!pool.length) return;
    let cursor = 0;
    for (const line of base) {
      if (!line.text) continue;
      // 优先找时间戳几乎相同的，其次按顺序就近匹配
      let best = null;
      for (let i = cursor; i < pool.length; i++) {
        const d = Math.abs(pool[i].t - line.t);
        if (d <= 0.35) { best = pool[i]; cursor = i + 1; break; }
        if (pool[i].t > line.t + 0.35) break;
      }
      if (!best) {
        for (let i = 0; i < pool.length; i++) {
          if (Math.abs(pool[i].t - line.t) <= 0.35) { best = pool[i]; break; }
        }
      }
      if (best && best.text) line[field] = best.text;
    }
  }

  function buildLines(primary, translation, roman, offsetMs) {
    const lines = [];
    for (const l of primary.lines) {
      lines.push({ t: l.t, text: l.text, tr: '', ro: '', credit: isCredit(l.text) });
    }
    mergeTracked(lines, parseText(translation), 'tr');
    mergeTracked(lines, parseText(roman), 'ro');

    // 网易会把「作词 : xxx」之类的信息塞在 0~20 秒的连续时间戳上，
    // 这些行原本不显示，处理成瞬时行（到下一条歌词立刻消失），避免挡住第一句歌词。
    if (offsetMs) for (const l of lines) l.c = l.t + offsetMs / 1000;
    let i = 0;
    while (i < lines.length && lines[i].credit) i++;
    for (let k = 0; k < i; k++) {
      lines[k].t = Math.max(0, (lines[k].c !== undefined ? lines[k].c : lines[k].t));
    }
    return lines;
  }

  // ---------------------------------------------------------------- 取词
  const NETEASE_URL = (id, fresh) =>
    `https://music.163.com/api/song/lyric?os=pc&id=${id}&lv=-1&kv=-1&tv=-1&rv=-1` + (fresh ? `&_=${Date.now()}` : '');

  // 网易对「没歌词 / 纯音乐」会返回占位文案而不是空字段，这些都不算歌词
  const PLACEHOLDER_RE = /^(暂无歌词|纯音乐|请欣赏|暂无|没有歌词|该歌曲暂无歌词|此歌曲为没有填词的纯音乐.*|instrumental)$/i;

  function hasRealLyric(text) {
    const words = String(text || '').split(/\r?\n/).map((s) => s.replace(STAMP_RE, '').trim()).filter(Boolean);
    if (!words.length) return false;
    return words.some((w) => !PLACEHOLDER_RE.test(w));
  }

  async function fetchNetease(songId, noCache) {
    const res = await httpGet(NETEASE_URL(songId, noCache), { noCache });
    debug('netease-response', { ok: !!res.ok, status: res.status, error: res.error, bytes: res.text ? res.text.length : 0 });
    if (!res.ok) {
      // 404 说明这个 id 根本不存在，重试/换源都没意义
      if (res.status === 404) return { empty: true, permanent: true, msg: '没有找到这首歌（可能已下架）' };
      return { error: res.error || ('HTTP ' + (res.status || '?')) };
    }
    let json;
    try {
      json = JSON.parse(res.text);
    } catch (err) {
      return { error: 'bad json' };
    }
    const lrc = json.lrc && json.lrc.lyric ? json.lrc.lyric : '';
    const tlyric = json.tlyric && json.tlyric.lyric ? json.tlyric.lyric : '';
    const romalrc = json.romalrc && json.romalrc.lyric ? json.romalrc.lyric : '';
    const nolyric = !!json.nolyric;
    if (nolyric || (!hasRealLyric(lrc) && !hasRealLyric(tlyric))) {
      return { empty: true, msg: nolyric ? '纯音乐，请欣赏' : '这首歌还没有歌词' };
    }
    const primary = parseText(lrc || tlyric);
    if (!primary.lines.length) return { empty: true, msg: '歌词格式无法解析' };

    const extra = json.lyricUser || json.transUser;
    const by = extra && extra.nickname ? String(extra.nickname) : '';
    return {
      lines: buildLines(primary, tlyric, romalrc, primary.meta.offset ? parseInt(primary.meta.offset, 10) : 0),
      hasTranslation: !!tlyric.trim(),
      hasRoman: !!romalrc.trim(),
      by,
      origin: '网易云音乐',
    };
  }

  // 备用源：QQ 音乐搜索接口（只在网易接口失败时用）
  async function fetchQQ(songName, artistName) {
    if (!String(songName || '').trim()) return { empty: true, permanent: true, msg: '还没拿到歌名，无法用备用源' };
    const key = encodeURIComponent(`${songName} ${artistName}`.trim());
    const searchUrl =
      'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?ct=24&qqmusic_ver=1298&new_json=1&remoteplace=txt.yqq.song' +
      `&searchid=${Date.now()}&t=0&aggr=1&cr=1&catZhida=1&lossless=0&flag_qc=0&p=1&n=5&w=${key}` +
      '&g_tk=5381&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0';
    const res = await httpGet(searchUrl);
    if (!res.ok) return { error: res.error };
    let json;
    try {
      json = JSON.parse(res.text);
    } catch (err) {
      return { error: 'QQ 返回内容无法解析' };
    }
    const list = (json.data && json.data.song && json.data.song.list) || [];
    if (!list.length) return { empty: true, msg: '备用源没有找到这首歌' };
    const want = String(songName || '').trim();
    const pick = list.find((s) => String(s.title || s.songname || '').trim() === want) || list[0];
    const mid = pick.mid || pick.songmid;
    if (!mid) return { empty: true, msg: '备用源缺少歌曲标识' };
    const lyr = await httpGet(
      `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${mid}&g_tk=5381&format=json&nobase64=1&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0`
    );
    if (!lyr.ok) return { error: lyr.error };
    let lj;
    try {
      lj = JSON.parse(lyr.text);
    } catch (err) {
      return { error: '备用源歌词无法解析' };
    }
    const raw = lj.lyric ? decodeEntities(lj.lyric) : '';
    if (!raw.trim()) return { empty: true, msg: '备用源没有歌词' };
    const primary = parseText(raw);
    if (!primary.lines.length) return { empty: true, msg: '备用源歌词格式无法解析' };
    const tr = lj.trans ? decodeEntities(lj.trans) : '';
    return {
      lines: buildLines(primary, tr, '', primary.meta.offset ? parseInt(primary.meta.offset, 10) : 0),
      hasTranslation: !!tr.trim(),
      hasRoman: false,
      by: '',
      origin: 'QQ 音乐（备用源）',
    };
  }

  function decodeEntities(s) {
    if (!s) return '';
    return String(s)
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
      .replace(/&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&');
  }

  async function fetchSongMeta(songId) {
    const res = await httpGet(`https://music.163.com/api/song/detail?ids=%5B${songId}%5D`);
    if (!res.ok) return null;
    try {
      const json = JSON.parse(res.text);
      const s = json.songs && json.songs[0];
      if (!s) return null;
      return {
        id: songId,
        name: s.name || '',
        artist: (s.artists || []).map((a) => a.name).join(' / '),
        album: (s.album && s.album.name) || '',
        cover: (s.album && s.album.picUrl) || '',
        duration: s.duration || 0,
      };
    } catch (err) {
      return null;
    }
  }

  // ---------------------------------------------------------------- 状态机
  const cache = new Map(); // songId -> { lines, meta, ... }
  const inflight = new Map();
  const RETRY_DELAYS = [900, 2000];
  const MAX_ATTEMPTS = 3;
  let watchdog = 0;

  let settings = { ...DEFAULTS };
  let current = { songId: null, playing: false, songName: '', artist: '', elapsed: 0, duration: 0 };
  let token = 0;

  function songKey(id) {
    return String(id);
  }

  async function getLyrics(songId, { fresh = false, forceSource = null } = {}) {
    const key = songKey(songId);
    if (fresh) cache.delete(key);
    if (cache.has(key)) return cache.get(key);

    const taskKey = key + (forceSource || '');
    if (inflight.has(taskKey)) return inflight.get(taskKey);

    const task = (async () => {
      const source = forceSource || settings.source || 'netease';
      let result;
      try {
        result = source === 'qq'
          ? await fetchQQ(current.songName, current.artist)
          : await fetchNetease(songId, fresh);

        // 网易失败 / 空词时自动换备用源兜一次（歌曲本身不存在就不必折腾了）
        if (source === 'netease' && !result.permanent && (result.error || result.empty)) {
          debug('netease-fallback', { reason: result.error || result.msg });
          const alt = await fetchQQ(current.songName, current.artist).catch(() => null);
          if (alt && alt.lines && alt.lines.length) {
            alt.note = result.error ? '官方接口失败，已用备用源' : '官方接口没有歌词，已用备用源';
            result = alt;
          }
        }
      } catch (err) {
        debug('fetch-throw', String((err && err.stack) || err));
        result = { error: String((err && err.message) || err) };
      }
      if (result && result.lines && result.lines.length) cache.set(songKey(songId), result);
      return result;
    })();

    inflight.set(taskKey, task);
    try {
      return await task;
    } finally {
      inflight.delete(taskKey);
    }
  }

  async function load(songId, { fresh = false } = {}) {
    const my = ++token;
    const key = songKey(songId);
    post('wyy:loading', { songId });
    debug('load-start', { songId, fresh, source: settings.source });

    // 歌曲信息与歌词并行取，谁先回来先更新谁
    fetchSongMeta(songId).then((meta) => {
      if (my !== token || !meta) return;
      post('wyy:meta', meta);
    }).catch(() => {});

    // 看门狗：网络极差时也要给用户一个交代，别一直转圈
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      if (my !== token) return;
      post('wyy:lyric', { songId: String(songId), lines: [], empty: true, msg: '取词超时，请点重新获取' });
      debug('watchdog', { songId });
    }, 28000);

    let last = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (my !== token) { clearTimeout(watchdog); return; }
      const res = await getLyrics(songId, { fresh: fresh && attempt === 1 });
      if (my !== token) { clearTimeout(watchdog); return; }
      last = res;

      if (res && res.lines && res.lines.length) {
        clearTimeout(watchdog);
        post('wyy:lyric', {
          songId: String(songId),
          lines: res.lines,
          hasTranslation: !!res.hasTranslation,
          hasRoman: !!res.hasRoman,
          by: res.by || '',
          origin: res.origin || '',
          note: res.note || '',
          empty: false,
        });
        debug('lyric-ok', { songId, lines: res.lines.length, origin: res.origin });
        return;
      }

      // 终态（歌不存在 / 纯音乐 / 歌词格式坏）不重试；网络类错误才退避重试
      const retryable = !res || (!res.permanent && !res.empty) || (res.empty && !res.msg);
      if (!retryable || attempt === MAX_ATTEMPTS) break;
      debug('lyric-retry', { songId, attempt, reason: (res && (res.error || res.msg)) || 'empty' });
      await sleep(RETRY_DELAYS[Math.min(attempt - 1, RETRY_DELAYS.length - 1)]);
    }

    clearTimeout(watchdog);
    post('wyy:lyric', {
      songId: String(songId),
      lines: [],
      empty: true,
      msg: (last && (last.msg || last.error)) || '歌词获取失败',
      origin: (last && last.origin) || '',
    });
    debug('lyric-empty', { songId, reason: (last && (last.msg || last.error)) || 'unknown' });
  }

  // ---------------------------------------------------------------- 桌面歌词桥
  /**
   * 把「在放什么、放到哪」推给本机桌面歌词服务。
   *
   * 标签页被最小化后浏览器会节流计时器，所以这里不追求高频：
   * 平时每 1 秒报一次，切歌/暂停/跳转立刻报。桌面端收到后按墙钟自己推算位置，
   * 因此即使上报被拖慢到几十秒一次，歌词也不会卡住。
   *
   * 服务没启动时请求会失败，这里静默忽略，不影响页面内歌词面板。
   */
  const bridge = {
    online: null,          // null=未知 false=连不上 true=通
    lastAt: 0,
    lastKey: '',
    timer: null,
    failures: 0,
  };

  function desktopUrl(path) {
    const port = Number(settings.desktopPort) || 28123;
    return `http://127.0.0.1:${port}${path}`;
  }

  /** 走扩展后台发请求：网页直接 POST http://127.0.0.1 会被「本地网络访问」策略拦掉。 */
  function backgroundFetch(url, body) {
    return new Promise((resolve) => {
      let done = false;
      try {
        chrome.runtime.sendMessage({ type: 'wyy-fetch', url, body: body || null }, (res) => {
          done = true;
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(res || { ok: false, error: 'empty response' });
        });
      } catch (err) {
        resolve({ ok: false, error: String(err && err.message) });
      }
      setTimeout(() => { if (!done) resolve({ ok: false, error: 'background timeout' }); }, 8000);
    });
  }

  function pushDesktop(force) {
    if (!settings.desktop) return;
    if (!current.songId) return;
    const now = Date.now();
    const key = `${current.songId}|${current.playing ? 1 : 0}`;
    const changed = key !== bridge.lastKey;
    if (!force && !changed && now - bridge.lastAt < 1000) return;
    if (!force && !changed && !current.playing) return;   // 暂停时不用反复报
    bridge.lastAt = now;
    bridge.lastKey = key;

    const payload = {
      songId: current.songId,
      songName: current.songName || '',
      artist: current.artist || '',
      playing: !!current.playing,
      elapsed: Number(current.elapsed) || 0,
      duration: Number(current.duration) || 0,
      source: 'chrome-extension',
    };

    backgroundFetch(desktopUrl('/api/report'), JSON.stringify(payload)).then((res) => {
      const online = !!res.ok;
      bridge.failures = online ? 0 : bridge.failures + 1;
      if (bridge.online !== online) {
        bridge.online = online;
        post('wyy:desktop', { online });
      }
    });
  }

  async function pingDesktop() {
    if (!settings.desktop) return;
    const res = await backgroundFetch(desktopUrl('/api/health'));
    const online = !!res.ok;
    if (online !== bridge.online) {
      bridge.online = online;
      post('wyy:desktop', { online });
    }
    if (online) pushDesktop(true);
  }

  function startBridge() {
    if (bridge.timer) return;
    bridge.timer = setInterval(() => pushDesktop(false), 1000);
    setTimeout(pingDesktop, 300);
    bridge.pingTimer = setInterval(pingDesktop, 20000);
  }

  function stopBridge() {
    if (bridge.timer) { clearInterval(bridge.timer); bridge.timer = null; }
    if (bridge.pingTimer) { clearInterval(bridge.pingTimer); bridge.pingTimer = null; }
    bridge.online = null;
  }

  /**
   * 按当前设置同步桥接状态：
   *   关掉桌面歌词 -> 停止上报，并把状态置为「未启用」（面板不显示提示）
   *   打开         -> 开始上报，并立刻探一次服务在不在
   */
  function syncBridge(force) {
    if (settings.desktop) {
      startBridge();
      if (force) pushDesktop(true);
    } else {
      stopBridge();
      post('wyy:desktop', { online: null });
    }
  }

  // ---------------------------------------------------------------- 主世界通信
  document.addEventListener('wyy:main-ready', () => {
    debug('main-ready', { version: chrome.runtime.getManifest().version });
    pushSettings();
    if (current.songId && current.playing) load(current.songId);
  });

  let stateTimer = null;

  function applyState(s, via) {
    const changed = String(s.songId || '') !== String(current.songId || '');
    const wasPlaying = current.playing;
    current = {
      songId: s.songId ? String(s.songId) : null,
      playing: !!s.playing,
      songName: s.songName || '',
      artist: s.artist || '',
      elapsed: Number(s.elapsed) || 0,
      duration: Number(s.duration) || 0,
    };

    // 桌面歌词：切歌或播放状态变化时立刻同步一次
    if (settings.desktop && current.songId && (changed || current.playing !== wasPlaying)) {
      pushDesktop(true);
    }

    if (!current.songId) return;
    if (changed) {
      debug('state-song', { songId: current.songId, name: current.songName, via });
      clearTimeout(stateTimer);
      load(current.songId, { fresh: false });
    } else if (current.playing && !wasPlaying) {
      const cached = cache.get(songKey(current.songId));
      if (!cached) {
        clearTimeout(stateTimer);
        stateTimer = setTimeout(() => { if (current.playing) load(current.songId, { fresh: true }); }, 1200);
      }
    }
  }

  document.addEventListener('wyy:state', (ev) => {
    const detail = ev && ev.detail;
    debug('state-event', detail ? { songId: detail.songId, playing: detail.playing } : 'EMPTY-DETAIL');
    if (detail && typeof detail === 'object') applyState(detail, 'event');
  });

  /**
   * 兜底通道：主世界会把当前播放状态写在面板的 data-wyy-state 上。
   * 事件桥在个别浏览器/世界里可能传不过来，这条轮询保证切歌一定被发现。
   */
  let lastDomState = '';
  function pollDomState() {
    const node = document.getElementById('wyy-panel');
    if (!node) return;
    const raw = node.getAttribute('data-wyy-state') || '';
    if (raw === lastDomState) return;
    lastDomState = raw;
    try {
      const s = JSON.parse(raw);
      if (s && typeof s === 'object') applyState(s, 'dom');
    } catch (err) { /* ignore */ }
  }
  setInterval(pollDomState, 700);

  document.addEventListener('wyy:settings', (ev) => {
    const patch = (ev && ev.detail) || {};
    const before = { desktop: settings.desktop, desktopPort: settings.desktopPort };
    settings = { ...settings, ...patch };
    saveSettings();
    if (before.desktop !== settings.desktop || before.desktopPort !== settings.desktopPort) {
      syncBridge(true);
    }
    if (patch.source && current.songId) load(current.songId, { fresh: true });
  });

  document.addEventListener('wyy:retry', () => {
    if (current.songId) load(current.songId, { fresh: true });
  });

  function pushSettings() {
    post('wyy:settings', { ...settings, manifestVersion: chrome.runtime.getManifest().version });
  }

  function saveSettings() {
    try { chrome.storage.local.set({ settings }); } catch (err) { /* ignore */ }
  }

  // 让 popup 能读取 / 修改设置，也能问到当前歌曲
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return false;
    if (msg.type === 'wyy-get-settings') {
      sendResponse({ settings });
      return false;
    }
    if (msg.type === 'wyy-set-settings') {
      const before = { desktop: settings.desktop, desktopPort: settings.desktopPort };
      settings = { ...settings, ...(msg.patch || {}) };
      saveSettings();
      pushSettings();
      if (before.desktop !== settings.desktop || before.desktopPort !== settings.desktopPort) {
        syncBridge(true);
      }
      if (msg.patch && msg.patch.source && current.songId) load(current.songId, { fresh: true });
      sendResponse({ settings });
      return false;
    }
    if (msg.type === 'wyy-get-status') {
      const cached = current.songId ? cache.get(songKey(current.songId)) : null;
      sendResponse({
        settings,
        current,
        desktop: { enabled: !!settings.desktop, port: settings.desktopPort, online: bridge.online },
        cached: cached ? { lines: cached.lines.length, origin: cached.origin } : null,
      });
      return false;
    }
    if (msg.type === 'wyy-desktop-ping') {
      pingDesktop().then(() => sendResponse({ online: bridge.online }));
      return true;
    }
    if (msg.type === 'wyy-test') {
      (async () => {
        const id = msg.songId || current.songId;
        if (!id) { sendResponse({ ok: false, error: '当前没有在播的歌曲' }); return; }
        const meta = await fetchSongMeta(id);
        const res = await getLyrics(id, { fresh: true });
        sendResponse({
          ok: !!(res && res.lines && res.lines.length),
          meta,
          lines: res && res.lines ? res.lines.length : 0,
          origin: res && res.origin,
          error: res && (res.error || res.msg),
          sample: res && res.lines ? res.lines.filter((l) => l.text).slice(0, 3).map((l) => l.text) : [],
        });
      })();
      return true;
    }
    if (msg.type === 'wyy-refresh') {
      if (current.songId) load(current.songId, { fresh: true });
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  // 启动：读设置
  try {
    chrome.storage.local.get({ settings: DEFAULTS }, (data) => {
      settings = { ...DEFAULTS, ...(data.settings || {}) };
      pushSettings();
      syncBridge(true);
    });
  } catch (err) {
    pushSettings();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) {
      settings = { ...DEFAULTS, ...(changes.settings.newValue || {}) };
      pushSettings();
      syncBridge(true);
    }
  });

  window.addEventListener('pagehide', () => { cache.clear(); stopBridge(); });
})();
