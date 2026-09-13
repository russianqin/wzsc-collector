'use strict';

const fs = require('fs');

function log(...args) {
  const stamp = new Date().toTimeString().slice(0, 8);
  console.log(`[${stamp}]`, ...args);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 在 [min, max] 秒之间随机等待，避免连续请求过快 */
function randomDelay(range) {
  const [min, max] = Array.isArray(range) && range.length === 2 ? range : [5, 12];
  const seconds = min + Math.random() * (max - min);
  return sleep(Math.round(seconds * 1000));
}

/** 把标题变成安全的文件名（去掉系统非法字符、控制长度） */
function sanitizeFilename(title, maxLength = 80) {
  let name = String(title || 'untitled')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '·')
    .replace(/[#\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  if (name.length > maxLength) {
    name = name.slice(0, maxLength).trim();
  }
  return name || 'untitled';
}

/** 仓库里下一个可用编号（沿用 NNN.标题.md 的命名习惯） */
function nextSerial(repoPath, width = 3) {
  let max = 0;
  for (const name of fs.readdirSync(repoPath)) {
    const match = name.match(/^(\d{1,4})[.\-\s]/);
    if (match) max = Math.max(max, parseInt(match[1], 10));
  }
  return String(max + 1).padStart(width, '0');
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function guessExt(url, fallback = '.jpg') {
  try {
    const pathname = new URL(url).pathname;
    const ext = pathname.slice(pathname.lastIndexOf('.')).toLowerCase();
    if (/^\.(jpe?g|png|gif|webp|bmp|svg|mp4|webm)$/.test(ext)) return ext;
  } catch {
    /* ignore */
  }
  return fallback;
}

module.exports = { log, sleep, randomDelay, sanitizeFilename, nextSerial, hostOf, guessExt };
