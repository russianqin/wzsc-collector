#!/usr/bin/env node
'use strict';

/**
 * 把收藏仓库里「已经下载到本地」的图片还原成原始外链。
 *
 * 背景：早期版本会把图片下载到 assets/<编号>/ 目录里。现在改成只保留外链，
 * 于是需要把老的本地图片清掉。做法**不是猜顺序**，而是：
 *   1. 找出 md 里引用的 assets/<编号>/xxx 图片；
 *   2. 用文章自己的原始链接重新打开页面，把页面上所有候选图片都抓下来；
 *   3. 逐张下载候选图片，用内容指纹（sha256）和本地文件比对；
 *   4. 全部对得上 → 把 md 里的本地路径换回外链，并删掉对应的 assets/<编号> 目录；
 *   5. 只要有一张对不上 → 那个文件原样不动，并在报告里说明。
 *
 * 默认只检查不修改；加 --apply 才真正改文件、删目录。
 * 用法：node src/restore-images.js [--apply] [--headless] [--file 文件名.md]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { loadConfig } = require('./config');
const { launchContext } = require('./browser');
const { pickSite } = require('./sites');
const { htmlToMarkdown } = require('./markdown');
const { log } = require('./util');

const REF_RE = /assets\/([^/\s)"'<>\\]+)\/([^/\s)"'<>\\]+)/g;
const MD_IMG_RE = /!\[[^\]]*\]\((\S+?)(?:\s+"[^"]*")?\)/g;
const MAX_CANDIDATES = 800;

function parseArgs(argv) {
  const args = { apply: false, headless: null, file: null, config: null, dump: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--headless') args.headless = true;
    else if (arg === '--dump') args.dump = true;
    else if (arg === '--file') args.file = argv[++i];
    else if (arg === '--config') args.config = argv[++i];
  }
  return args;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function readText(file) {
  const raw = fs.readFileSync(file);
  const hasBom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  return { text: raw.toString('utf8').replace(/^\uFEFF/, ''), hasBom };
}

function writeText(file, text, hasBom) {
  fs.writeFileSync(file, (hasBom ? '\uFEFF' : '') + text, 'utf8');
}

/** 扫仓库里所有 md，返回引用了 assets/ 的文件 */
function scanRepo(repo, onlyFile) {
  const entries = [];
  for (const name of fs.readdirSync(repo)) {
    if (!name.toLowerCase().endsWith('.md')) continue;
    if (onlyFile && !name.includes(onlyFile)) continue;
    const full = path.join(repo, name);
    if (!fs.statSync(full).isFile()) continue;
    const { text, hasBom } = readText(full);
    const refs = [];
    REF_RE.lastIndex = 0;
    let match;
    while ((match = REF_RE.exec(text)) !== null) {
      refs.push({ raw: match[0], dir: match[1], file: match[2] });
    }
    if (refs.length) entries.push({ name, full, text, hasBom, refs });
  }
  return entries;
}

function listAssetDirs(repo, assetsDirName) {
  const base = path.join(repo, assetsDirName);
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base)
    .filter((name) => {
      try {
        return fs.statSync(path.join(base, name)).isDirectory();
      } catch {
        return false;
      }
    });
}

function sourceUrlOf(text) {
  const head = text.match(/^##\s*\[[^\]]*\]\((\S+?)\)/m);
  if (head) return head[1];
  const anyUrl = text.match(/https?:\/\/[^\s)]+/);
  return anyUrl ? anyUrl[0] : '';
}

/** markdown 里按出现顺序收集图片外链 */
function markdownImageUrls(markdown, into) {
  MD_IMG_RE.lastIndex = 0;
  let match;
  while ((match = MD_IMG_RE.exec(markdown)) !== null) {
    if (/^https?:/i.test(match[1])) into.add(match[1]);
  }
}

/** 从一整页 HTML 里粗扫所有像图片的地址（兜底用） */
function htmlImageUrls(html, into) {
  const cleaned = String(html || '')
    .replace(/\\u0026/g, '&')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&');
  const re = /https?:\/\/[^\s"'\\<>()]+/g;
  let match;
  while ((match = re.exec(cleaned)) !== null) {
    const url = match[0].replace(/[),.;]+$/, '');
    if (
      /\.(jpe?g|png|gif|webp|bmp)(\?|$)/i.test(url) ||
      /pbs\.twimg\.com\//i.test(url) ||
      /zhimg\.com\/v2-/i.test(url) ||
      /(qpic|qlogo|sinaimg)\.cn/i.test(url)
    ) {
      into.add(url);
    }
  }
}

/** twitter 的图片地址换个尺寸参数就换了内容，这里把常见尺寸都试一遍 */
function expandVariants(entry, into) {
  const media = entry.match(/^https:\/\/pbs\.twimg\.com\/media\/([A-Za-z0-9_-]+)/i);
  if (media) {
    const base = 'https://pbs.twimg.com/media/' + media[1];
    const names = ['small', 'medium', 'large', 'orig', '4096x4096', '2048x2048', '900x900', '360x360'];
    for (const format of ['jpg', 'png']) {
      for (const name of names) {
        into.add(`${base}?format=${format}&name=${name}`);
      }
    }
  }

  // 头像：尺寸后缀写在文件名里（xxx_normal.jpg），大小不同内容就不同
  const profile = entry.match(
    /^(https:\/\/pbs\.twimg\.com\/profile_images\/\d+\/[A-Za-z0-9_-]+?)(?:_(?:x96|normal|bigger|mini|200x200|400x400|reasonably_small))?(?:\.(?:jpg|jpeg|png|webp))?$/i
  );
  if (profile) {
    for (const suffix of ['_x96', '_normal', '_bigger', '_mini', '_200x200', '_400x400', '_reasonably_small', '']) {
      for (const format of ['jpg', 'png']) {
        into.add(`${profile[1]}${suffix}.${format}`);
      }
    }
  }
}

async function fetchDigest(context, url, referer) {
  try {
    const response = await context.request.get(url, {
      headers: referer ? { Referer: referer } : undefined,
      timeout: 30000
    });
    if (!response.ok()) return null;
    const buffer = await response.body();
    if (!buffer || !buffer.length) return null;
    return { sha: sha256(buffer), size: buffer.length };
  } catch {
    return null;
  }
}

/** 并发下载候选图片，建立「内容指纹 → 原始地址」的对照表 */
async function buildDigestMap(context, urls, referer) {
  const map = new Map();
  const list = urls.slice(0, MAX_CANDIDATES);
  let done = 0;
  const workers = new Array(3).fill(null).map(async () => {
    while (list.length) {
      const url = list.shift();
      const digest = await fetchDigest(context, url, referer);
      done += 1;
      if (digest && !map.has(digest.sha)) map.set(digest.sha, url);
      if (done % 20 === 0) log(`    已比对候选图片 ${done}/${urls.length} …`);
    }
  });
  await Promise.all(workers);
  return map;
}

/**
 * 在页面里装一个"图片记录器"：
 * 有些站点（X）滚动时会把离开屏幕的内容从 DOM 里卸载，
 * 所以不能只数当前页面上的图片，得把「出现过的」全都记下来。
 */
async function installImageSpy(page) {
  await page
    .evaluate(() => {
      const seen = new Set();
      window.__wzscSeen = seen;
      const add = (node) => {
        const src = node.currentSrc || node.src || node.getAttribute('data-src') || '';
        if (src) seen.add(src);
      };
      document.querySelectorAll('img').forEach(add);
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (!node || node.nodeType !== 1) continue;
            if (node.tagName === 'IMG') add(node);
            if (node.querySelectorAll) node.querySelectorAll('img').forEach(add);
          }
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    })
    .catch(() => {});
}

async function seenImageCount(page) {
  return page.evaluate(() => (window.__wzscSeen ? window.__wzscSeen.size : 0)).catch(() => 0);
}

async function clickShowMoreReplies(page) {
  await page
    .evaluate(() => {
      const pattern = /^(Show more replies|Show replies|Show additional replies|显示更多回复|查看更多回复|展开更多回复|更多回复)$/;
      const nodes = Array.from(document.querySelectorAll('div[role="button"], button, span, a'));
      for (const node of nodes) {
        if (pattern.test((node.innerText || '').trim()) && node.click) node.click();
      }
    })
    .catch(() => {});
}

/**
 * 把评论/回复尽量全都翻出来。
 * 注意：一定要**一屏一屏往下滚**，直接跳到页面底部的话，
 * X（还有其他用"滚动才加载"的站点）不会把回复渲染出来。
 */
/** X 专用：等页面渲染 → 一屏一屏往下滚 → 到底 → 再滚一轮，直到没有新图片 */
async function xLoadReplies(page, rounds = 4) {
  await page.waitForTimeout(6000);
  let last = await seenImageCount(page);
  for (let round = 0; round < rounds; round += 1) {
    for (let step = 0; step < 8; step += 1) {
      await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.9))).catch(() => {});
      await page.waitForTimeout(1200);
    }
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(3000);
    await clickShowMoreReplies(page);
    await page.waitForTimeout(1000);
    const seen = await seenImageCount(page);
    log(`    X 回复加载第 ${round + 1} 轮：已记录图片 ${seen} 张`);
    if (seen === last) break;
    last = seen;
  }
}

async function deepLoadReplies(page, rounds = 30) {
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(600);
  let stable = 0;
  let last = await seenImageCount(page);
  for (let round = 0; round < rounds; round += 1) {
    for (let step = 0; step < 6; step += 1) {
      await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.9))).catch(() => {});
      await page.waitForTimeout(900);
    }
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(2000);
    await clickShowMoreReplies(page);
    await page.waitForTimeout(1200);
    const seen = await seenImageCount(page);
    if (seen > last) {
      log(`    第 ${round + 1} 轮：已记录图片 ${seen} 张`);
      last = seen;
      stable = 0;
    } else {
      stable += 1;
      if (stable >= 3) break;
    }
  }
}

/** 递归找出 JSON 里所有图片地址（知乎评论接口用） */
function collectFromJson(value, into, depth = 0) {
  if (depth > 12 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (/^https?:\/\/[a-z0-9.-]*(zhimg|sinaimg|qpic|qlogo|twimg)\.(com|cn)\//i.test(value)) into.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFromJson(item, into, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const key of Object.keys(value)) collectFromJson(value[key], into, depth + 1);
  }
}

/** 知乎：直接调评论接口，把所有评论者的头像都取回来（比翻页面更全） */
async function zhihuCommentApiUrls(page, into) {
  const answerId = (page.url().match(/answer\/(\d+)/) || [])[1];
  if (!answerId) return;
  for (const order of ['score', 'ts']) {
    for (let offset = 0; offset < 80; offset += 20) {
      const text = await page
        .evaluate(
          async (params) => {
            try {
              const response = await fetch(
                `https://www.zhihu.com/api/v4/comment_v5/answers/${params.id}/root_comment?order_by=${params.order}&limit=20&offset=${params.offset}`,
                { credentials: 'include' }
              );
              return await response.text();
            } catch {
              return '';
            }
          },
          { id: answerId, order, offset }
        )
        .catch(() => '');
      if (!text) break;
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        break;
      }
      collectFromJson(parsed, into);
      const size = parsed && parsed.data && parsed.data.length ? parsed.data.length : 0;
      if (size < 20) break;
      await page.waitForTimeout(500);
    }
  }
}

/** 打开原文，收集所有候选图片地址 */
async function collectCandidates(context, config, url, dumpDir) {
  const site = pickSite(url);
  const page = await context.newPage();
  try {
    if (site.userAgent) {
      const session = await context.newCDPSession(page);
      await session.send('Network.setUserAgentOverride', { userAgent: site.userAgent });
    }
    // X 直接开 /用户名/status/编号 有时会被跳到首页，改成标准写法最稳
    let target = url;
    if (site.id === 'x') {
      const postId = (url.match(/status\/(\d+)/) || [])[1];
      if (postId) target = `https://x.com/i/web/status/${postId}`;
    }
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(site.id === 'x' ? 5000 : 1500);
    log(`    打开后地址：${page.url()}`);

    // X 有时会把文章链接跳到首页（登录状态下尤其容易），换成标准写法再打开一次
    if (site.id === 'x' && !/\/status\/\d+/.test(page.url())) {
      const postId = (url.match(/status\/(\d+)/) || [])[1];
      if (postId) {
        const fallback = `https://x.com/i/web/status/${postId}`;
        log(`    页面被跳转到 ${page.url()}，改用 ${fallback} 重开`);
        await page.goto(fallback, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(4000);
      }
    }
    await installImageSpy(page);
    const candidates = [];
    const ordered = new Set();
    let entry = null;
    let contentHtml = '';

    if (site.id === 'x') {
      // X 的正文和回复都是「滚到哪儿渲染到哪儿」，只能按人的节奏一屏一屏往下滚
      await xLoadReplies(page);
      contentHtml = await page.content();
    } else {
      await site.prepare(page, config);
      entry = await page.evaluate(site.extract);
      if (entry && entry.contentHtml) {
        markdownImageUrls(htmlToMarkdown(entry.contentHtml), ordered);
      }
      contentHtml = await page.content();

      if (site.id === 'zhihu') await zhihuCommentApiUrls(page, ordered);
      if (site.prepareComments) await site.prepareComments(page, config);
      await deepLoadReplies(page);
      const comments = site.extractComments ? (await page.evaluate(site.extractComments, {})) || [] : [];
      for (const comment of comments) {
        if (comment.avatar && /^https?:/i.test(comment.avatar)) ordered.add(comment.avatar);
        for (const reply of comment.replies || []) {
          if (reply.avatar && /^https?:/i.test(reply.avatar)) ordered.add(reply.avatar);
        }
      }
    }
    for (const video of (entry && entry.videos) || []) {
      if (video.poster && /^https?:/i.test(video.poster)) ordered.add(video.poster);
    }

    const extra = new Set();
    htmlImageUrls(contentHtml, extra);
    htmlImageUrls(await page.content(), extra);
    const seen = await page.evaluate(() => Array.from(window.__wzscSeen || [])).catch(() => []);
    for (const item of seen) if (item && !item.startsWith('data:')) extra.add(item);
    const orderedList = [...ordered];
    for (const item of extra) if (!ordered.has(item)) orderedList.push(item);

    log(`    页面上找到候选图片 ${orderedList.length} 张（正文/评论 ${ordered.size} 张）`);

    if (dumpDir) {
      try {
        fs.mkdirSync(dumpDir, { recursive: true });
        fs.writeFileSync(path.join(dumpDir, `${site.id}-page.html`), await page.content(), 'utf8');
        const info = await page.evaluate(() => ({
          title: document.title,
          url: location.href,
          images: document.querySelectorAll('img').length,
          cells: document.querySelectorAll('article, [data-testid="cellInnerDiv"]').length,
          text: (document.body ? document.body.innerText : '').slice(0, 3000)
        }));
        fs.writeFileSync(path.join(dumpDir, `${site.id}-info.json`), JSON.stringify(info, null, 2), 'utf8');
        log(`    （已保存页面快照：debug/${site.id}-page.html）`);
      } catch (error) {
        log('    （存快照失败：' + error.message + '）');
      }
    }

    candidates.push(...orderedList);
    return { candidates, site };
  } finally {
    await page.close().catch(() => {});
  }
}

function safeRemoveDir(repo, assetsDirName, dirName) {
  const base = path.resolve(repo, assetsDirName);
  const target = path.resolve(base, dirName);
  if (path.dirname(target) !== base || !fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    throw new Error('拒绝删除，路径不对：' + target);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

/**
 * 有些站点的评论列表每次只随机给出其中一部分。
 * 所以把每次「图片内容 → 原始地址」的结果存下来，下次接着用，多跑几次就补齐了。
 */
function loadCache(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const map = new Map();
    for (const key of Object.keys(data)) map.set(key, data[key]);
    return map;
  } catch {
    return new Map();
  }
}

function saveCache(file, map) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const data = {};
    for (const [key, value] of map) data[key] = value;
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch {
    /* 缓存写不出来不影响主流程 */
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args.config);
  if (args.headless !== null) config.headless = args.headless;

  const repo = config.repoPath;
  const assetsDirName = config.assetsDirName;
  if (!fs.existsSync(repo)) throw new Error('仓库路径不存在：' + repo);

  log(`收藏仓库：${repo}`);
  log(args.apply ? '模式：正式清理（会改 md、删目录）' : '模式：只检查（不会改任何东西）');

  const entries = scanRepo(repo, args.file);
  const dirsOnDisk = listAssetDirs(repo, assetsDirName);

  if (entries.length === 0) {
    log('没有发现引用本地图片的 md。');
  }

  const context = entries.length ? await launchContext(config) : null;
  const report = { time: new Date().toISOString(), applied: args.apply, files: [], deletedDirs: [] };
  const restoredDirs = new Set();
  const cacheFile = path.join(path.dirname(config.configFile), 'debug', 'restore-image-cache.json');
  const imageCache = loadCache(cacheFile);
  log(`（已累积的图片对照：${imageCache.size} 张）`);

  try {
    for (const entry of entries) {
      const url = sourceUrlOf(entry.text);
      log('');
      log(`【${entry.name}】引用本地图片 ${entry.refs.length} 处`);
      if (!url) {
        log('  ✗ 找不到原文链接，跳过（这个文件保持原样）');
        report.files.push({ file: entry.name, ok: false, reason: '找不到原文链接' });
        continue;
      }
      log(`  原文：${url}`);

      let mapping = new Map();
      try {
        const dumpDir = args.dump ? path.join(path.dirname(config.configFile), 'debug') : null;
        const { candidates } = await collectCandidates(context, config, url, dumpDir);
        const known = new Set(imageCache.values());
        const fresh = candidates.filter((item) => !known.has(item));
        log(`    开始下载比对（本次新图 ${fresh.length} 张，最多 ${MAX_CANDIDATES} 张）…`);
        const digestMap = new Map(imageCache);
        const newOnes = await buildDigestMap(context, fresh, pickSite(url).referer);
        for (const [key, value] of newOnes) if (!digestMap.has(key)) digestMap.set(key, value);
        for (const [key, value] of newOnes) if (!imageCache.has(key)) imageCache.set(key, value);
        saveCache(cacheFile, imageCache);
        log(`    有效图片 ${digestMap.size} 张`);

        const missing = [];
        for (const ref of entry.refs) {
          if (mapping.has(ref.raw)) continue;
          const localFile = path.join(repo, ref.raw);
          if (!fs.existsSync(localFile)) {
            missing.push({ ref: ref.raw, reason: '本地文件不存在' });
            continue;
          }
          const sha = sha256(fs.readFileSync(localFile));
          const hit = digestMap.get(sha);
          if (hit) mapping.set(ref.raw, hit);
          else missing.push({ ref: ref.raw, reason: '页面上没找到同内容的图片' });
        }

        // 还有对不上的：有些站点的图片换个尺寸参数就是另一份文件，这里把常见尺寸再试一遍
        if (missing.length > 0) {
          const variants = new Set();
          for (const candidate of candidates) expandVariants(candidate, variants);
          for (const item of candidates) variants.delete(item);
          if (variants.size > 0) {
            log(`    再用 ${variants.size} 个尺寸变体重试对不上的 ${missing.length} 张…`);
            const variantMap = await buildDigestMap(context, [...variants], pickSite(url).referer);
            for (const [key, value] of variantMap) {
              if (!digestMap.has(key)) digestMap.set(key, value);
              if (!imageCache.has(key)) imageCache.set(key, value);
            }
            saveCache(cacheFile, imageCache);
            const stillMissing = [];
            for (const item of missing) {
              const localFile = path.join(repo, item.ref);
              const sha = fs.existsSync(localFile) ? sha256(fs.readFileSync(localFile)) : '';
              const hit = sha ? variantMap.get(sha) : null;
              if (hit) mapping.set(item.ref, hit);
              else stillMissing.push(item);
            }
            missing.length = 0;
            missing.push(...stillMissing);
          }
        }

        for (const ref of entry.refs) {
          const target = mapping.get(ref.raw);
          log(`    ${target ? '✓' : '✗'} ${ref.raw}${target ? '  →  ' + target.slice(0, 110) : ''}`);
        }

        if (missing.length === 0) {
          if (args.apply) {
            let text = entry.text;
            for (const [ref, target] of mapping) text = text.split(ref).join(target);
            writeText(entry.full, text, entry.hasBom);
            for (const ref of entry.refs) restoredDirs.add(ref.dir);
            log(`  ✓ 已还原并写回：${entry.name}`);
          } else {
            log('  ✓ 全部对得上，正式清理时会还原并写回');
          }
          report.files.push({ file: entry.name, ok: true, restored: mapping.size });
        } else {
          log(`  ✗ 有 ${missing.length} 张对不上，这个文件保持原样（不删它的图片目录）`);
          report.files.push({ file: entry.name, ok: false, missing });
        }
      } catch (error) {
        log('  ✗ 处理失败：' + error.message);
        report.files.push({ file: entry.name, ok: false, reason: error.message });
      }
    }
  } finally {
    if (context) await context.close().catch(() => {});
  }

  // 清理：所有「兜底后仍没人引用」的图片目录
  const stillReferenced = new Set();
  for (const name of fs.readdirSync(repo)) {
    if (!name.toLowerCase().endsWith('.md')) continue;
    const { text } = readText(path.join(repo, name));
    REF_RE.lastIndex = 0;
    let match;
    while ((match = REF_RE.exec(text)) !== null) stillReferenced.add(match[1]);
  }

  const toDelete = dirsOnDisk.filter((dir) => !stillReferenced.has(dir));
  log('');
  log('—— 图片目录 ——');
  for (const dir of dirsOnDisk) {
    log(`  ${stillReferenced.has(dir) ? '保留' : '删除'}  ${assetsDirName}/${dir}`);
  }
  if (args.apply) {
    for (const dir of toDelete) {
      try {
        safeRemoveDir(repo, assetsDirName, dir);
        report.deletedDirs.push(dir);
      } catch (error) {
        log('  删除失败：' + error.message);
      }
    }
    log(`已删除 ${report.deletedDirs.length} 个目录。`);
  } else {
    log(`（正式清理时会删除上面标记为「删除」的 ${toDelete.length} 个目录）`);
  }

  const reportDir = path.join(path.dirname(config.configFile), 'debug');
  try {
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(reportDir, 'restore-images-report.json'), JSON.stringify(report, null, 2), 'utf8');
  } catch {
    /* 报告写不出来不影响主流程 */
  }

  log('');
  log(args.apply ? '清理完成 ✔' : '检查完成 ✔（什么都没改）');
}

main().catch((error) => {
  console.error('运行失败：', error.message);
  process.exit(1);
});
