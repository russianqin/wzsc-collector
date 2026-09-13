#!/usr/bin/env node
'use strict';

/**
 * 本机服务：接收浏览器扩展发来的文章数据，下载图片、写出 Markdown。
 * 用法：node src/server.js   （或双击项目里的「启动收藏服务.cmd」）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { loadConfig } = require('./config');
const { filterComments } = require('./sites');
const {
  htmlToMarkdown,
  rewriteImages,
  buildCommentsBlock,
  buildVideoBlock,
  assembleDocument,
  stripLeadingJunk
} = require('./markdown');
const { log, sanitizeFilename, nextSerial, guessExt } = require('./util');

const BASE_PORT = Number(process.env.WZSC_PORT || 8765);
const MAX_PORT_TRIES = 4;
// 服务版本：扩展会检查它，太旧的服务会被跳过（避免连到别的东西上）
const SERVICE_VERSION = '0.2.5';
const MAX_BODY = 30 * 1024 * 1024; // 30MB
const config = loadConfig();

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function refererFor(url) {
  if (url.includes('zhimg.com') || url.includes('zhihu.com')) return 'https://www.zhihu.com/';
  if (url.includes('qpic.cn') || url.includes('qlogo.cn')) return 'https://mp.weixin.qq.com/';
  if (url.includes('twimg.com')) return 'https://x.com/';
  if (url.includes('sinaimg.cn') || url.includes('weibo.com') || url.includes('sina.com.cn')) return 'https://weibo.com/';
  return undefined;
}

async function downloadImage(url, destDir, index) {
  try {
    fs.mkdirSync(destDir, { recursive: true });
    const referer = refererFor(url);
    const response = await fetch(url, {
      headers: Object.assign({ 'User-Agent': BROWSER_UA, Accept: 'image/*,*/*;q=0.8' }, referer ? { Referer: referer } : {})
    });
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) return null;
    const name = `img-${index}${guessExt(url)}`;
    fs.writeFileSync(path.join(destDir, name), buffer);
    return name;
  } catch (error) {
    log(`  图片下载失败：${url.slice(0, 70)} → ${error.message}`);
    return null;
  }
}

async function saveArticle(payload) {
  if (!fs.existsSync(config.repoPath)) {
    throw new Error('仓库路径不存在：' + config.repoPath + '（请检查 config.json）');
  }

  const serial = nextSerial(config.repoPath);
  const debugDir = path.join(path.dirname(config.configFile), 'debug');

  // 记录每次保存的关键信息（排查问题时用，不看窗口日志也能定位）
  try {
    fs.mkdirSync(debugDir, { recursive: true });
    fs.writeFileSync(
      path.join(debugDir, 'last-save.json'),
      JSON.stringify(
        {
          time: new Date().toISOString(),
          serviceVersion: SERVICE_VERSION,
          extensionVersion: payload.extensionVersion || 'unknown',
          site: payload.siteId || 'unknown',
          title: payload.title || '',
          url: payload.canonical || payload.pageUrl || '',
          contentHtmlChars: (payload.contentHtml || '').length,
          debugContentChars: (payload.debugContentHtml || '').length,
          comments: (payload.comments || []).length,
          hasDebugHtml: Boolean(payload.debugHtml)
        },
        null,
        2
      ),
      'utf8'
    );
  } catch (error) {
    log('写保存记录失败：' + error.message);
  }

  // 调试页面（扩展里勾选"同时保存调试页面"时会有）
  if (payload.debugHtml) {
    try {
      const debugFile = path.join(debugDir, `${payload.siteId || 'page'}-${Date.now()}.html`);
      fs.writeFileSync(debugFile, payload.debugHtml, 'utf8');
      log(`已保存调试页面：${debugFile}`);
      // 提取到的正文 HTML（最关键：用它来排查排版问题）
      if (payload.debugContentHtml) {
        const contentFile = path.join(debugDir, `${payload.siteId || 'page'}-content-${Date.now()}.html`);
        fs.writeFileSync(contentFile, payload.debugContentHtml, 'utf8');
        log(`已保存正文 HTML：${contentFile}`);
      }
    } catch (error) {
      log('保存调试页面失败：' + error.message);
    }
  }
  const assetDir = path.join(config.repoPath, config.assetsDirName, serial);
  const relAsset = `${config.assetsDirName}/${serial}`;
  const cache = new Map();
  let imageIndex = 0;

  const resolveImage = async (imageUrl) => {
    if (!imageUrl || !/^https?:/i.test(imageUrl)) return imageUrl;
    if (config.images !== 'download') return imageUrl;
    if (cache.has(imageUrl)) return cache.get(imageUrl);
    imageIndex += 1;
    const saved = await downloadImage(imageUrl, assetDir, imageIndex);
    const local = saved ? `${relAsset}/${saved}` : imageUrl;
    cache.set(imageUrl, local);
    return local;
  };

  let body = htmlToMarkdown(payload.contentHtml || '');
  body = stripLeadingJunk(body, payload.title);
  body = await rewriteImages(body, resolveImage);

  const comments = filterComments(payload.comments || [], config);
  for (const comment of comments) {
    if (comment.avatar) comment.avatar = await resolveImage(comment.avatar);
    for (const reply of comment.replies || []) {
      if (reply.avatar) reply.avatar = await resolveImage(reply.avatar);
    }
  }

  const videos = config.video === 'none' ? [] : payload.videos || [];
  for (const video of videos) {
    if (video.poster) video.poster = await resolveImage(video.poster);
  }

  const markdown = assembleDocument({
    title: payload.title || 'untitled',
    url: payload.canonical || payload.pageUrl || '',
    author: payload.author,
    date: payload.date,
    body,
    videoBlock: buildVideoBlock(videos),
    commentsBlock: buildCommentsBlock(comments)
  });

  const fileName = `${serial}.${sanitizeFilename(payload.title || 'untitled')}.md`;
  fs.writeFileSync(path.join(config.repoPath, fileName), markdown, 'utf8');
  log(`已保存 ${fileName}（${markdown.length} 字，图片 ${cache.size}，评论 ${comments.length}）`);

  return {
    ok: true,
    file: fileName,
    filePath: path.join(config.repoPath, fileName),
    chars: markdown.length,
    images: cache.size,
    comments: comments.length,
    repo: config.repoPath
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const handler = async (req, res) => {
  const send = (code, data) => {
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
    });
    res.end(JSON.stringify(data));
  };

  if (req.method === 'OPTIONS') return send(204, {});
  if (req.method === 'GET' && req.url.startsWith('/health')) {
    return send(200, { ok: true, repo: config.repoPath, version: SERVICE_VERSION });
  }
  if (req.method === 'POST' && req.url.startsWith('/save')) {
    try {
      const payload = JSON.parse(await readBody(req));
      const result = await saveArticle(payload);
      return send(200, result);
    } catch (error) {
      log('保存失败：' + error.message);
      return send(500, { ok: false, error: error.message });
    }
  }
  if (req.method === 'POST' && req.url.startsWith('/open-repo')) {
    try {
      spawn('explorer.exe', [config.repoPath], { detached: true, stdio: 'ignore' }).unref();
      return send(200, { ok: true, repo: config.repoPath });
    } catch (error) {
      return send(500, { ok: false, error: error.message });
    }
  }
  return send(404, { ok: false, error: 'not found' });
};

/** 端口被占用时自动往后试（8765 → 8766 → …），扩展那边会自动探测到 */
function listen(port, left) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE' && left > 0) {
        log(`端口 ${port} 被占用，改试 ${port + 1} …`);
        resolve(listen(port + 1, left - 1));
        return;
      }
      reject(error);
    });
    server.listen(port, '127.0.0.1', () => resolve({ server, port }));
  });
}

listen(BASE_PORT, MAX_PORT_TRIES)
  .then(({ server, port }) => {
    log(`收藏服务已启动：http://127.0.0.1:${port}`);
    log(`服务版本：${SERVICE_VERSION}`);
    log(`收藏仓库：${config.repoPath}`);
    log('保持这个窗口开着（关掉窗口 = 服务停止）。保存时看这里的日志。');
    // 自检模式：node src/server.js --check —— 只验证端口和配置，然后立刻退出
    if (process.argv.includes('--check')) {
      server.close(() => process.exit(0));
    }
  })
  .catch((error) => {
    log('服务启动失败：' + error.message);
    process.exit(1);
  });
