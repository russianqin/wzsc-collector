'use strict';

/**
 * 这些函数会被序列化后送到页面里执行（page.evaluate），
 * 所以每个函数都必须自包含：不能引用外部变量或模块。
 * 统一返回结构：
 *   { site, title, author, date, canonical, contentHtml, videos: [], comments: [] }
 */

/* ---------------------------------------------------------------- 微信公众号 */
function extractWeixin() {
  const meta = (name) => {
    const el = document.querySelector('meta[property="' + name + '"]') || document.querySelector('meta[name="' + name + '"]');
    return el ? el.content : '';
  };
  const txt = (selector) => {
    const el = document.querySelector(selector);
    return el ? (el.innerText || '').trim() : '';
  };

  const content = document.querySelector('#js_content');
  if (content) {
    // 微信图片是懒加载：真实地址在 data-src 上
    content.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('data-src') || img.getAttribute('data-croporisrc');
      if (src) img.setAttribute('src', src);
      img.removeAttribute('data-src');
    });
  }

  const videos = [];
  document.querySelectorAll('#js_content [data-mpvid], #js_content iframe.mpvideo').forEach((el) => {
    const vid = el.getAttribute('data-mpvid') || el.getAttribute('data-vid') || '';
    const posterEl = el.querySelector('img');
    if (vid || posterEl) {
      videos.push({
        url: vid ? 'https://mp.weixin.qq.com/mp/videoplayer?action=get_mp_video_play_url&vid=' + vid : '',
        poster: posterEl ? posterEl.getAttribute('src') || posterEl.getAttribute('data-src') || '' : ''
      });
    }
  });

  return {
    site: 'weixin',
    title: txt('#activity-name') || meta('og:title') || document.title,
    author: txt('#js_name') || txt('.rich_media_meta_nickname'),
    date: txt('#publish_time'),
    canonical: meta('og:url') || location.href,
    contentHtml: content ? content.innerHTML : '',
    videos: videos,
    comments: []
  };
}

/* ---------------------------------------------------------------- 知乎 */
function extractZhihu() {
  const one = (selector) => document.querySelector(selector);
  const txt = (el) => (el ? (el.innerText || '').trim() : '');

  const answerId = (location.pathname.match(/answer\/(\d+)/) || [])[1];
  let card = answerId ? findAnswerCard(answerId) : null;

  // 指定了某个回答却找不到时，宁可失败，也不要抓成别人的回答
  if (answerId && !card) {
    return {
      site: 'zhihu',
      error: '页面里没找到目标回答（可能被折叠、需要登录，或页面还没加载完）',
      canonical: location.href
    };
  }
  if (!card) card = document.querySelector('.ContentItem.AnswerItem') || document.querySelector('.AnswerCard');

  function findAnswerCard(id) {
    return (
      document.querySelector('[data-zop*=\'"itemId":"' + id + '"\']') ||
      document.querySelector('[data-zop*="' + id + '"]') ||
      document.querySelector('#answer-' + id) ||
      null
    );
  }

  const scope = card || document;
  const content = scope.querySelector('.RichText') || scope.querySelector('.RichContent-inner');
  if (content) {
    content.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('data-original') || img.getAttribute('data-src') || img.getAttribute('src');
      if (src) img.setAttribute('src', src);
    });
  }
  const title = txt(one('h1.QuestionHeader-title')) || txt(one('.QuestionHeader-title')) || document.title.replace(/ - 知乎$/, '');
  const author = txt(scope.querySelector('.AuthorInfo-name .UserLink-link')) || txt(scope.querySelector('.AuthorInfo-name'));
  // 时间元素里会带地区（第二行「・浙江」），只取第一行
  const date = txt(scope.querySelector('.ContentItem-time')).split('\n')[0].trim();

  return {
    site: 'zhihu',
    title: title,
    author: author,
    date: date,
    // 保留回答级链接：页面的 canonical 往往是问题链接
    canonical: answerId ? location.origin + location.pathname : (one('link[rel="canonical"]') || {}).href || location.href,
    contentHtml: content ? content.innerHTML : '',
    videos: [],
    comments: []
  };
}

/**
 * 知乎评论：知乎用哈希类名（css-xxxxx），所以这里按结构找——
 * 每一条评论都自带 .CommentContent，向上找最近的"包含头像的容器"就是这条评论。
 */
function extractZhihuComments() {
  const comments = [];
  Array.from(document.querySelectorAll('.CommentContent')).forEach((contentEl) => {
    let item = contentEl;
    while (item && item !== document.body && !item.querySelector('img.Avatar')) {
      item = item.parentElement;
    }
    if (!item || item === document.body) item = contentEl.parentElement || contentEl;

    const avatarEl = item.querySelector('img.Avatar');
    const nickLink = Array.from(item.querySelectorAll('a[href*="/people/"]')).find((a) => (a.innerText || '').trim());
    const nick = nickLink ? nickLink.innerText.trim() : avatarEl ? avatarEl.getAttribute('alt') || '' : '';

    // 点赞数：动作行里那个"纯数字"的按钮（比如 1923）
    let likes = '';
    Array.from(item.querySelectorAll('button')).some((button) => {
      const match = (button.innerText || '').trim().match(/^(\d+)$/);
      if (match) {
        likes = match[1];
        return true;
      }
      return false;
    });

    // 「作者」标记：昵称旁边那个独立的小标签（排除正文里出现的"作者"二字）
    const author = Array.from(item.querySelectorAll('div, span')).some(
      (el) => (el.innerText || '').trim() === '作者' && !contentEl.contains(el)
    );

    comments.push({
      avatar: avatarEl ? avatarEl.getAttribute('src') || '' : '',
      nick: nick,
      likes: likes,
      text: (contentEl.innerText || '').trim(),
      author: author,
      replies: []
    });
  });
  return comments.filter((comment) => comment.text);
}

/* ---------------------------------------------------------------- 新浪微博 */
function extractWeibo() {
  const txt = (el) => (el ? (el.innerText || '').trim() : '');
  const contentEl = document.querySelector(
    '[node-type="feed_list_content_full"], [node-type="feed_list_content"], [class*="detail_wbtext"], .WB_text'
  );
  const authorEl = document.querySelector('.head_name, [class*="head_name"], .W_f14, a.name');
  const dateEl = document.querySelector('[node-type="feed_list_item_date"], [class*="head-info_time"], time');
  const imageEls = Array.from(
    document.querySelectorAll('[node-type="feed_list_media_prev"] img, [class*="picture"] img, [class*="media"] img')
  );
  const videoEl = document.querySelector('video[poster], [class*="video"] video, .video_img img');

  let contentHtml = contentEl ? contentEl.innerHTML : '';
  imageEls.forEach((img) => {
    const url = img.getAttribute('src') || img.getAttribute('data-src') || '';
    if (url && contentHtml.indexOf(url) === -1) contentHtml += '<p><img src="' + url + '" alt=""></p>';
  });

  return {
    site: 'weibo',
    title: txt(document.querySelector('h1, [class*="head_title"], .detail_wbtext')) || document.title,
    author: txt(authorEl).replace(/^@/, ''),
    date: txt(dateEl) || (document.querySelector('time') ? document.querySelector('time').getAttribute('datetime') || '' : ''),
    canonical: (document.querySelector('link[rel="canonical"]') || {}).href || location.href,
    contentHtml: contentHtml,
    videos: videoEl
      ? [
          {
            url: videoEl.getAttribute('src') || '',
            poster: videoEl.getAttribute('poster') || ''
          }
        ]
      : [],
    comments: []
  };
}

/** 微博评论：含博主本人的回复 */
function extractWeiboComments() {
  const nodes = Array.from(
    document.querySelectorAll(
      '[node-type="comment_list"] .list_li, [class*="comment_list"] .list_li, [class*="CommentItem"], [class*="comment_li"]'
    )
  );
  const comments = [];
  nodes.forEach((node) => {
    const avatar = node.querySelector('img');
    const nick = node.querySelector('.W_fb, [class*="name"]');
    const text = node.querySelector('.WB_text, [class*="text"]');
    const like = node.querySelector('[class*="like"] em, em');
    const inner = node.innerText || '';
    comments.push({
      avatar: avatar ? avatar.getAttribute('src') : '',
      nick: nick ? (nick.innerText || '').trim() : '',
      likes: like ? ((like.innerText || '').match(/\d+/) || [''])[0] : '',
      text: text ? (text.innerText || '').trim() : '',
      author: /博主|作者/.test(inner),
      replies: []
    });
  });
  return comments.filter((c) => c.text);
}

/* ---------------------------------------------------------------- X (Twitter) */
function extractX() {
  const txt = (el) => (el ? (el.innerText || '').trim() : '');
  const meta = (name) => {
    const el = document.querySelector('meta[property="' + name + '"]') || document.querySelector('meta[name="' + name + '"]');
    return el ? el.content : '';
  };
  const pageTitle = document.title || '';
  const authorFromTitle = pageTitle.split(' on X')[0].trim();
  // 页面标题形如：Yan(赚钱版) on X: "男女关系图鉴" / X —— 把引号里的标题抠出来
  const cleanTitle = (value) => {
    const match = String(value || '').match(/on X:\s*["\u201c]([^"\u201d]+)["\u201d]/);
    return (match ? match[1] : String(value || '')).trim();
  };
  // 英文界面下的日期：Sep 7, 2026 → 2026-09-07
  const englishDate = () => {
    const match = (document.body.innerText || '').match(
      /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/
    );
    if (!match) return '';
    const months = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
    return match[3] + '-' + months[match[1]] + '-' + String(match[2]).padStart(2, '0');
  };

  // ---------- 1) X 长文（Article）
  // 登录/未登录、阅读器/信息流 的容器都不一样，这里逐个尝试并取文字最多的那个
  const articleSelectors = [
    '[data-testid="twitterArticleReadView"]',
    '[data-testid="twitterArticleRichTextView"]',
    '.x-article-body',
    '[data-testid="articleReadView"]',
    'div[class*="articleBody"]',
    'div[class*="article-body"]'
  ];
  let articleBody = null;
  articleSelectors.forEach((selector) => {
    document.querySelectorAll(selector).forEach((el) => {
      const length = (el.innerText || '').length;
      if (!articleBody || length > (articleBody.innerText || '').length) articleBody = el;
    });
  });
  if (articleBody && (articleBody.innerText || '').length < 400) articleBody = null;

  if (articleBody) {
    const titleEl = document.querySelector('h1');
    const timeEl = document.querySelector('time[datetime]');
    const dateMatch = (document.body.innerText || '').match(/(\d{4}年\d{1,2}月\d{1,2}日)/);
    const video = articleBody.querySelector('video, [data-testid="videoPlayer"] video');

    // 只保留正文：丢掉开头的标题、互动数据（57 / 223 / 1.1K / 273K）、"Article"标签等
    const titleText = txt(titleEl);
    const blocks = Array.from(articleBody.children);
    let startIndex = 0;
    for (let i = 0; i < blocks.length; i += 1) {
      const el = blocks[i];
      const text = (el.innerText || '').trim();
      const isJunk =
        !text ||
        text === titleText ||
        /^[\d.,]+[KM]?$/.test(text) ||
        /^(Article|Views?)$/i.test(text) ||
        (text.length < 24 && el.querySelector('a[href*="/analytics"]'));
      if (isJunk) {
        startIndex = i + 1;
        continue;
      }
      break;
    }
    const bodyHtml = blocks
      .slice(startIndex)
      .map((el) => el.outerHTML)
      .join('');

    return {
      site: 'x',
      title: titleText || cleanTitle(meta('og:title')) || cleanTitle(pageTitle),
      author: authorFromTitle || meta('og:title'),
      date: dateMatch ? dateMatch[1] : englishDate() || (timeEl ? timeEl.getAttribute('datetime') || '' : ''),
      canonical: location.href,
      contentHtml: bodyHtml || articleBody.innerHTML,
      videos: video ? [{ url: location.href, poster: video.getAttribute('poster') || '' }] : [],
      comments: []
    };
  }

  // ---------- 2) 普通推文 / 长推文
  // 兜底保护：页面里有 h1（说明是长文阅读器）但没认出正文容器时，不要乱抓一条回复冒充正文
  const pageH1 = document.querySelector('h1');
  if (pageH1 && (pageH1.innerText || '').trim()) {
    return {
      site: 'x',
      error: '看起来是 X 长文，但没认出正文容器。请勾选"同时保存调试页面"再保存一次，把结果发我。',
      canonical: location.href
    };
  }

  const scope =
    document.querySelector('article[data-testid="tweet"]') ||
    document.querySelector('[data-testid="cellInnerDiv"] article') ||
    document;

  // X 的正文是 white-space: pre-wrap 渲染的，换行是文本里的 "\n"，不是 <br>。
  // 直接把 innerHTML 交给 Markdown 时，这些换行会被当成"HTML 里的空白"并成一个空格，
  // 整篇就挤成一坨了。这里先把文本节点里的换行换成 <br>，
  // 后面统一走既有的"换行 = 分段"规则，和公众号 / 知乎的表现保持一致。
  const withLineBreaks = (el) => {
    const clone = el.cloneNode(true);
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT, null);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    textNodes.forEach((node) => {
      const value = node.nodeValue || '';
      if (value.indexOf('\n') === -1) return;
      const fragment = document.createDocumentFragment();
      value.split(/\r?\n/).forEach((part, index) => {
        if (index > 0) fragment.appendChild(document.createElement('br'));
        if (part) fragment.appendChild(document.createTextNode(part));
      });
      node.parentNode.replaceChild(fragment, node);
    });
    return clone.innerHTML;
  };

  const textEls = Array.from(scope.querySelectorAll('[data-testid="tweetText"]'));
  let contentHtml = textEls.map((el) => withLineBreaks(el)).join('<hr>');
  if (!contentHtml) {
    const fallback = meta('og:description') || meta('twitter:description');
    if (fallback) contentHtml = '<p>' + fallback + '</p>';
  }

  const photos = Array.from(scope.querySelectorAll('[data-testid="tweetPhoto"] img, .x-article-body img'))
    .map((img) => img.getAttribute('src'))
    .filter(Boolean);
  photos.forEach((src) => {
    if (contentHtml.indexOf(src) === -1) contentHtml += '<p><img src="' + src + '" alt=""></p>';
  });

  const video = scope.querySelector('[data-testid="videoPlayer"] video, video[poster]');
  const userName = txt(scope.querySelector('[data-testid="User-Name"]'));
  const timeEl = scope.querySelector('time');
  // 尽量取这条推文自己的链接（回复页面上 location.href 有时不是它）
  const permalinkAnchor = scope.querySelector('a[href*="/status/"] time');
  const permalink = permalinkAnchor ? permalinkAnchor.closest('a').getAttribute('href') : null;

  return {
    site: 'x',
    title: (textEls.length ? txt(textEls[0]).split('\n')[0] : '') || authorFromTitle || pageTitle,
    author: userName.split('\n')[0] || authorFromTitle,
    date: timeEl ? timeEl.getAttribute('datetime') || '' : '',
    canonical: permalink ? 'https://x.com' + permalink : location.href,
    contentHtml: contentHtml,
    videos: video ? [{ url: location.href, poster: video.getAttribute('poster') || '' }] : [],
    comments: []
  };
}

/**
 * X 的"评论"：X 没有精选留言这种概念，这里取
 *   ① 作者本人的回复（带 Author 标记或昵称与文章作者一致）
 *   ② 其余回复中排在前面的几条（作为"热评"）
 * 参数 { author } 由 cli 传入（文章作者昵称）。
 */
function extractXThread(options) {
  const wantedAuthor = (options && options.author ? String(options.author) : "").trim();
  const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
  const comments = [];
  articles.forEach((article) => {
    const nameEl = article.querySelector('[data-testid="User-Name"]');
    const name = nameEl ? nameEl.innerText.replace(/\n/g, " ") : '';
    const textEl = article.querySelector('[data-testid="tweetText"]');
    if (!textEl) return;
    const isAuthor = /Author|作者/.test(article.innerText || '') || (wantedAuthor && name.indexOf(wantedAuthor) >= 0);
    const avatar = article.querySelector('[data-testid="Tweet-User-Avatar"] img, img[src*="profile_images"]');
    // 点赞数：读点赞按钮的 aria-label（形如 "1,234 Likes"）
    const likeEl = article.querySelector('[data-testid="like"], [data-testid="unlike"]');
    const likeLabel = likeEl ? likeEl.getAttribute('aria-label') || '' : '';
    const likeMatch = likeLabel.match(/([\d,]+)\s*(Likes?|次赞|喜欢)/i);
    comments.push({
      avatar: avatar ? avatar.getAttribute('src') : '',
      nick: name.split('@')[0].trim() || name,
      likes: likeMatch ? likeMatch[1].replace(/,/g, '') : ((article.innerText.match(/([\d,.]+[KM]?)\s*(次赞|likes?)/i) || [])[1] || ''),
      text: textEl.innerText.trim(),
      author: Boolean(isAuthor),
      replies: []
    });
  });
  return comments;
}

/* ---------------------------------------------------------------- 通用网页 */
function extractGeneric() {
  const meta = (name) => {
    const el = document.querySelector('meta[property="' + name + '"]') || document.querySelector('meta[name="' + name + '"]');
    return el ? el.content : '';
  };
  const txt = (el) => (el ? (el.innerText || '').trim() : '');

  let best = document.querySelector('article');
  if (!best || (best.innerText || '').length < 400) {
    let bestScore = 0;
    document.querySelectorAll('div, section, main').forEach((el) => {
      const paragraphs = el.querySelectorAll('p').length;
      const score = paragraphs > 2 ? (el.innerText || '').length : 0;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    });
  }

  const clone = best ? best.cloneNode(true) : null;
  if (clone) {
    clone.querySelectorAll('script, style, nav, aside, footer, form, .comment, .comments').forEach((el) => el.remove());
    clone.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-original');
      if (src) img.setAttribute('src', src);
    });
  }

  return {
    site: 'generic',
    title: meta('og:title') || txt(document.querySelector('h1')) || document.title,
    author: meta('author') || meta('article:author') || txt(document.querySelector('[rel="author"], .author, .byline')),
    date: meta('article:published_time') || txt(document.querySelector('time')),
    canonical: meta('og:url') || (document.querySelector('link[rel="canonical"]') || {}).href || location.href,
    contentHtml: clone ? clone.innerHTML : document.body.innerHTML,
    videos: [],
    comments: []
  };
}

// 同一份提取规则：Node（命令行采集器）用 module.exports，
// 浏览器（扩展内容脚本）用 globalThis.WZSC_EXTRACTORS。
const EXTRACTOR_API = {
  extractWeixin,
  extractZhihu,
  extractZhihuComments,
  extractWeibo,
  extractWeiboComments,
  extractX,
  extractXThread,
  extractGeneric
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = EXTRACTOR_API;
} else if (typeof globalThis !== 'undefined') {
  globalThis.WZSC_EXTRACTORS = EXTRACTOR_API;
}
