#!/usr/bin/env node
'use strict';

/**
 * X 抓取规则的浏览器自检（配合 tools/markdown-selftest.js 一起用）。
 *
 *   npm run test:browser
 *   node tools/browser-selftest.js
 *   node tools/browser-selftest.js --browser "C:\Program Files\...\msedge.exe"
 *   node tools/browser-selftest.js --prepare-dom <路径> --extractors <路径>
 *       换成别的版本跑（把旧提交里的文件导出来指过去，就能验证"这次到底修好了没有"：
 *       旧代码应该红。变量名 WZSC_TEST_PREPARE / WZSC_TEST_EXTRACTORS 同效）
 *   WZSC_TEST_BROWSER=<浏览器路径> node tools/browser-selftest.js
 *
 * 为什么需要它：extractors.js / prepare-dom.js 是跑在页面里的，只有真实 DOM 才验得了。
 * 这个脚本用无头 Edge / Chrome 打开 tools/fixtures/*.html——页面里摆的是 X 的真实结构
 * （pre-wrap 的文本换行、被折叠的长回复、焦点推文自己也是一篇 article），
 * 跑真实的提取脚本，再把结果交给 src/markdown.js 走完整条管线。
 *
 * 机器上没装 Edge / Chrome 时直接跳过（退出码 0），不会拖累别的机器。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const { htmlToMarkdown, stripLeadingJunk } = require(path.join(ROOT, 'src', 'markdown.js'));

const TITLE = '《对于绝大部分人来说，AI对生活复杂度管理的帮助，要比工作大得多》';
const URL_488 = 'https://x.com/naki2012/status/2061776400865243377';

const BROWSERS = {
  win32: [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge']
};

function findBrowser(explicit) {
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  const candidates = BROWSERS[process.platform] || [];
  return candidates.find((file) => fs.existsSync(file)) || null;
}

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function fileUrl(file) {
  return 'file:///' + path.resolve(file).replace(/\\/g, '/');
}

function runFixture(browser, profile, url, headlessFlag) {
  const args = [
    headlessFlag,
    '--no-sandbox',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--virtual-time-budget=20000',
    '--user-data-dir=' + profile,
    '--dump-dom',
    url
  ];
  const out = execFileSync(browser, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120000
  });
  const match = out.match(/<pre id="out">([\s\S]*?)<\/pre>/);
  if (!match) throw new Error('页面没有产出结果（<pre id="out"> 还是初始内容）');
  return JSON.parse(decodeEntities(match[1]));
}

function runPage(browser, profile, file) {
  const params = new URLSearchParams();
  if (overrides.prepareDom) params.set('prepare', fileUrl(overrides.prepareDom));
  if (overrides.extractors) params.set('extractors', fileUrl(overrides.extractors));
  const query = params.toString();
  const url = fileUrl(file) + (query ? '?' + query : '');
  try {
    return runFixture(browser, profile, url, '--headless=new');
  } catch (error) {
    // 老一点的 Chromium 不认 --headless=new，退回老写法再试一次
    return runFixture(browser, profile, url, '--headless');
  }
}

function argValue(flag, envName) {
  const index = process.argv.indexOf(flag);
  if (index >= 0) return process.argv[index + 1];
  return process.env[envName];
}

const overrides = {
  prepareDom: argValue('--prepare-dom', 'WZSC_TEST_PREPARE'),
  extractors: argValue('--extractors', 'WZSC_TEST_EXTRACTORS')
};

let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log('  ✔ ' + name);
    return;
  }
  failed += 1;
  console.log('  ✘ ' + name + (detail ? '\n      ' + detail : ''));
}

const CASES = [
  {
    fixture: 'x-post.html',
    name: 'X 普通帖：正文与分段',
    run(data) {
      check('标题取正文第一行', data.title === TITLE, '实际：' + JSON.stringify(data.title));
      check('canonical 用推文自己的链接', data.canonical === URL_488, '实际：' + JSON.stringify(data.canonical));
      check('文本里的换行变成了 <br>', String(data.contentHtml).includes('<br>'));

      const body = stripLeadingJunk(htmlToMarkdown(data.contentHtml || ''), data.title);
      check('标题行没有在正文里重复一遍', !body.startsWith(TITLE), JSON.stringify(body.slice(0, 60)));
      check('段与段之间有空行（没被压成一坨）', body.includes('锚点\n\n'), JSON.stringify(body.slice(0, 80)));
      check('加粗跨换行时逐段加粗', body.includes('**加粗的一段**\n\n**折行**'), JSON.stringify(body));
    }
  },
  {
    fixture: 'x-thread.html',
    name: 'X 会话：正文与长回复',
    run(data) {
      const comments = data.comments || [];
      const names = comments.map((comment) => comment.nick).join(' / ');
      check('焦点推文没有被当成留言', comments.length === 2, '收到 ' + comments.length + ' 条：' + names);
      check('正文没有在留言区再出现一遍', !comments.some((comment) => String(comment.text).includes('AI最大的价值')));
      check(
        '作者自己发的回复照旧保留',
        comments.some((comment) => comment.author && String(comment.text).includes('这条留言是作者自己发的'))
      );
      check(
        '被折叠的长回复读全了',
        comments.some((comment) => String(comment.text).includes('折叠起来的后半句')),
        comments.map((comment) => JSON.stringify(String(comment.text).slice(-20))).join(' / ')
      );
    }
  }
];

function main() {
  const browser = findBrowser(argValue('--browser', 'WZSC_TEST_BROWSER'));
  if (!browser) {
    console.log('没找到 Edge / Chrome，跳过浏览器自检（用 --browser 指定路径即可跑）。');
    return 0;
  }
  console.log('浏览器：' + browser + '\n');
  if (overrides.prepareDom || overrides.extractors) {
    console.log('被测脚本：' + (overrides.prepareDom || 'src/prepare-dom.js') + ' + ' + (overrides.extractors || 'src/extractors.js') + '\n');
  }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wzsc-selftest-'));
  try {
    CASES.forEach((item) => {
      console.log(item.name + '（' + item.fixture + '）');
      let data;
      try {
        data = runPage(browser, profile, path.join(FIXTURES, item.fixture));
      } catch (error) {
        check('页面能跑起来', false, error.message);
        console.log('');
        return;
      }
      if (data.error) {
        check('页面能跑起来', false, data.error);
        console.log('');
        return;
      }
      item.run(data);
      console.log('');
    });
  } finally {
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch (error) {
      /* 临时目录删不掉也无所谓 */
    }
  }

  console.log(passed + ' 项通过' + (failed ? '，' + failed + ' 项没通过' : ''));
  return failed === 0 ? 0 : 1;
}

process.exit(main());
