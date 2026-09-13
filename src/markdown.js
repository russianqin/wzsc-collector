'use strict';

let turndownInstance = null;

/** 延迟加载 turndown：这样没装依赖时也能用其它纯函数（便于测试/调试） */
function getTurndown() {
  if (turndownInstance) return turndownInstance;
  const TurndownService = require('turndown');
  const { gfm } = require('turndown-plugin-gfm');
  turndownInstance = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*'
  });
  turndownInstance.use(gfm);
  turndownInstance.addRule('keepVideoPoster', {
    filter: (node) => node.nodeName === 'VIDEO',
    replacement: (content, node) => {
      const poster = node.getAttribute('poster') || '';
      return poster ? '\n\n![](' + poster + ')\n\n' : '';
    }
  });
  // 有些站点（例如登录状态下的 X）用带 font-weight 的 span 表示加粗，这里补上
  turndownInstance.addRule('boldStyledSpan', {
    filter: (node) =>
      node.nodeName === 'SPAN' && /font-weight:\s*(bold|[6-9]00)/i.test(node.getAttribute('style') || ''),
    replacement: (content) => {
      const text = content.trim();
      return text ? '**' + text + '**' : content;
    }
  });
  // <br> 要当成"分段"。多数站点（知乎、公众号）作者按的是换行而不是分段，
  // 默认的软换行写法会被很多渲染器（GitHub、编辑器预览）合并成一整段，
  // 看起来就是"头几段糊成一大坨"。这里统一成空行，任何地方渲染都一致。
  turndownInstance.addRule('lineBreakAsParagraph', {
    filter: 'br',
    replacement: (content, node) => {
      const parent = node.parentNode ? node.parentNode.nodeName : '';
      // 标题、表格、列表项里的换行不能变成空行，否则会把结构拆坏
      if (/^(H1|H2|H3|H4|H5|H6|TD|TH|LI|DT|DD)$/.test(parent)) return ' ';
      return '\n\n';
    }
  });
  return turndownInstance;
}

function htmlToMarkdown(html) {
  if (!html) return '';
  return getTurndown()
    .turndown(html)
    // 图片外面套了链接的（例如 X 的文章图片）：去掉外层链接，只留图片（允许中间有换行）
    .replace(/\[\s*!\[([^\]]*)\]\(([^)]+)\)\s*\]\([^)]*\)/g, '![$1]($2)')
    // 有些站点（例如 X 的长文）会把加粗嵌套成 ****文字****，统一压成标准写法
    .replace(/\*{4,}/g, '**')
    // 标题被块级元素拆成两行（"##\n\n标题文字"）时合回一行
    .replace(/^(#{1,6})[ \t]*\n+[ \t]*(\S.*)$/gm, '$1 $2')
    // 清掉没有文字的标题行
    .replace(/^#{1,6}[ \t]*$/gm, '')
    // 标题里的编号不要被转义（"1\. 暧昧" → "1. 暧昧"）
    .replace(/^((?:#{1,6}[ \t]+)?\d+)\\\./gm, '$1.')
    // 微信的加粗常被 <br> 拆成两行（**文字\n**），这里合回去
    .replace(/\*\*([^*\n]{1,80})\n\*\*/g, '**$1**')
    .replace(/\*\*\s*\n\s*\*\*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/** 把 markdown 里的图片地址逐一替换（downloadImage 返回本地相对路径） */
async function rewriteImages(markdown, resolve) {
  const urls = new Set();
  const patterns = [/!\[[^\]]*\]\((\S+?)(?:\s+"[^"]*")?\)/g, /<img[^>]+src="([^"]+)"/g];
  patterns.forEach((pattern) => {
    let match;
    while ((match = pattern.exec(markdown)) !== null) {
      if (/^https?:/i.test(match[1])) urls.add(match[1]);
    }
  });
  let result = markdown;
  for (const url of urls) {
    const local = await resolve(url);
    if (local && local !== url) {
      result = result.split(url).join(local);
    }
  }
  return result;
}

/**
 * 输出留言区块：格式与收藏仓库里原有文件一致，
 * 这样博客端的留言卡片能直接复用。
 */
function buildCommentsBlock(comments) {
  if (!comments || comments.length === 0) return '';
  const out = ['**精选留言**', ''];
  comments.forEach((comment, index) => {
    if (index > 0) out.push('');
    const lines = [];
    if (comment.avatar) {
      lines.push('- ![](' + comment.avatar + ')');
    } else {
      lines.push('- ' + (comment.nick || '匿名'));
    }
    if (comment.avatar && comment.nick) lines.push('  ' + comment.nick);
    if (comment.author) lines.push('  (作者)');
    if (comment.likes) lines.push('  赞' + comment.likes);
    (comment.text || '').split('\n').forEach((line) => lines.push('  ' + line));

    (comment.replies || []).forEach((reply) => {
      lines.push('');
      if (reply.avatar) lines.push('  ![](' + reply.avatar + ')');
      if (reply.nick) lines.push('  ' + reply.nick);
      if (reply.author) lines.push('  (作者)');
      if (reply.likes) lines.push('  赞' + reply.likes);
      (reply.text || '').split('\n').forEach((line) => lines.push('  ' + line));
    });
    out.push(lines.join('\n'));
  });
  return out.join('\n');
}

function buildVideoBlock(videos) {
  if (!videos || videos.length === 0) return '';
  const lines = [];
  videos.forEach((video) => {
    if (video.poster) lines.push('![](' + video.poster + ')');
    if (video.url) lines.push('[视频地址](' + video.url + ')');
    lines.push('');
  });
  return lines.join('\n').trim();
}

function assembleDocument({ title, url, author, date, body, commentsBlock, videoBlock }) {
  const head = url ? '## [' + title + '](' + url + ')' : '## ' + title;
  const metaLine = [author, date].filter(Boolean).join(' · ');
  const sections = [head];
  if (metaLine) sections.push('', metaLine);
  if (body) sections.push('', body);
  if (videoBlock) sections.push('', videoBlock);
  if (commentsBlock) sections.push('', commentsBlock);
  return sections.join('\n').replace(/\n{4,}/g, '\n\n\n').trim() + '\n';
}

/**
 * 清掉正文开头的杂项行：标题重复、纯数字（阅读/点赞数）、"Article" 标签、analytics 链接残片。
 * 只处理开头几十行，不影响正文中间的内容。
 */
function stripLeadingJunk(markdown, title) {
  const lines = String(markdown || '').split('\n');
  const normalizedTitle = String(title || '').trim();
  let index = 0;
  while (index < lines.length && index < 30) {
    const text = lines[index].trim();
    const isJunk =
      !text ||
      text === normalizedTitle ||
      /^[\d.,]+\s*[KM]?$/.test(text) ||
      /^(Views?|Article|Likes?|Reposts?)$/i.test(text) ||
      /^\]+\([^)]*analytics[^)]*\)$/.test(text) ||
      /^\[$/.test(text);
    if (isJunk) {
      lines.splice(index, 1);
      continue;
    }
    index += 1;
  }
  return lines.join('\n').replace(/^\n+/, '');
}

module.exports = {
  htmlToMarkdown,
  rewriteImages,
  buildCommentsBlock,
  buildVideoBlock,
  assembleDocument,
  stripLeadingJunk
};
