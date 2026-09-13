#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { loadConfig } = require('./config');
const { launchContext, loginMode } = require('./browser');
const { pickSite, filterComments } = require('./sites');
const { downloadImage } = require('./media');
const { htmlToMarkdown, rewriteImages, buildCommentsBlock, buildVideoBlock, assembleDocument } = require('./markdown');
const { log, randomDelay, sanitizeFilename, nextSerial, guessExt } = require('./util');

function parseArgs(argv) {
  const args = { urls: [], file: null, config: null, login: false, dryRun: false, headless: null, debug: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--login') args.login = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--headless') args.headless = true;
    else if (arg === '--debug') args.debug = true;
    else if (arg === '--config') args.config = argv[++i];
    else if (arg === '--file') args.file = argv[++i];
    else if (/^https?:\/\//i.test(arg)) args.urls.push(arg);
    else log(`忽略无法识别的参数：${arg}`);
  }
  return args;
}

function readUrlFile(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\//i.test(line));
}

// 首页 / 推荐流 / 搜索页这类"列表页"：不是某一篇文章，直接拒绝
const LISTING_PATTERNS = [
  /^https?:\/\/(www\.)?(x|twitter)\.com\/(home|explore|notifications|messages|search|i\/flow)/i,
  /^https?:\/\/(www\.)?(x|twitter)\.com\/?$/i,
  /^https?:\/\/(www\.)?zhihu\.com\/(explore|follow|search|hot)/i,
  /^https?:\/\/(www\.)?weibo\.com\/?$/i
];

/** --debug：把页面 HTML 存到 debug/ 目录，方便排查抓取规则 */
async function dumpDebug(page, config, site) {
  try {
    const dir = path.join(path.dirname(config.configFile), 'debug');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `${site.id}-page.html`);
    fs.writeFileSync(target, await page.content(), 'utf8');
    log(`  （已保存调试页面：${target}）`);
  } catch (error) {
    log('  （保存调试页面失败：' + error.message + '）');
  }
}

/** 采集单篇：返回 { fileName, markdown, stats } 或 null */
async function collectOne(context, config, url, serial) {
  const site = pickSite(url);

  if (LISTING_PATTERNS.some((pattern) => pattern.test(url))) {
    log(`  ✗ 这是列表页（首页/推荐/搜索），不是具体某篇文章：${url}`);
    log('    请打开你要保存的那篇文章，从地址栏复制它的链接再试。');
    return null;
  }

  const page = await context.newPage();
  try {
    // 某些站点需要特定身份（例如微信内置浏览器的 UA），这里按站点覆盖
    if (site.userAgent) {
      const session = await context.newCDPSession(page);
      await session.send('Network.setUserAgentOverride', { userAgent: site.userAgent });
    }
    log(`打开【${site.label}】${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500);

    // 防呆：页面如果跳转到了别的地址（例如没登录、链接失效），明确报错而不是采集无关内容
    const wanted = url.replace(/[?#].*$/, '');
    const loaded = page.url().replace(/[?#].*$/, '');
    if (loaded !== wanted && !loaded.startsWith(wanted)) {
      log(`  ⚠ 页面跳转到了：${loaded}`);
      if (/\/status\/\d+/.test(wanted) && !/\/status\/\d+/.test(loaded)) {
        log('  ✗ 打开的不是那条推文，已跳过（请确认链接，或先登录 X）');
        if (config.debug) await dumpDebug(page, config, site);
        return null;
      }
    }

    await site.prepare(page, config);

    const entry = await page.evaluate(site.extract);
    if (entry && entry.error) {
      log('  ✗ ' + entry.error);
      if (config.debug) await dumpDebug(page, config, site);
      return null;
    }
    if (!entry || !entry.contentHtml) {
      log('  ✗ 没能识别出正文，跳过');
      if (config.debug) await dumpDebug(page, config, site);
      return null;
    }

    if (config.includeComments && (site.fetchComments || site.extractComments)) {
      if (site.prepareComments) await site.prepareComments(page, config);
      const raw = site.fetchComments
        ? await site.fetchComments(page, context, config)
        : await page.evaluate(site.extractComments, { author: entry.author, url: entry.canonical });
      // 公众号列表本身就是作者精选的，不再按"作者互动"过滤
      entry.comments = site.id === 'weixin' ? raw.slice(0, config.maxComments) : filterComments(raw, config);
      log(`  评论：抓到 ${raw.length} 条，按「${config.commentFilter}」保留 ${entry.comments.length} 条`);
    }
    if (entry.commentsNote) log(`  提示：${entry.commentsNote}`);
    if (config.debug) await dumpDebug(page, config, site);

    const assetDir = path.join(config.repoPath, config.assetsDirName, serial);
    const relAsset = `${config.assetsDirName}/${serial}`;
    const imageCache = new Map();
    let imageIndex = 0;

    const resolveImage = async (imageUrl) => {
      if (config.images !== 'download') return imageUrl;
      if (imageCache.has(imageUrl)) return imageCache.get(imageUrl);
      imageIndex += 1;
      const name = `img-${imageIndex}${guessExt(imageUrl)}`;
      const saved = await downloadImage(context, imageUrl, assetDir, name, site.referer);
      const local = saved ? `${relAsset}/${saved}` : imageUrl;
      imageCache.set(imageUrl, local);
      return local;
    };

    let body = htmlToMarkdown(entry.contentHtml);
    body = await rewriteImages(body, resolveImage);

    // 评论头像同样下载到本地
    for (const comment of entry.comments || []) {
      if (comment.avatar) comment.avatar = await resolveImage(comment.avatar);
      for (const reply of comment.replies || []) {
        if (reply.avatar) reply.avatar = await resolveImage(reply.avatar);
      }
    }

    // 视频：只留封面图 + 地址
    const videos = config.video === 'none' ? [] : entry.videos || [];
    for (const video of videos) {
      if (video.poster) video.poster = await resolveImage(video.poster);
    }

    const title = sanitizeFilename(entry.title || 'untitled');
    const markdown = assembleDocument({
      title: entry.title || title,
      url: entry.canonical || url,
      author: entry.author,
      date: entry.date,
      body,
      videoBlock: buildVideoBlock(videos),
      commentsBlock: buildCommentsBlock(entry.comments)
    });

    return {
      fileName: `${serial}.${title}.md`,
      markdown,
      stats: {
        images: imageCache.size,
        comments: (entry.comments || []).length,
        chars: markdown.length,
        site: site.label
      }
    };
  } catch (error) {
    log(`  ✗ 采集失败：${error.message}`);
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args.config);
  if (args.headless !== null) config.headless = args.headless;
  config.debug = args.debug;

  if (args.login) {
    await loginMode(config);
    return;
  }

  let urls = [...args.urls];
  if (args.file) urls = urls.concat(readUrlFile(args.file));
  urls = [...new Set(urls)];

  if (urls.length === 0) {
    log('用法：');
    log('  node src/cli.js <文章链接> [更多链接...]');
    log('  node src/cli.js --file urls.txt        # 一行一个链接');
    log('  node src/cli.js --login                # 首次使用：登录知乎/微博/X');
    log('  可选：--dry-run 只看结果不写文件，--headless 后台运行，--config <文件>');
    return;
  }

  if (!fs.existsSync(config.repoPath)) {
    throw new Error('仓库路径不存在：' + config.repoPath + '（请检查 config.json 里的 repoPath）');
  }

  const context = await launchContext(config);
  try {
    for (let i = 0; i < urls.length; i += 1) {
      const serial = nextSerial(config.repoPath);
      const result = await collectOne(context, config, urls[i], serial);
      if (!result) continue;

      if (args.dryRun) {
        log(`  ✓ [dry-run] ${result.fileName}｜${result.stats.chars} 字｜图片 ${result.stats.images}｜评论 ${result.stats.comments}`);
        continue;
      }
      const target = path.join(config.repoPath, result.fileName);
      fs.writeFileSync(target, result.markdown, 'utf8');
      log(`  ✓ 已写入 ${result.fileName}｜${result.stats.chars} 字｜图片 ${result.stats.images}｜评论 ${result.stats.comments}`);

      if (i < urls.length - 1) await randomDelay(config.delaySeconds);
    }
  } finally {
    await context.close().catch(() => {});
  }
  log('全部完成。请检查文件内容后自行提交（本工具不会自动 git commit）。');
}

main().catch((error) => {
  console.error('运行失败：', error.message);
  process.exit(1);
});
