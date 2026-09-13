#!/usr/bin/env node
'use strict';

/**
 * 把「从微信里复制出来的留言」转成卡片格式，写进对应的收藏文章。
 *
 * 用法：
 *   node src/paste-comments.js 478              # 从剪贴板读取（Windows）
 *   node src/paste-comments.js 478 comments.txt # 从文件读取
 *   node src/paste-comments.js 478 --dry-run    # 只预览不写入
 *
 * 微信里复制出来的留言大致长这样（顺序固定）：
 *   昵称
 *   赞184
 *   留言正文……
 *   （空行）
 *   另一个昵称
 *   赞12
 *   另一条留言……
 * 作者本人的回复如果也在里面，会在昵称后带「作者」或单独一行 (作者)。
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const { loadConfig } = require('./config');
const { buildCommentsBlock } = require('./markdown');
const { log } = require('./util');

const LIKE_RE = /^(?:赞\s*([\d,]+)|([\d,]+)\s*赞|👍\s*([\d,]+))$/;
const MARKER = '**精选留言**';

function readClipboard() {
  try {
    return execSync('powershell -NoProfile -Command "Get-Clipboard -Raw"', { encoding: 'utf8' });
  } catch (error) {
    log('读取剪贴板失败：' + error.message);
    return '';
  }
}

function likeCount(line) {
  const match = line.match(LIKE_RE);
  if (!match) return null;
  const raw = match[1] || match[2] || match[3] || '0';
  return raw.replace(/,/g, '');
}

/** 把微信复制出来的纯文本解析成评论数组 */
function parsePastedComments(text) {
  const lines = String(text || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim());

  const likeIndexes = [];
  lines.forEach((line, index) => {
    if (likeCount(line) !== null) likeIndexes.push(index);
  });

  // 没有赞数行时：按空行分块，块内第一行是昵称，其余是正文
  if (likeIndexes.length === 0) {
    return text
      .split(/\n\s*\n/)
      .map((block) => block.split('\n').map((l) => l.trim()).filter(Boolean))
      .filter((blockLines) => blockLines.length > 0)
      .map((blockLines) => {
        const nickLine = blockLines[0];
        const author = /作者/.test(nickLine);
        return {
          avatar: '',
          nick: nickLine.replace(/[（(]作者[)）]/g, '').trim(),
          likes: '',
          text: blockLines.slice(1).join('\n'),
          author,
          replies: []
        };
      })
      .filter((comment) => comment.text);
  }

  const isAuthorMarker = (line) => /^[（(]?作者[)）]?$/.test(line);

  // 昵称 = 该「赞」行之前、上一条正文之后的最后一个非空行（跳过单独的「(作者)」标记行）
  const nickIndexes = likeIndexes.map((likeIndex, order) => {
    const floor = order > 0 ? likeIndexes[order - 1] : -1;
    for (let i = likeIndex - 1; i > floor; i -= 1) {
      if (lines[i] && !isAuthorMarker(lines[i])) return i;
    }
    return -1;
  });

  const comments = [];
  likeIndexes.forEach((likeIndex, order) => {
    const nickIndex = nickIndexes[order];
    const nickRaw = nickIndex >= 0 ? lines[nickIndex] : '';
    const author =
      /作者/.test(nickRaw) || lines.slice(nickIndex + 1, likeIndex).some((line) => /^[（(]?作者[)）]?$/.test(line));
    const nextStart = order + 1 < likeIndexes.length && nickIndexes[order + 1] >= 0 ? nickIndexes[order + 1] : lines.length;
    const body = lines
      .slice(likeIndex + 1, nextStart)
      .filter(Boolean)
      .join('\n');
    comments.push({
      avatar: '',
      nick: nickRaw.replace(/[（(]作者[)）]/g, '').trim(),
      likes: likeCount(lines[likeIndex]) || '',
      text: body,
      author,
      replies: []
    });
  });
  return comments.filter((comment) => comment.text);
}

function findTarget(repoPath, target) {
  if (!target) return null;
  const direct = path.resolve(target);
  if (fs.existsSync(direct) && direct.endsWith('.md')) return direct;
  const prefix = String(target).padStart(3, '0');
  const match = fs.readdirSync(repoPath).find((name) => name.startsWith(prefix + '.') && name.endsWith('.md'));
  return match ? path.join(repoPath, match) : null;
}

function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== '--dry-run');
  const dryRun = process.argv.includes('--dry-run');
  const [target, sourceFile] = args;

  if (!target) {
    log('用法：node src/paste-comments.js <文章编号或 md 路径> [评论文本文件]');
    log('  不带文件参数时，会从剪贴板读取（先在微信里复制好留言）');
    return;
  }

  const config = loadConfig();
  const file = findTarget(config.repoPath, target);
  if (!file) {
    log('没找到对应的 md 文件：' + target);
    return;
  }

  const pasted = sourceFile ? fs.readFileSync(sourceFile, 'utf8') : readClipboard();
  if (!pasted.trim()) {
    log('没有读到内容。可以先用 --file 传一个文本文件。');
    return;
  }

  const comments = parsePastedComments(pasted);
  log(`解析出 ${comments.length} 条留言：`);
  comments.slice(0, 5).forEach((comment, index) => {
    log(`  ${index + 1}. ${comment.nick || '匿名'}${comment.author ? '（作者）' : ''}｜赞${comment.likes || '-'}｜${comment.text.slice(0, 40)}`);
  });
  if (comments.length > 5) log(`  …还有 ${comments.length - 5} 条`);
  if (comments.length === 0) {
    log('没解析出留言，请检查复制的内容格式（昵称 / 赞N / 正文）。');
    return;
  }

  const block = buildCommentsBlock(comments);
  const original = fs.readFileSync(file, 'utf8');
  const markerIndex = original.indexOf(MARKER);
  const updated =
    (markerIndex >= 0 ? original.slice(0, markerIndex).trimEnd() : original.trimEnd()) + '\n\n' + block + '\n';

  if (dryRun) {
    log('--- 预览（未写入） ---');
    console.log(block);
    return;
  }
  fs.writeFileSync(file, updated, 'utf8');
  log(`已写入 ${path.basename(file)}（${markerIndex >= 0 ? '替换原有留言' : '新增留言区块'}）`);
  log('检查后自己提交即可。');
}

if (require.main === module) {
  main();
}

module.exports = { parsePastedComments };
