#!/usr/bin/env node
'use strict';

/**
 * 本机服务：接收浏览器扩展发来的文章，写成 Markdown 存进收藏仓库。
 *
 * 它平时跟着浏览器待命（点扩展秒开）：
 *   · 浏览器开着 → 开机启动的看门狗「启动收藏助手.vbs」保证本服务在后台跑着
 *   · 浏览器全关一会儿 → 本服务自己退出，机器上不留东西
 *   · 万一服务没在跑（比如刚开机、看门狗还没到位）→ 扩展会通过原生消息
 *     让小助手 bin\wzsc-host.exe 立刻把它拉起来，所以第一次点也不会卡住
 *
 * 手动检查：node src/server.js --check
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { loadConfig } = require('./config');
const { browserRunning } = require('./browser-check');
const { applyPastedComments } = require('./paste');
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
const SERVICE_VERSION = '0.3.0';
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

/** 只保留"精选"或"与作者有互动"的评论；都分不清时就退回前 N 条 */
function filterComments(comments, conf) {
  if (!comments || comments.length === 0) return [];
  if (conf.commentFilter === 'none') return [];
  if (conf.commentFilter === 'all') return comments.slice(0, conf.maxComments);
  const curated = comments.filter((comment) => comment.author || comment.likes);
  if (curated.length > 0) return curated.slice(0, conf.maxComments);
  return comments.slice(0, Math.min(10, conf.maxComments));
}

async function saveArticle(payload) {
  if (!fs.existsSync(config.repoPath)) {
    throw new Error('收藏仓库路径不存在：' + config.repoPath + '（请检查 config.json 里的 repoPath）');
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

  // 调试页面（在扩展里勾选"同时保存调试页面"时才会有）
  if (payload.debugHtml) {
    try {
      const debugFile = path.join(debugDir, `${payload.siteId || 'page'}-${Date.now()}.html`);
      fs.writeFileSync(debugFile, payload.debugHtml, 'utf8');
      log(`已保存调试页面：${debugFile}`);
      if (payload.debugContentHtml) {
        const contentFile = path.join(debugDir, `${payload.siteId || 'page'}-content-${Date.now()}.html`);
        fs.writeFileSync(contentFile, payload.debugContentHtml, 'utf8');
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
  if (req.method === 'POST' && req.url.startsWith('/paste-comments')) {
    try {
      const payload = JSON.parse(await readBody(req));
      const result = applyPastedComments(config.repoPath, payload.number, payload.text || '');
      log(`已补录留言：${result.file}（${result.count} 条${result.replaced ? '，替换原有留言' : ''}）`);
      return send(200, Object.assign({ ok: true }, result));
    } catch (error) {
      log('补录留言失败：' + error.message);
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
  // 让服务体面地退出（取消安装、或者想立刻腾出端口时用）
  if (req.method === 'POST' && req.url.startsWith('/shutdown')) {
    send(200, { ok: true, bye: true });
    setTimeout(() => process.exit(0), 200);
    return undefined;
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
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function checkAndReport() {
  log(`收藏仓库：${config.repoPath}`);
  log(`服务版本：${SERVICE_VERSION}`);
  log(`图片设置：${config.images}${config.images === 'keep-remote' ? '（只保留外链，不下载）' : '（下载到仓库）'}`);
  log(`浏览器在运行吗：${(await browserRunning()) ? '是' : '否'}`);
  const port = await findRunningService();
  log(`现在有服务在跑吗：${port ? '有（端口 ' + port + '）' : '没有'}`);
}

/** 看看这几个端口上是不是已经有"够新"的服务在跑 */
function findRunningService() {
  return new Promise((resolve) => {
    let left = 4;
    let found = null;
    for (let port = BASE_PORT; port < BASE_PORT + 4; port += 1) {
      const request = http.get({ host: '127.0.0.1', port: port, path: '/health', timeout: 500 }, (response) => {
        let body = '';
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (data && data.ok && String(data.version) >= SERVICE_VERSION) found = port;
          } catch (error) {
            /* 不是我们的服务 */
          }
          left -= 1;
          if (left === 0) resolve(found);
        });
      });
      request.on('timeout', () => request.destroy());
      request.on('error', () => {
        left -= 1;
        if (left === 0) resolve(found);
      });
    }
  });
}

// 浏览器全关之后，再等多久就下班（默认 3 分钟）
const BROWSER_GONE_EXIT_MS = Number(process.env.WZSC_BROWSER_IDLE_MS || 3 * 60 * 1000);

/** 跟着浏览器走：一起来就监听；浏览器全关一会儿就下班 */
async function main() {
  if (process.argv.includes('--check')) {
    await checkAndReport();
    return;
  }

  log(`收藏服务启动：${config.repoPath}`);
  log(`服务版本：${SERVICE_VERSION}（跟着浏览器，浏览器全关 ${Math.round(BROWSER_GONE_EXIT_MS / 60000)} 分钟后退出）`);

  // 已经有一个够新的服务在跑就不用再起（避免看门狗和扩展同时唤醒时起两个）
  const already = await findRunningService();
  if (already) {
    log(`已经有服务在跑（端口 ${already}），这个实例退出。`);
    return;
  }

  try {
    await listen(BASE_PORT, MAX_PORT_TRIES);
  } catch (error) {
    log('启动失败（端口都被占了？）：' + error.message);
    process.exit(1);
  }

  let lastBrowserSeen = Date.now();
  const tickMs = Math.max(1000, Math.min(10000, Math.round(BROWSER_GONE_EXIT_MS / 4)));
  const watchTimer = setInterval(async () => {
    if (await browserRunning()) {
      lastBrowserSeen = Date.now();
      return;
    }
    if (Date.now() - lastBrowserSeen > BROWSER_GONE_EXIT_MS) {
      log('浏览器已经关了一会儿，服务先下班（下次开浏览器会自动再起来）。');
      process.exit(0);
    }
  }, tickMs);
  watchTimer.unref();
}

main().catch((error) => {
  console.error('运行失败：', error.message);
  process.exit(1);
});
