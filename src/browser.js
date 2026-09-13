'use strict';

const { chromium } = require('playwright-core');
const { log } = require('./util');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0';

/**
 * 启动一个持久化的浏览器配置目录：第一次运行会打开窗口，
 * 你在里面正常登录知乎 / 微博 / X，登录态会被记住，后续采集直接复用。
 */
async function launchContext(config) {
  const options = {
    headless: Boolean(config.headless),
    viewport: { width: 1366, height: 900 },
    locale: 'zh-CN',
    userAgent: UA,
    args: ['--disable-blink-features=AutomationControlled']
  };
  if (config.browserChannel) options.channel = config.browserChannel;
  log(`启动浏览器（配置文件：${config.userDataDir}）`);
  const context = await chromium.launchPersistentContext(config.userDataDir, options);
  context.setDefaultTimeout(30000);
  return context;
}

/** 长这样：第一次使用时让用户登录常用站点 */
async function loginMode(config) {
  const context = await launchContext({ ...config, headless: false });
  const page = context.pages()[0] || (await context.newPage());
  await page.goto('https://www.zhihu.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  log('请在打开的浏览器里登录：知乎、微博、X（登录完直接回到这里按回车）');
  log('（这个窗口不会自己关闭，登录完成后回来按 Ctrl+C 结束即可）');
  await new Promise(() => {});
}

module.exports = { launchContext, loginMode, UA };
