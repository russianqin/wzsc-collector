'use strict';

/** 后台：负责和本机服务（127.0.0.1:8765）通信，避免页面上的跨域限制。 */

// 本机服务可能在 8765~8768 中的任意端口（端口被占用时会自动往后挪），这里逐个探测
const PORTS = [8765, 8766, 8767, 8768];
const MIN_VERSION = '0.2.5';

/**
 * 在所有候选端口里挑**版本最高**的那个服务：
 * 机器上常常还挂着旧版本的服务（端口被占就没法换），挑最高版本能保证用到最新代码。
 */
async function findService() {
  const candidates = [];
  for (const port of PORTS) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { cache: 'no-store' });
      if (!response.ok) continue;
      const data = await response.json();
      if (data && data.ok && String(data.version || '').localeCompare(MIN_VERSION) >= 0) {
        candidates.push(Object.assign({ base: `http://127.0.0.1:${port}` }, data));
      }
    } catch (error) {
      /* 端口没服务，试下一个 */
    }
  }
  candidates.sort((a, b) => String(b.version).localeCompare(String(a.version)) || a.base.length - b.base.length);
  return candidates[0] || null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return undefined;

  if (message.type === 'health') {
    findService()
      .then((service) => sendResponse(service ? Object.assign({ ok: true }, service) : { ok: false, error: '没找到本机服务' }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === 'save') {
    findService()
      .then((service) => {
        if (!service) throw new Error('没找到本机服务，请先双击「启动收藏服务.cmd」');
        return fetch(service.base + '/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(message.payload)
        });
      })
      .then((response) => response.json())
      .then((data) => sendResponse(data))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === 'openRepo') {
    findService()
      .then((service) => {
        if (!service) throw new Error('没找到本机服务，请先双击「启动收藏服务.cmd」');
        return fetch(service.base + '/open-repo', { method: 'POST' });
      })
      .then((response) => response.json())
      .then((data) => sendResponse(data))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  return undefined;
});
