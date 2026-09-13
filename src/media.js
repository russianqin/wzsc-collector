'use strict';

const fs = require('fs');
const path = require('path');
const { log, guessExt } = require('./util');

/**
 * 用浏览器上下文下载图片：这样会带上你登录后的 cookie，
 * 微博 / 知乎 这类有防盗链的图也能正常拿到。
 */
async function downloadImage(context, url, destDir, fileName, referer) {
  try {
    fs.mkdirSync(destDir, { recursive: true });
    const response = await context.request.get(url, {
      headers: referer ? { Referer: referer } : undefined,
      timeout: 30000
    });
    if (!response.ok()) {
      log(`  图片下载失败（HTTP ${response.status()}）：${url.slice(0, 80)}`);
      return null;
    }
    const buffer = await response.body();
    if (!buffer || buffer.length === 0) return null;
    const ext = guessExt(url, path.extname(fileName) || '.jpg');
    const target = path.join(destDir, /\.\w+$/.test(fileName) ? fileName : fileName + ext);
    fs.writeFileSync(target, buffer);
    return path.basename(target);
  } catch (error) {
    log(`  图片下载异常：${url.slice(0, 80)} → ${error.message}`);
    return null;
  }
}

module.exports = { downloadImage };
