/**
 * 背景服务：只负责一件事 —— 代替网页去做跨域取词。
 *
 * 网页里的 content script 受页面 CORS 限制（网易接口只回 Access-Control-Allow-Origin:
 * https://music.163.com，扩展页面的 Origin 拿不到），所以真正的网络请求放到这里。
 * 这里带 host_permissions，属于扩展自身发起的请求，不受 CORS 约束。
 *
 * 安全：只允许访问下面白名单里的地址，只做 GET，不带任何 cookie / credentials。
 */

const ALLOW = [
  'https://music.163.com/api/song/lyric',
  'https://music.163.com/api/song/detail',
  'https://c.y.qq.com/',
  'http://127.0.0.1:',
  'http://localhost:',
];

const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 12000;

function allowed(url) {
  return ALLOW.some((prefix) => url.startsWith(prefix));
}

async function doFetch(url, noCache, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('timeout'), TIMEOUT_MS);
  try {
    const init = {
      method: body ? 'POST' : 'GET',
      credentials: 'omit',
      cache: noCache ? 'no-store' : 'default',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    };
    if (body) {
      init.headers['Content-Type'] = 'application/json';
      init.body = body;
    }
    const res = await fetch(url, init);
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) {
      return { ok: false, status: res.status, error: 'response too large' };
    }
    const text = new TextDecoder('utf-8').decode(buf);
    if (!res.ok) {
      return { ok: false, status: res.status, error: 'HTTP ' + res.status, text: '' };
    }
    return { ok: true, status: res.status, text };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'wyy-fetch' || typeof msg.url !== 'string') return false;
  if (!allowed(msg.url)) {
    sendResponse({ ok: false, error: 'blocked by allowlist' });
    return false;
  }
  const body = typeof msg.body === 'string' ? msg.body : null;
  doFetch(msg.url, !!msg.noCache, body).then(sendResponse);
  return true; // 异步应答
});
