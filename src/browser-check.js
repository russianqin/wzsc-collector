'use strict';

/**
 * 判断"浏览器现在开着吗"。
 * 服务跟着浏览器走：浏览器开着就待命（点扩展秒开），浏览器全关一会儿就下班。
 */

const { execFile } = require('child_process');

const BROWSERS = ['msedge.exe', 'chrome.exe', 'brave.exe', 'vivaldi.exe', 'opera.exe'];

/** 从 tasklist 的输出里找浏览器进程（抽出来方便单测） */
function parseProcessList(text) {
  const lower = String(text || '').toLowerCase();
  return BROWSERS.some((name) => lower.includes(name));
}

function browserRunning() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/NH'], { windowsHide: true, timeout: 8000 }, (error, stdout) => {
      // 查不出来时"当作浏览器开着"，宁可多待命一会儿，也不要误判成关了
      if (error) resolve(true);
      else resolve(parseProcessList(stdout));
    });
  });
}

module.exports = { browserRunning, parseProcessList, BROWSERS };
