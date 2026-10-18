// Offline check of the exact parsing logic used in content.js, against live API data.
const IDS = [
  { id: 186016, label: '晴天 / 周杰伦 (中文 + 翻译)' },
  { id: 22637331, label: '平戸慕情 (日语 + 罗马音)' },
  { id: 347230, label: '海阔天空 / Beyond (粤语 + 粤拼)' },
  { id: 28815255, label: 'I Wanna Get Better (英文 + 翻译)' },
];

const TAG_RE = /\[(ar|ti|al|by|offset|re|ve|length|kana|language)\s*:\s*([^\]]*)\]/gi;
const STAMP_RE = /\[(\d{1,4}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const CREDIT_RE = /^\s*(作词|作曲|编曲|制作人|和声|吉他|贝斯|鼓|键盘|弦乐|混音|母带|录音|监制|统筹|出品|发行|OP|SP|词|曲|演唱|原唱|录音室|录音师|配唱|合声|和声编写|Program|Piano|Guitar|Bass|Drum|Strings|Mix|Mastering|Producer|Composer|Lyricist|Arranger|Written by|Music by|Lyrics by|Produced by|Mixed by)\s*[:：]/i;
const CREDIT_TAIL_RE = /\s*[:：]\s*[^:：]{1,40}$/;

function isCredit(text) {
  const t = text.trim();
  if (!t) return false;
  if (CREDIT_RE.test(t)) return true;
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
    if (key === 'offset') { const n = parseInt(val, 10); if (!Number.isNaN(n)) offset = n; }
  }
  for (const rawLine of raw.split(/\r?\n/)) {
    const stamps = [];
    STAMP_RE.lastIndex = 0;
    let s;
    while ((s = STAMP_RE.exec(rawLine))) {
      const mm = parseInt(s[1], 10), ss = parseInt(s[2], 10);
      let frac = 0;
      if (s[3] !== undefined) {
        const d = s[3];
        frac = d.length === 1 ? parseInt(d, 10) / 10 : d.length === 2 ? parseInt(d, 10) / 100 : parseInt(d, 10) / 1000;
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
    let best = null;
    for (let i = cursor; i < pool.length; i++) {
      const d = Math.abs(pool[i].t - line.t);
      if (d <= 0.35) { best = pool[i]; cursor = i + 1; break; }
      if (pool[i].t > line.t + 0.35) break;
    }
    if (!best) {
      for (let i = 0; i < pool.length; i++) if (Math.abs(pool[i].t - line.t) <= 0.35) { best = pool[i]; break; }
    }
    if (best && best.text) line[field] = best.text;
  }
}

function buildLines(primary, translation, roman, offsetMs) {
  const lines = [];
  for (const l of primary.lines) lines.push({ t: l.t, text: l.text, tr: '', ro: '', credit: isCredit(l.text) });
  mergeTracked(lines, parseText(translation), 'tr');
  mergeTracked(lines, parseText(roman), 'ro');
  if (offsetMs) for (const l of lines) l.c = l.t + offsetMs / 1000;
  let i = 0;
  while (i < lines.length && lines[i].credit) i++;
  for (let k = 0; k < i; k++) lines[k].t = Math.max(0, lines[k].c !== undefined ? lines[k].c : lines[k].t);
  return lines;
}

const H = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0', Referer: 'https://music.163.com/' };

for (const { id, label } of IDS) {
  const r = await fetch(`https://music.163.com/api/song/lyric?os=pc&id=${id}&lv=-1&kv=-1&tv=-1&rv=-1`, { headers: H });
  const j = await r.json();
  const lrc = j.lrc?.lyric || '', tly = j.tlyric?.lyric || '', rom = j.romalrc?.lyric || '';
  const primary = parseText(lrc);
  const lines = buildLines(primary, tly, rom, primary.meta.offset ? parseInt(primary.meta.offset, 10) : 0);
  const withTr = lines.filter(l => l.tr).length;
  const withRo = lines.filter(l => l.ro).length;
  const credits = lines.filter(l => l.credit).length;
  console.log(`\n### ${label}  id=${id}`);
  console.log(`行数=${lines.length} 带翻译=${withTr} 带罗马音=${withRo} 判定为制作信息=${credits}`);
  console.log('前 3 行:', lines.slice(0, 3).map(l => `[${l.t.toFixed(2)}]${l.credit ? '(credit)' : ''} ${l.text}`).join(' | '));
  const sample = lines.filter(l => l.text && !l.credit).slice(0, 3);
  for (const l of sample) {
    console.log(`  [${l.t.toFixed(2)}] ${l.text}${l.ro ? '  /音: ' + l.ro : ''}${l.tr ? '  /译: ' + l.tr : ''}`);
  }
  // 边界检查：时间戳单调、无 NaN
  const bad = lines.filter(l => !Number.isFinite(l.t));
  const unsorted = lines.some((l, i) => i > 0 && l.t < lines[i - 1].t);
  console.log(`校验: 非法时间戳=${bad.length} 乱序=${unsorted}`);
}
