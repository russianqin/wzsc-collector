'use strict';

/** 后台：负责和本机服务（127.0.0.1:8765）通信，避免页面上的跨域限制。 */

// 本机服务可能在 8765~8768 中的任意端口（端口被占用时会自动往后挪），这里逐个探测
const PORTS = [8765, 8766, 8767, 8768];
const MIN_VERSION = '0.2.5';
// 浏览器端的小助手（bin\wzsc-host.exe）：它负责把本机服务拉起来
const NATIVE_HOST = 'com.wzsc.collector';

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

/** 叫醒本机服务：让浏览器启动小助手，小助手再把服务拉起来（没有窗口） */
function wakeService() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, { action: 'start' }, (response) => {
        const error = chrome.runtime.lastError;
        resolve(error ? { ok: false, error: error.message } : response || { ok: false });
      });
    } catch (error) {
      resolve({ ok: false, error: String(error) });
    }
  });
}

/**
 * 找服务：没有就先叫醒它，再等几秒。
 * 平时机器上什么都没在跑，第一次点扩展会有 1~2 秒的启动时间，这是正常的。
 */
async function findServiceWaiting(timeoutMs = 3000) {
  let service = await findService();
  if (service) return service;

  await wakeService();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    service = await findService();
    if (service) return service;
  }
  return null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return undefined;

  if (message.type === 'health') {
    findServiceWaiting()
      .then((service) => sendResponse(service ? Object.assign({ ok: true }, service) : { ok: false, error: '没找到本机服务' }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === 'save') {
    findServiceWaiting()
      .then((service) => {
        if (!service) throw new Error('本机服务没起来。请先双击项目里的「1-一键安装.cmd」');
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

  if (message.type === 'pasteComments') {
    findServiceWaiting()
      .then((service) => {
        if (!service) throw new Error('本机服务没起来。请先双击项目里的「1-一键安装.cmd」');
        return fetch(service.base + '/paste-comments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ number: message.number, text: message.text })
        });
      })
      .then((response) => response.json())
      .then((data) => sendResponse(data))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === 'openRepo') {
    findServiceWaiting()
      .then((service) => {
        if (!service) throw new Error('本机服务没起来。请先双击项目里的「1-一键安装.cmd」');
        return fetch(service.base + '/open-repo', { method: 'POST' });
      })
      .then((response) => response.json())
      .then((data) => sendResponse(data))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  return undefined;
});
