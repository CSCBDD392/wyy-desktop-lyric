/**
 * 扩展弹窗：改设置、看当前状态、手动测一次取词。
 * 设置存在 chrome.storage.local，content.js 会把变更同步给面板。
 */

const DEFAULTS = {
  enabled: true,
  compact: false,
  showTranslation: true,
  showRoman: false,
  fontSize: 15,
  opacity: 92,
  source: 'netease',
  seekOnClick: true,
  autoHideNav: true,
  desktop: true,
  desktopPort: 28123,
};

const FIELDS = {
  enabled: 'checkbox',
  compact: 'checkbox',
  showTranslation: 'checkbox',
  showRoman: 'checkbox',
  seekOnClick: 'checkbox',
  fontSize: 'range',
  opacity: 'range',
  source: 'select',
  desktop: 'checkbox',
  desktopPort: 'number',
};

const $ = (id) => document.getElementById(id);
let settings = { ...DEFAULTS };
let tabId = null;

function activeTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs && tabs[0]));
  });
}

async function sendToTab(type, extra) {
  const tab = await activeTab();
  if (!tab || !/^https?:\/\/music\.163\.com\//.test(tab.url || '')) return { error: 'nomusic' };
  tabId = tab.id;
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, { type, ...(extra || {}) }, (res) => {
      if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
      else resolve(res || {});
    });
  });
}

function paint() {
  for (const [id, kind] of Object.entries(FIELDS)) {
    const input = $(id);
    if (!input) continue;
    if (kind === 'checkbox') input.checked = !!settings[id];
    else input.value = settings[id];
  }
  $('fontSizeVal').textContent = settings.fontSize + 'px';
  $('opacityVal').textContent = settings.opacity + '%';
}

function paintDesktop(desktop) {
  const box = $('desktopState');
  if (!desktop) { box.textContent = '未检测'; box.style.color = ''; return; }
  if (!desktop.enabled) {
    box.textContent = '已关闭';
    box.style.color = '';
    return;
  }
  if (desktop.online === true) {
    box.textContent = '已连接（127.0.0.1:' + desktop.port + '）';
    box.style.color = '#59d38a';
  } else if (desktop.online === false) {
    box.textContent = '连不上 → 去运行 wyy-desktop\\启动.cmd';
    box.style.color = '#ff7a7a';
  } else {
    box.textContent = '检测中…（端口 ' + desktop.port + '）';
    box.style.color = '';
  }
}

async function save(patch) {
  settings = { ...settings, ...patch };
  await chrome.storage.local.set({ settings });
  paint();
  await sendToTab('wyy-set-settings', { patch });
}

function renderStatus(s) {
  const box = $('status');
  if (s.error === 'nomusic') {
    box.innerHTML = '<b class="bad">当前标签页不是网易云音乐</b>\n请先打开 music.163.com 并播放一首歌。';
    return;
  }
  if (s.error) {
    box.innerHTML = '<b class="bad">连不上面板：</b>' + s.error + '\n刷新一下 music.163.com 页面再试。';
    return;
  }
  const cur = s.current || {};
  const lines = [
    `<b>${cur.songName || '（未检测到歌曲）'}</b>`,
    cur.artist ? '歌手：' + cur.artist : '',
    cur.songId ? '歌曲 ID：' + cur.songId : '歌曲 ID：未取到',
    '播放状态：' + (cur.playing ? '播放中' : '暂停'),
    s.cached ? `歌词：${s.cached.lines} 行 · ${s.cached.origin || ''}` : '歌词：尚未缓存',
  ].filter(Boolean);
  box.innerHTML = lines.join('\n');
}

async function init() {
  const data = await chrome.storage.local.get({ settings: DEFAULTS });
  settings = { ...DEFAULTS, ...(data.settings || {}) };
  paint();

  const status = await sendToTab('wyy-get-status');
  renderStatus(status);
  paintDesktop(status && status.desktop);

  for (const [id, kind] of Object.entries(FIELDS)) {
    const input = $(id);
    if (!input) continue;
    const evt = (kind === 'range' || kind === 'number') ? 'input' : 'change';
    input.addEventListener(evt, () => {
      const value = kind === 'checkbox'
        ? input.checked
        : (kind === 'range' ? Number(input.value) : (kind === 'number' ? Number(input.value) : input.value));
      save({ [id]: value });
      if (id === 'desktop' || id === 'desktopPort') {
        $('desktopState').textContent = value ? '检测中…' : '已关闭';
        setTimeout(async () => paintDesktop((await sendToTab('wyy-get-status')).desktop), 1500);
      }
    });
  }

  $('pingDesktop').addEventListener('click', async () => {
    $('desktopState').textContent = '正在探测…';
    const res = await sendToTab('wyy-desktop-ping');
    paintDesktop({ enabled: settings.desktop, port: settings.desktopPort, online: res.online });
    if (res.error) $('desktopState').textContent = '当前标签页不是网易云音乐';
  });

  $('test').addEventListener('click', async () => {
    $('status').textContent = '正在测试取词…';
    const res = await sendToTab('wyy-test');
    if (res.error) { renderStatus(res); return; }
    const ok = res.ok;
    $('status').innerHTML = [
      `<b class="${ok ? 'ok' : 'bad'}">${ok ? '取词成功' : '取词失败'}</b>`,
      res.meta ? `歌曲：${res.meta.name} — ${res.meta.artist}` : '',
      res.origin ? '来源：' + res.origin : '',
      typeof res.lines === 'number' ? '解析出：' + res.lines + ' 行' : '',
      res.error ? '原因：' + res.error : '',
      res.sample && res.sample.length ? '示例：\n' + res.sample.join('\n') : '',
    ].filter(Boolean).join('\n');
  });

  $('refresh').addEventListener('click', async () => {
    const res = await sendToTab('wyy-refresh');
    if (res.error) renderStatus(res);
    else {
      $('status').innerHTML = '<b class="ok">已请求重新获取歌词</b>';
      setTimeout(async () => renderStatus(await sendToTab('wyy-get-status')), 1200);
    }
  });
}

init();
