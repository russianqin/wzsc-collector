#!/usr/bin/env node
'use strict';

/**
 * Markdown 规则自检：纯 Node，不联网、不用浏览器，一秒跑完。
 *
 *   npm test                          跑自检
 *   node tools/markdown-selftest.js   同上
 *   node tools/markdown-selftest.js --git 2481ff9
 *                                     换成某个提交里的 markdown.js 跑，
 *                                     用来验证"这次到底修好了没有"：旧代码应该红
 *   node tools/markdown-selftest.js <某个 markdown.js 的路径>
 *                                     换成磁盘上任意一份 markdown.js 跑
 *
 * 守的是 src/markdown.js 里那一串清洗规则。它们是一条链、互相会踩：
 * 改一处很容易把公众号 / 知乎 / 微博 / X 的排版弄退化，
 * 而这些退化往往只出现在你手边恰好没有的页面上，光靠肉眼存几篇看不出来。
 * 规则改了就顺手跑一下，红了再改。
 */

const path = require('path');
const fs = require('fs');
const Module = require('module');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DEFAULT_TARGET = path.join(ROOT, 'src', 'markdown.js');

/** 载入被测文件：支持项目里的、磁盘上别处的、以及某个 git 提交里的那份 */
function loadMarkdown(spec) {
  if (!spec) {
    return { file: DEFAULT_TARGET, api: require(DEFAULT_TARGET) };
  }
  let code;
  let file;
  if (spec.startsWith('--git')) {
    const revision = process.argv[3];
    if (!revision) throw new Error('用法：node tools/markdown-selftest.js --git <提交号>');
    code = execFileSync('git', ['show', revision + ':src/markdown.js'], { cwd: ROOT, encoding: 'utf8' });
    file = DEFAULT_TARGET + ' @ ' + revision;
  } else {
    file = path.resolve(spec);
    code = fs.readFileSync(file, 'utf8');
  }
  // 用 _compile 直接跑源码，这样"别处的 / 旧提交里的"那份也能 require 到项目里的 turndown
  const mod = new Module(file, null);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.join(ROOT, 'src')).concat(Module._nodeModulePaths(ROOT));
  mod._compile(code, file);
  return { file, api: mod.exports };
}

const { file: TARGET, api } = loadMarkdown(process.argv[2]);
const { htmlToMarkdown, stripLeadingJunk, assembleDocument, buildCommentsBlock, buildVideoBlock } = api;

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  if (actual === expected) {
    passed += 1;
    console.log('✔ ' + name);
    return;
  }
  failed += 1;
  console.log('✘ ' + name);
  console.log('   期望: ' + JSON.stringify(expected));
  console.log('   实际: ' + JSON.stringify(actual));
}

function section(title) {
  console.log('\n' + title);
}

section('换行 → 分段');
check(
  'br 变成分段（不是并成一个空格，也不是软换行）',
  htmlToMarkdown('第一段<br>第二段'),
  '第一段\n\n第二段'
);
check(
  '连续 br 不会撑出多个空行',
  htmlToMarkdown('一<br><br>二'),
  '一\n\n二'
);
check('段落 + br 混排', htmlToMarkdown('<p>第一段</p><p>第二段<br>软换行</p>'), '第一段\n\n第二段\n\n软换行');

section('开头的杂项清理（只在正文之前动手）');
check('标题重复被清掉、后面的分段保留', stripLeadingJunk('标题\n\n第一段\n\n第二段', '标题'), '第一段\n\n第二段');
check('没有任何杂项时原样返回', stripLeadingJunk('第一段\n\n第二段', 'X'), '第一段\n\n第二段');
check('开头的阅读数 / Article 仍能清掉', stripLeadingJunk('标题\n\n57\n\nArticle\n\n正文一\n\n正文二', '标题'), '正文一\n\n正文二');
check('开头就有空行也不影响', stripLeadingJunk('\n\n正文一\n\n正文二', 'X'), '正文一\n\n正文二');
check('正文中间的空行一直保留', stripLeadingJunk('首段\n\n次段\n\n三段', 'X'), '首段\n\n次段\n\n三段');

section('加粗');
check('加粗跨了换行 → 逐段加粗', htmlToMarkdown('<div><span style="font-weight:700">A<br>B</span></div>'), '**A**\n\n**B**');
check('加粗A + 空行 + 加粗B 不被粘成一段', htmlToMarkdown('<div><strong>A</strong><br><br><strong>B</strong></div>'), '**A**\n\n**B**');
check('只剩换行的空加粗被清掉', htmlToMarkdown('<div><strong><br></strong></div>'), '');
check('普通加粗不受影响', htmlToMarkdown('<div>前<strong>重点</strong>后</div>'), '前**重点**后');
check('Style span 表示的加粗', htmlToMarkdown('<div><span style="font-weight: 700">粗</span>常</div>'), '**粗**常');

section('别的站点不能退化');
check('列表', htmlToMarkdown('<ul><li>甲</li><li>乙</li></ul><p>尾段</p>'), '-   甲\n-   乙\n\n尾段');
check('引用', htmlToMarkdown('<blockquote><p>引用一</p></blockquote>'), '> 引用一');
check('引用里的 br 仍是空行', htmlToMarkdown('<blockquote>一<br>二</blockquote>'), '> 一\n>\n> 二');
check('标题里的 br 不能拆结构', htmlToMarkdown('<h2>大标题<br>继续</h2>'), '## 大标题 继续');
check('代码块不动', htmlToMarkdown('<pre><code>const a = 1;</code></pre>'), '```\nconst a = 1;\n```');
check('表格交给 gfm 插件', htmlToMarkdown('<table><tr><td>a</td><td>b</td></tr></table>').includes('<table'), true);
check('图片外链保留', htmlToMarkdown('<p><img src="https://e/1.jpg" alt="图"></p>'), '![图](https://e/1.jpg)');

section('整篇拼装');
check(
  '标题 / 作者 / 正文 / 视频 / 留言 的顺序和空行',
  assembleDocument({
    title: '标题',
    url: 'https://x.com/a/status/1',
    author: '作者',
    date: '2026-05-13',
    body: stripLeadingJunk(htmlToMarkdown('标题<br><br>一<br><br>二'), '标题'),
    videoBlock: buildVideoBlock([{ poster: 'https://p/1.jpg', url: 'https://v/1' }]),
    commentsBlock: buildCommentsBlock([{ nick: 'n', text: 'c1\nc2', avatar: '', likes: '3', author: false, replies: [] }])
  }),
  '## [标题](https://x.com/a/status/1)' +
    '\n\n作者 · 2026-05-13' +
    '\n\n一\n\n二' +
    '\n\n![](https://p/1.jpg)\n[视频地址](https://v/1)' +
    '\n\n**精选留言**\n\n- n\n  赞3\n  c1\n  c2\n'
);
check('留言里的多行按原样缩进', buildCommentsBlock([{ nick: 'n', text: '一\n二', avatar: '', likes: '', author: true, replies: [] }]), '**精选留言**\n\n- n\n  (作者)\n  一\n  二');

console.log(
  '\n' + passed + ' 项通过' + (failed ? '，' + failed + ' 项没通过' : '') + '（被测文件：' + TARGET + '）'
);
process.exit(failed === 0 ? 0 : 1);
