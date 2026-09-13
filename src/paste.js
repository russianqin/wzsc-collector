'use strict';

/**
 * 微信公众号留言的"粘贴补录"。
 * 公众号的评论在网页端不渲染、接口又有风控，所以保留老办法：
 * 你在微信里把留言复制出来 → 扩展里粘一下 → 转成卡片格式写进对应文章。
 */

const fs = require('fs');
const path = require('path');

const { buildCommentsBlock } = require('./markdown');

const LIKE_RE = /^(?:赞\s*([\d,]+)|([\d,]+)\s*赞|👍\s*([\d,]+))$/;
const MARKER = '**精选留言**';

function likeCount(line) {
  const match = String(line || '').match(LIKE_RE);
  if (!match) return null;
  const raw = match[1] || match[2] || match[3] || '0';
  return raw.replace(/,/g, '');
}

/** 把微信里复制出来的纯文本解析成评论数组（昵称 / 赞N / 正文） */
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
      .map((block) => block.split('\n').map((line) => line.trim()).filter(Boolean))
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
    let bodyLines = lines.slice(likeIndex + 1, nextStart).filter(Boolean);
    // 有的复制结果会把"（作者）"放到正文第一行，这里也认出来
    let authorByBody = false;
    if (bodyLines.length && /^[（(]?作者[)）]?$/.test(bodyLines[0])) {
      authorByBody = true;
      bodyLines = bodyLines.slice(1);
    }
    const body = bodyLines.join('\n');
    comments.push({
      avatar: '',
      nick: nickRaw.replace(/[（(]作者[)）]/g, '').trim(),
      likes: likeCount(lines[likeIndex]) || '',
      text: body,
      author: author || authorByBody,
      replies: []
    });
  });
  return comments.filter((comment) => comment.text);
}

/** 按编号（478）或文件名找到对应的 md */
function findTarget(repoPath, target) {
  if (!target) return null;
  const direct = path.resolve(String(target));
  if (fs.existsSync(direct) && direct.toLowerCase().endsWith('.md')) return direct;
  const prefix = String(target).padStart(3, '0');
  const match = fs.readdirSync(repoPath).find((name) => name.startsWith(prefix + '.') && name.toLowerCase().endsWith('.md'));
  return match ? path.join(repoPath, match) : null;
}

/** 把解析出来的留言写进文章（已有留言区块就替换掉） */
function applyPastedComments(repoPath, target, text) {
  const file = findTarget(repoPath, target);
  if (!file) throw new Error('没找到对应编号的文章：' + target);

  const comments = parsePastedComments(text);
  if (comments.length === 0) {
    throw new Error('没解析出留言，请检查复制的内容（格式：昵称 / 赞N / 正文）');
  }

  const block = buildCommentsBlock(comments);
  const original = fs.readFileSync(file, 'utf8');
  const markerIndex = original.indexOf(MARKER);
  const updated =
    (markerIndex >= 0 ? original.slice(0, markerIndex).trimEnd() : original.trimEnd()) + '\n\n' + block + '\n';
  fs.writeFileSync(file, updated, 'utf8');

  return {
    file: path.basename(file),
    count: comments.length,
    replaced: markerIndex >= 0,
    preview: comments.slice(0, 5).map((comment) => ({
      nick: comment.nick || '匿名',
      author: Boolean(comment.author),
      likes: comment.likes || '',
      text: comment.text.slice(0, 40)
    }))
  };
}

module.exports = { parsePastedComments, findTarget, applyPastedComments };
