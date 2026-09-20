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
 *       旧代码应该红。环境变量 WZSC_TEST_PREPARE / WZSC_TEST_EXTRACTORS 同效）
 *   WZSC_TEST_BROWSER=<浏览器路径> node tools/browser-selftest.js
 *
 * 为什么需要它：extractors.js / prepare-dom.js 是跑在页面里的，只有真实 DOM 才验得了。
 * 这个脚本拉起一个独立的无头 Edge / Chrome（临时 profile，不碰你正在用的浏览器），
 * 打开 tools/fixtures/*.html——页面里摆的是 X 的真实结构（pre-wrap 的文本换行、
 * 被折叠的长回复、焦点推文自己也是一篇 article）——跑真实的提取脚本，
 * 再把结果交给 src/markdown.js 走完整条管线。
 *
 * 注：早先版本靠 `--dump-dom` 取页面结果，新版 Edge 上它已经不再输出内容，
 * 所以这里改成连浏览器的调试端口（CDP）读结果。
 *
 * 机器上没装 Edge / Chrome 时直接跳过（退出码 0），不会拖累别的机器。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findBrowser(explicit) {
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  const candidates = BROWSERS[process.platform] || [];
  return candidates.find((file) => fs.existsSync(file)) || null;
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

function fixtureUrl(fixture) {
  const params = new URLSearchParams();
  if (overrides.prepareDom) params.set('prepare', fileUrl(overrides.prepareDom));
  if (overrides.extractors) params.set('extractors', fileUrl(overrides.extractors));
  const query = params.toString();
  return fileUrl(path.join(FIXTURES, fixture)) + (query ? '?' + query : '');
}

/** 等浏览器把调试端口写进 DevToolsActivePort */
async function waitForPort(profile, timeoutMs) {
  const portFile = path.join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(200);
    if (fs.existsSync(portFile)) {
      const port = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
      if (port) return port;
    }
  }
  throw new Error('没等到 DevToolsActivePort');
}

/** 连上页面目标，拿到一个最小的 CDP 发送函数 */
async function connect(port) {
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const page = targets.find((target) => target.type === 'page') || targets[0];
  if (!page || !page.webSocketDebuggerUrl) throw new Error('没有可用的页面目标');

  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });

  const send = (method, params) =>
    new Promise((resolve) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params: params || {} }));
    });

  await send('Page.enable');
  await send('Runtime.enable');
  return { send, close: () => socket.close() };
}

/** 打开固定页面，等它把结果写进 <pre id="out"> */
async function readFixture(client, url, timeoutMs) {
  const limit = timeoutMs || 60000;
  await client.send('Page.navigate', { url });
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) {
    await sleep(250);
    const response = await client.send('Runtime.evaluate', {
      expression: '(document.getElementById("out") || {}).textContent || ""',
      returnByValue: true
    });
    const text = response && response.result && response.result.result ? response.result.result.value : '';
    if (text && text !== 'pending') return JSON.parse(decodeEntities(text));
  }
  throw new Error('页面没有产出结果（等了 ' + Math.round(limit / 1000) + ' 秒）');
}

/** 拉起独立浏览器（临时 profile，不动你正在用的 Edge），返回会话；用完 session.close() */
async function launchBrowser(browser) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wzsc-selftest-'));
  const flagSets = [['--headless=new'], ['--headless']];
  for (const headless of flagSets) {
    const child = spawn(
      browser,
      [
        ...headless,
        '--no-sandbox',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--remote-debugging-port=0',
        '--user-data-dir=' + profile,
        'about:blank'
      ],
      { stdio: 'ignore' }
    );
    try {
      const port = await waitForPort(profile, 20000);
      const client = await connect(port);
      return {
        read: (url, timeoutMs) => readFixture(client, url, timeoutMs),
        close() {
          try {
            client.close();
          } catch (error) {
            /* 忽略 */
          }
          try {
            child.kill();
          } catch (error) {
            /* 忽略 */
          }
          try {
            fs.rmSync(profile, { recursive: true, force: true });
          } catch (error) {
            /* 临时目录删不掉也无所谓 */
          }
        }
      };
    } catch (error) {
      try {
        child.kill();
      } catch (killError) {
        /* 忽略 */
      }
      // 换老一点的 --headless 写法再试一次
    }
  }
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch (error) {
    /* 忽略 */
  }
  throw new Error('浏览器没起来（远程调试端口一直没出现）');
}

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
  },
  {
    fixture: 'zhihu-comments.html',
    name: '知乎评论：作者回复跟原评论连在一起',
    run(data) {
      const comments = data.comments || [];
      const replyCount = comments.reduce((sum, comment) => sum + (comment.replies || []).length, 0);
      const who = comments.map((comment) => comment.nick + '(赞' + comment.likes + ',作者=' + comment.author + ')').join(' / ');
      check('6 条评论里 2 条回复 → 顶层 4 条', comments.length === 4, '收到 ' + comments.length + ' 条顶层：' + who);
      check('回复挂回了它所属的评论', replyCount === 2, '回复数 ' + replyCount);
      check(
        '作者回复带 (作者) 标记',
        comments.some((comment) => (comment.replies || []).some((reply) => reply.author))
      );
      check('父评论没有被误标成作者', !comments.some((comment) => comment.author), who);
      check('父评论的赞数没被回复带跑', comments.some((comment) => comment.likes === '12'), who);
      check(
        '对方说的话还在（不是只剩作者那句）',
        comments.some(
          (comment) =>
            String(comment.text).includes('路人乙说的话') &&
            (comment.replies || []).some((reply) => String(reply.text).includes('约饭只是最低成本'))
        ),
        JSON.stringify(comments.map((comment) => comment.text))
      );
    }
  }
];

async function main() {
  const browser = findBrowser(argValue('--browser', 'WZSC_TEST_BROWSER'));
  if (!browser) {
    console.log('没找到 Edge / Chrome，跳过浏览器自检（用 --browser 指定路径即可跑）。');
    return 0;
  }
  console.log('浏览器：' + browser + '\n');
  if (overrides.prepareDom || overrides.extractors) {
    console.log(
      '被测脚本：' +
        (overrides.prepareDom || 'src/prepare-dom.js') +
        ' + ' +
        (overrides.extractors || 'src/extractors.js') +
        '\n'
    );
  }

  let session = null;
  try {
    session = await launchBrowser(browser);
    for (const item of CASES) {
      console.log(item.name + '（' + item.fixture + '）');
      try {
        const data = await session.read(fixtureUrl(item.fixture));
        if (data.error) check('页面能跑起来', false, data.error);
        else item.run(data);
      } catch (error) {
        check('页面能跑起来', false, error.message);
      }
      console.log('');
    }
  } catch (error) {
    check('浏览器能起来', false, error.message);
  } finally {
    if (session) session.close();
  }

  console.log(passed + ' 项通过' + (failed ? '，' + failed + ' 项没通过' : ''));
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.log('自检没能跑完：' + (error && error.message ? error.message : error));
    process.exit(1);
  });
