#!/usr/bin/env node
'use strict';

/**
 * 给「双击运行」用的交互界面。
 * .cmd 文件只负责切到 UTF-8 代码页并调用本文件，中文提示都写在这里，
 * 避免 Windows 批处理对中文的编码问题。
 */

const readline = require('readline');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;

let rl = null;

function ask(question) {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  }
  return new Promise((resolve) => rl.question(question, (answer) => resolve(String(answer || '').trim())));
}

function line() {
  console.log('------------------------------------------------------------');
}

function runNode(args) {
  const result = spawnSync(NODE, args, { stdio: 'inherit', cwd: ROOT });
  return result.status === 0;
}

function loadConfig() {
  const file = path.join(ROOT, 'config.json');
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

async function actionLogin() {
  line();
  console.log('【登录知乎 / 微博 / X】（只需要做一次）');
  line();
  console.log('');
  console.log('接下来会打开一个浏览器窗口，请在里面登录你要用的站点：');
  console.log('  · 知乎（抓评论需要）');
  console.log('  · 微博（整个站点都需要登录）');
  console.log('  · X（需要登录）');
  console.log('');
  console.log('登录完成后，回到这个黑色窗口，按 Ctrl + C 结束即可。');
  console.log('');
  await ask('按回车开始…');
  runNode([path.join(ROOT, 'src', 'cli.js'), '--login']);
}

async function actionCollect() {
  line();
  console.log('【采集一篇文章】');
  line();
  console.log('');
  console.log('把文章链接粘贴到下面（右键粘贴），然后按回车。');
  console.log('提示：公众号、知乎、微博、X 的链接都支持。');
  console.log('');
  const url = await ask('链接： ');
  if (!url) {
    console.log('没有输入链接，已取消。');
    return;
  }
  console.log('');
  console.log('你要采集的是这个链接：');
  console.log('  ' + url);
  const confirm = await ask('确认无误？（直接回车继续，输入 n 取消）： ');
  if (/^n/i.test(confirm)) {
    console.log('已取消，没有采集任何内容。');
    return;
  }
  console.log('');
  console.log('正在打开浏览器采集，请稍等（10~30 秒）…');
  console.log('');
  const ok = runNode([path.join(ROOT, 'src', 'cli.js'), url]);
  console.log('');
  if (ok) {
    console.log('采集完成 ✔  文件已经写进你的收藏仓库（文件名：编号.标题.md）');
    console.log('想看看内容，可以在菜单里选「4 打开收藏仓库文件夹」。');
  } else {
    console.log('这次没成功。把上面显示的内容复制发给我，我来改。');
  }
}

async function actionComments() {
  line();
  console.log('【补录微信公众号的留言】');
  line();
  console.log('');
  console.log('公众号的留言只能在微信里看到，请先在手机上：');
  console.log('  1) 把文章链接发到微信聊天框，点开它（会用微信内置浏览器打开）');
  console.log('  2) 长按选中留言区的文字，复制');
  console.log('');
  const number = await ask('这篇文章的编号（例如 478）： ');
  if (!number) {
    console.log('没有输入编号，已取消。');
    return;
  }
  console.log('');
  const ok = runNode([path.join(ROOT, 'src', 'paste-comments.js'), number]);
  console.log('');
  if (ok) {
    console.log('留言已写入 ✔  打开仓库文件夹就能看到。');
  } else {
    console.log('没读成功。确认一下：编号对不对？留言有没有复制到剪贴板？');
  }
}

async function actionOpenRepo() {
  const config = loadConfig();
  const repo = config.repoPath;
  line();
  console.log('【打开收藏仓库文件夹】');
  line();
  console.log('');
  if (!repo || !fs.existsSync(repo)) {
    console.log('没找到仓库路径，请检查 config.json 里的 repoPath。');
    return;
  }
  console.log('正在打开：' + repo);
  spawn('explorer.exe', [repo], { detached: true, stdio: 'ignore' }).unref();
  console.log('（窗口已经打开，采集到的文章都在里面）');
}

async function actionDebugCollect() {
  line();
  console.log('【采集并保存调试页面】（抓取出问题时用）');
  line();
  console.log('');
  console.log('和「采集一篇文章」一样，只是会额外把网页源码存到 debug 文件夹，');
  console.log('方便我定位抓取规则的问题。平时不用选这个。');
  console.log('');
  const url = await ask('链接： ');
  if (!url) {
    console.log('没有输入链接，已取消。');
    return;
  }
  console.log('');
  const ok = runNode([path.join(ROOT, 'src', 'cli.js'), url, '--debug']);
  console.log('');
  console.log(ok ? '完成 ✔（页面源码已存到 debug 文件夹）' : '这次没成功，把上面的内容发我。');
}

async function actionCleanup() {
  line();
  console.log('【清理本地图片（还原成原始外链）】');
  line();
  console.log('');
  console.log('早期版本会把文章里的图片下载到 assets 文件夹。');
  console.log('这一步会把那些图片换成它原来的网络地址，然后删掉 assets 文件夹。');
  console.log('');
  console.log('安全说明：只有当图片能和原文网页上的图片一一对上时才替换；');
  console.log('对不上的文件会原样保留，不会破坏你的收藏。');
  console.log('');
  console.log('第 1 步：先检查（不会修改任何文件）');
  console.log('');
  await ask('按回车开始检查…');
  console.log('');
  const checked = runNode([path.join(ROOT, 'src', 'restore-images.js')]);
  console.log('');
  if (!checked) {
    console.log('检查过程出错了。把上面的内容复制发我。');
    return;
  }
  const confirm = await ask('要按上面的结果正式清理吗？（输入 y 再回车确认；直接回车 = 取消）： ');
  if (!/^y/i.test(confirm)) {
    console.log('已取消，没有修改任何文件。');
    return;
  }
  console.log('');
  const applied = runNode([path.join(ROOT, 'src', 'restore-images.js'), '--apply']);
  console.log('');
  console.log(applied ? '清理完成 ✔ 打开仓库文件夹就能看到（记得自己提交到 GitHub）。' : '清理失败，把上面的内容发我。');
}

async function menu() {
  console.log('');
  console.log('============================================================');
  console.log('        文章收藏助手  ·  wzsc-collector');
  console.log('============================================================');
  console.log('');
  console.log('  1  首次登录（知乎 / 微博 / X，只做一次）');
  console.log('  2  采集一篇文章（粘贴链接即可）');
  console.log('  3  补录微信公众号的留言（先从微信里复制）');
  console.log('  4  打开收藏仓库文件夹（查看刚采到的文章）');
  console.log('  5  采集并保存调试页面（抓取出问题时用）');
  console.log('  6  清理本地图片（还原成原始外链）');
  console.log('  0  退出');
  console.log('');
  const choice = await ask('请输入数字后回车： ');
  if (choice === '1') return actionLogin();
  if (choice === '2') return actionCollect();
  if (choice === '3') return actionComments();
  if (choice === '4') return actionOpenRepo();
  if (choice === '5') return actionDebugCollect();
  if (choice === '6') return actionCleanup();
  console.log('已退出。');
}

async function main() {
  const mode = process.argv[2];
  if (mode === 'login') return actionLogin();
  if (mode === 'collect') return actionCollect();
  if (mode === 'comments') return actionComments();
  if (mode === 'open-repo') return actionOpenRepo();
  if (mode === 'debug') return actionDebugCollect();
  if (mode === 'cleanup') return actionCleanup();
  return menu();
}

main()
  .catch((error) => {
    console.log('出错了：' + error.message);
  })
  .finally(() => {
    if (rl) rl.close();
  });
