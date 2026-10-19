/**
 * 桌面歌词服务（本机 127.0.0.1）
 *
 * 干三件事：
 *   1. 收扩展上报的播放状态（切歌、暂停、位置），按墙钟推算「此刻播到哪」——
 *      这样浏览器最小化、标签页被节流也不影响歌词平滑滚动
 *   2. 取歌词（先扩展报的歌曲 id 走网易官方接口，再退回上次结果 / 报错）
 *   3. 提供歌词窗页面，供 Edge 应用模式窗口加载
 *
 * 只监听 127.0.0.1，不对外暴露；只发 GET，不带任何凭据。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.WYY_PORT || 28123);
const HOST = '127.0.0.1';
const ROOT = __dirname;

// ----------------------------------------------------------------- 播放状态
const state = {
  songId: null,
  songName: '',
  artist: '',
  playing: false,
  elapsed: 0,
  duration: 0,
  reportedAt: 0,      // 上次上报的本地时间（ms）
  reportedElapsed: 0, // 上报时的播放位置（秒）
  createdAt: 0,
  source: '',
  reportCount: 0,
  metaKey: '',        // 只有歌名歌手时用来识别切歌
};

const normName = (s) => String(s || '').replace(/[\s\u3000_\-·.，,()（）\[\]【】'"]+/g, '').toLowerCase();

/**
 * 用「歌名 + 歌手」去网易云搜歌曲 id。
 * 只靠系统媒体会话上报时没有 id，必须先搜一次；匹配不上宁可返回 null 也不乱认。
 */
async function resolveSongId(title, artist) {
  const q = `${title} ${artist || ''}`.trim();
  if (!q) return null;
  const url = 'https://music.163.com/api/search/get/web?csrf_token=&hlpretag=&hlposttag=&s=' +
    encodeURIComponent(q) + '&type=1&offset=0&total=true&limit=8';
  const json = await getJson(url, 'https://music.163.com/');
  const songs = (json.result && json.result.songs) || [];
  if (!songs.length) return null;

  const wantName = normName(title);
  const wantArtist = normName(artist);
  let best = null;
  let bestScore = -1;
  for (const s of songs) {
    const n = normName(s.name);
    const artists = (s.artists || []).map((a) => normName(a.name)).join('|');
    let score = 0;
    if (n === wantName) score += 100;
    else if (n.includes(wantName) || wantName.includes(n)) score += 50;
    else continue;                                  // 歌名完全对不上，直接不认
    if (wantArtist && artists.includes(wantArtist)) score += 30;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return best && best.id ? String(best.id) : null;
}

const FRESH_MS = 15000;        // 多久没上报算「网页版没连上」
const STALE_FREEZE_MS = 30000; // 超过这么久就冻结位置，别再拿旧数据外推

/** 此刻的播放位置：在最后上报值上叠加流逝的时间。 */
function currentElapsed() {
  if (!state.playing) return state.reportedElapsed;
  const gap = Date.now() - state.reportedAt;
  // 网页版长时间没消息：位置冻结在最后一次，绝不无限外推（否则歌词会和实际播放差出几分钟）
  if (gap > STALE_FREEZE_MS) return state.reportedElapsed;
  const max = state.duration > 0 ? state.duration : Infinity;
  return Math.max(0, Math.min(state.reportedElapsed + gap / 1000, max));
}

function acceptReport(body) {
  const now = Date.now();
  const prevSongId = state.songId;

  if (body.songId != null) state.songId = String(body.songId);
  // 来自系统媒体会话的上报只有歌名/歌手（title/artist）
  const title = typeof body.title === 'string' ? body.title : (typeof body.songName === 'string' ? body.songName : '');
  if (title) state.songName = title;
  if (typeof body.artist === 'string') state.artist = body.artist;
  if (typeof body.duration === 'number' && body.duration > 0) state.duration = body.duration;
  if (typeof body.playing === 'boolean') state.playing = body.playing;
  if (typeof body.elapsed === 'number' && body.elapsed >= 0) state.reportedElapsed = body.elapsed;
  if (typeof body.source === 'string') state.source = body.source;

  state.reportedAt = now;
  state.reportCount++;
  if (!state.createdAt) state.createdAt = now;

  const metaKey = normName(state.songName) + '|' + normName(state.artist);
  const metaChanged = !!state.songName && metaKey !== state.metaKey;
  state.metaKey = metaKey;
  const songChanged = state.songId !== prevSongId;

  if (state.reportCount <= 3 || state.reportCount % 300 === 0) {
    console.log(`[report #${state.reportCount}] source=${state.source} "${state.songName}" / ${state.artist} ` +
      `playing=${state.playing} elapsed=${state.reportedElapsed.toFixed(1)} dur=${state.duration} id=${state.songId || '-'}`);
  }

  // 没有 id（系统媒体会话那条路）：按歌名歌手搜一次
  if (!body.songId && metaChanged && state.songName) {
    resolveSongId(state.songName, state.artist)
      .then((id) => {
        if (id) {
          console.log(`[resolve] "${state.songName}" -> id=${id}`);
          state.songId = id;
          lyrics = { key: null, lines: [], status: 'loading', msg: '', origin: '', hasTranslation: false, hasRoman: false };
          fetchLyrics(id, false).catch(() => {});
        } else {
          console.log(`[resolve] "${state.songName}" 未匹配到网易云歌曲`);
          lyrics = {
            key: null, lines: [], status: 'empty', msg: '没找到这首歌的歌词（' + state.songName + '）',
            origin: '', hasTranslation: false, hasRoman: false,
          };
        }
      })
      .catch(() => {});
  } else if (songChanged && state.songId) {
    lyrics = { key: null, lines: [], status: 'loading', msg: '', origin: '', hasTranslation: false, hasRoman: false };
    fetchLyrics(state.songId, false).catch(() => {});
  }

  return { ok: true, songChanged: songChanged || metaChanged, reportCount: state.reportCount, songId: state.songId };
}

function freshMs() {
  return state.reportedAt ? Date.now() - state.reportedAt : Infinity;
}

// ----------------------------------------------------------------- 歌词
let lyrics = { key: null, lines: [], status: 'idle', msg: '', origin: '', hasTranslation: false, hasRoman: false };
const lyricCache = new Map();
const appLogs = [];

const STAMP_RE = /\[(\d{1,4}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const TAG_RE = /^\[(ar|ti|al|by|offset|re|ve|length)\s*:\s*([^\]]*)\]/i;

// 版权/制作信息行：官方网页版滚动歌词里不显示这些，桌面歌词也不该把它当歌词
const CREDIT_RE = /^\s*(作词|作曲|编曲|制作人|和声|和声编写|吉他|贝斯|鼓|键盘|弦乐|混音|母带|母带工程师|录音|录音室|录音师|监制|统筹|出品|发行|OP|SP|词|曲|演唱|原唱|配唱|合声|Program|Piano|Guitar|Bass|Drum|Strings|Mix|Mastering|Producer|Composer|Lyricist|Arranger|Written by|Music by|Lyrics by|Produced by|Mixed by|Recorded by)\s*[:：]/i;

function isCreditLine(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (CREDIT_RE.test(t)) return true;
  // "词:xxx" 这类短句
  return t.length <= 28 && /^[\u4e00-\u9fa5A-Za-z ()（）·\/&.-]{1,16}\s*[:：]\s*\S/.test(t);
}

function parseLrc(raw) {
  const lines = [];
  let offset = 0;
  if (typeof raw !== 'string' || !raw.trim()) return { lines, offset };
  for (const rawLine of raw.split(/\r?\n/)) {
    const tag = TAG_RE.exec(rawLine.trim());
    if (tag) {
      if (tag[1].toLowerCase() === 'offset') offset = parseInt(tag[2], 10) || 0;
      continue;
    }
    const stamps = [];
    STAMP_RE.lastIndex = 0;
    let m;
    while ((m = STAMP_RE.exec(rawLine))) {
      const mm = parseInt(m[1], 10);
      const ss = parseInt(m[2], 10);
      let frac = 0;
      if (m[3] !== undefined) {
        const d = m[3];
        frac = d.length === 1 ? parseInt(d, 10) / 10 : d.length === 2 ? parseInt(d, 10) / 100 : parseInt(d, 10) / 1000;
      }
      stamps.push(mm * 60 + ss + frac);
    }
    if (!stamps.length) continue;
    const text = rawLine.replace(STAMP_RE, '').replace(/\s+$/, '').trim();
    for (const t of stamps) lines.push({ t, text, credit: isCreditLine(text) });
  }
  lines.sort((a, b) => a.t - b.t);
  return { lines, offset };
}

function mergeByTime(base, extraRaw, field) {
  const extra = parseLrc(extraRaw).lines.filter((l) => l.text);
  if (!extra.length) return 0;
  let hit = 0;
  for (const line of base) {
    let best = null;
    for (const e of extra) {
      if (Math.abs(e.t - line.t) <= 0.35) { best = e; break; }
      if (e.t > line.t + 0.35) break;
    }
    if (best && best.text) { line[field] = best.text; hit++; }
  }
  return hit;
}

/**
 * 去掉末尾的版权信息行。
 * 歌里最后一句唱完到整曲结束之间常塞着一串「录音 : xxx」「OP : xxx」，
 * 留着会让「正在唱哪句」永远钉在版权行上，官方网页版也不显示它们。
 */
function trimTrailingCredits(lines) {
  let end = lines.length;
  while (end > 0 && lines[end - 1].credit) end--;
  if (end < lines.length) lines.length = end;
  return lines;
}

const NETEASE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0';

async function getJson(url, referer) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': NETEASE_UA, Referer: referer },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

/** 备用源：QQ 音乐（官方接口失败或没有歌词时兜一次） */
async function fetchFromQQ(songName, artist) {
  if (!songName) return null;
  const key = encodeURIComponent(`${songName} ${artist || ''}`.trim());
  const search = await getJson(
    'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?ct=24&qqmusic_ver=1298&new_json=1&remoteplace=txt.yqq.song' +
    `&searchid=${Date.now()}&t=0&aggr=1&cr=1&catZhida=1&lossless=0&flag_qc=0&p=1&n=5&w=${key}` +
    '&g_tk=5381&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0',
    'https://y.qq.com/'
  );
  const list = (search.data && search.data.song && search.data.song.list) || [];
  if (!list.length) return null;
  const norm = (s) => String(s || '').replace(/[\s\u3000]+/g, '').toLowerCase();
  const pick = list.find((s) => norm(s.title || s.songname) === norm(songName)) || list[0];
  const mid = pick.mid || pick.songmid;
  if (!mid) return null;

  const lyr = await getJson(
    `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${mid}&g_tk=5381&format=json&nobase64=1&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0`,
    'https://y.qq.com/'
  );
  const decode = (s) => String(s || '')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

  const raw = decode(lyr.lyric);
  const parsed = parseLrc(raw);
  if (!parsed.lines.length) return null;
  const lines = parsed.lines.map((l) => ({ t: l.t, text: l.text, tr: '', ro: '' }));
  const hasTranslation = mergeByTime(lines, decode(lyr.trans), 'tr') > 0;
  return {
    key: null, lines, status: 'ok', msg: '',
    origin: 'QQ 音乐（备用源）', hasTranslation, hasRoman: false,
  };
}

async function fetchLyrics(songId, force) {
  if (!songId) {
    lyrics = { key: null, lines: [], status: 'waiting', msg: '等待网页版开始播放', origin: '', hasTranslation: false, hasRoman: false };
    return lyrics;
  }
  const key = String(songId);
  if (!force && lyrics.key === key && lyrics.lines.length) return lyrics;
  if (!force && lyricCache.has(key)) {
    lyrics = lyricCache.get(key);
    return lyrics;
  }

  lyrics = { key, lines: [], status: 'loading', msg: '', origin: '', hasTranslation: false, hasRoman: false };
  try {
    const url = `https://music.163.com/api/song/lyric?os=pc&id=${encodeURIComponent(key)}&lv=-1&kv=-1&tv=-1&rv=-1`;
    const json = await getJson(url, 'https://music.163.com/');

    const lrc = (json.lrc && json.lrc.lyric) || '';
    const tlyric = (json.tlyric && json.tlyric.lyric) || '';
    const romalrc = (json.romalrc && json.romalrc.lyric) || '';
    const parsed = parseLrc(lrc);
    const words = parsed.lines.map((l) => l.text).filter(Boolean);
    const isPlaceholder = !words.length || words.every((w) => /^(暂无歌词|纯音乐|请欣赏|暂无|没有歌词)$/i.test(w));

    if (json.nolyric || isPlaceholder) {
      // 官方源没有 -> 试试 QQ 备用源
      const alt = await fetchFromQQ(state.songName, state.artist).catch(() => null);
      if (alt) {
        alt.key = key;
        alt.msg = json.nolyric ? '纯音乐（备用源也没有）' : '';
        lyrics = alt;
        lyricCache.set(key, lyrics);
        return lyrics;
      }
      lyrics = { key, lines: [], status: 'empty', msg: json.nolyric ? '纯音乐，请欣赏' : '这首歌还没有歌词', origin: '', hasTranslation: false, hasRoman: false };
      lyricCache.set(key, lyrics);
      return lyrics;
    }

    const lines = parsed.lines.map((l) => ({ t: l.t, text: l.text, tr: '', ro: '', credit: !!l.credit }));
    const hasTranslation = mergeByTime(lines, tlyric, 'tr') > 0;
    const hasRoman = mergeByTime(lines, romalrc, 'ro') > 0;
    const offset = parsed.offset ? parsed.offset / 1000 : 0;
    if (offset) for (const l of lines) l.t += offset;

    const contributor = (json.lyricUser && json.lyricUser.nickname) || '';
    lyrics = {
      key, lines, status: 'ok', msg: '',
      origin: '网易云音乐' + (contributor ? ' · 歌词：' + contributor : ''),
      hasTranslation, hasRoman,
    };
    trimTrailingCredits(lyrics.lines);

    // 只剩「纯音乐，请欣赏」这种占位行：当作没有歌词处理，别把它当歌词显示
    const contentLines = lyrics.lines.filter((l) => !l.credit && l.text && l.text.trim());
    const onlyPlaceholder = contentLines.length > 0 &&
      contentLines.every((l) => /^(纯音乐，?请欣赏|纯音乐|暂无歌词|请欣赏)$/.test(l.text.trim()));
    if (!contentLines.length || onlyPlaceholder) {
      lyrics = {
        key, lines: [], status: 'empty',
        msg: onlyPlaceholder ? '纯音乐，请欣赏' : '这首歌还没有歌词',
        origin: '', hasTranslation: false, hasRoman: false,
      };
      lyricCache.set(key, lyrics);
      return lyrics;
    }

    lyricCache.set(key, lyrics);
    if (lyricCache.size > 40) lyricCache.delete(lyricCache.keys().next().value);
    return lyrics;
  } catch (err) {
    // 官方接口整个失败 -> 备用源
    const alt = await fetchFromQQ(state.songName, state.artist).catch(() => null);
    if (alt) {
      alt.key = key;
      alt.note = '官方接口失败，已用备用源';
      lyrics = alt;
      lyricCache.set(key, lyrics);
      return lyrics;
    }
    lyrics = {
      key, lines: [], status: 'error',
      msg: '取词失败：' + String((err && err.message) || err),
      origin: '', hasTranslation: false, hasRoman: false,
    };
    return lyrics;
  }
}

// ----------------------------------------------------------------- HTTP
function json(res, code, data) {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function file(res, name, type) {
  const full = path.join(ROOT, name);
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  if (p === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><meta charset="utf-8"><title>桌面歌词服务</title>
<body style="font:14px/1.7 system-ui;background:#14161a;color:#e8ecf2;padding:28px">
<h2>桌面歌词服务在运行</h2>
<p>歌词窗由 <code>DesktopLyric.exe</code> 绘制，不需要浏览器。</p>
<ul>
  <li><a style="color:#7ab7ff" href="/api/state">/api/state</a> — 当前歌曲 + 歌词 + 位置</li>
  <li><a style="color:#7ab7ff" href="/api/health">/api/health</a> — 健康检查</li>
  <li><a style="color:#7ab7ff" href="/api/logs">/api/logs</a> — 歌词窗诊断日志</li>
</ul>
<p style="color:#8b94a3">数据由浏览器扩展 POST 到 /api/report；扩展里要打开「推到桌面歌词条」。</p>
</body>`);
    return;
  }

  if (p === '/api/report' && req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => { if (chunks.reduce((a, b) => a + b.length, 0) < 64 * 1024) chunks.push(c); });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { /* 忽略坏包 */ }
      const out = acceptReport(body || {});
      json(res, 200, out);
    });
    return;
  }

  if (p === '/api/state') {
    const fresh = freshMs();
    const connected = fresh < FRESH_MS;
    json(res, 200, {
      songId: state.songId,
      songName: state.songName,
      artist: state.artist,
      // 没在上报就当没在播：宁可显示「未连接」，也不拿旧数据假装在放
      playing: connected ? state.playing : false,
      elapsed: currentElapsed(),
      duration: state.duration,
      connected,
      stale: fresh,
      source: state.source,
      reportCount: state.reportCount || 0,
      lyrics: {
        status: lyrics.status,
        msg: lyrics.msg,
        origin: lyrics.origin,
        hasTranslation: lyrics.hasTranslation,
        hasRoman: lyrics.hasRoman,
        lines: lyrics.lines,
      },
    });
    return;
  }

  if (p === '/api/lyrics') {
    const force = url.searchParams.get('force') === '1';
    fetchLyrics(state.songId, force)
      .then((ly) => json(res, 200, ly))
      .catch((err) => json(res, 500, { status: 'error', msg: String(err && err.message) }));
    return;
  }

  if (p === '/api/log' && req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        appLogs.push({ at: Date.now(), tag: body.tag || 'app', msg: String(body.msg || '').slice(0, 400) });
        if (appLogs.length > 300) appLogs.splice(0, appLogs.length - 300);
        console.log(`[${body.tag || 'app'}] ${body.msg}`);
      } catch (e) { /* ignore */ }
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
      res.end();
    });
    return;
  }

  if (p === '/api/logs') {
    json(res, 200, { logs: appLogs.slice(-120) });
    return;
  }

  if (p === '/api/health') {
    json(res, 200, { ok: true, port: PORT, hasSong: !!state.songId, connected: freshMs() < 15000, uptime: process.uptime() });
    return;
  }

  res.writeHead(404); res.end('not found');
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    // 端口被占用通常意味着已经有一份在跑了——不是错误，直接退出即可
    console.error(`[wyy-desktop] 端口 ${PORT} 已被占用，说明服务很可能已经在运行。本次退出。`);
    process.exit(0);
  }
  console.error('[wyy-desktop] 服务启动失败:', err && err.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`[wyy-desktop] 歌词服务已启动: http://${HOST}:${PORT}/`);
  console.log(`[wyy-desktop] 歌词窗页面:     http://${HOST}:${PORT}/overlay`);
});

// 把未捕获异常写进日志，而不是让进程静默消失
process.on('uncaughtException', (err) => {
  try {
    console.error('[wyy-desktop] 未捕获异常:', (err && err.stack) || err);
  } catch (e) { /* ignore */ }
});
process.on('unhandledRejection', (err) => {
  try {
    console.error('[wyy-desktop] 未处理的 Promise 拒绝:', (err && err.stack) || err);
  } catch (e) { /* ignore */ }
});
