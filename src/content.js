'use strict';

/**
 * 内容脚本：扩展点「保存」时执行——
 * 先在页面里做准备工作（滚动/展开全文/点开评论），再调用共用提取规则。
 */

function detectSite(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^www\./, '');
  if (host === 'mp.weixin.qq.com') return 'weixin';
  if (/zhihu\.com$/.test(host)) return 'zhihu';
  if (/(^|\.)weibo\.(com|cn)$/.test(host)) return 'weibo';
  if (/(^|\.)(x|twitter)\.com$/.test(host)) return 'x';
  return 'generic';
}

async function collectPage(options) {
  const site = detectSite(location.hostname);
  const phases = (globalThis.WZSC_PREPARE || {})[site] || {};

  // 阶段一：先把正文准备好并读出来（X 会把滚出视口的正文从 DOM 卸载，所以必须先读）
  if (phases.content) {
    try {
      await phases.content();
    } catch (error) {
      console.warn('[wzsc] 正文准备出错（忽略）:', error);
    }
  }

  const extractors = globalThis.WZSC_EXTRACTORS || {};
  const mapping = {
    weixin: 'extractWeixin',
    zhihu: 'extractZhihu',
    weibo: 'extractWeibo',
    x: 'extractX',
    generic: 'extractGeneric'
  };
  const fn = extractors[mapping[site] || 'extractGeneric'];
  const entry = fn ? fn() : { site, title: document.title, contentHtml: document.body.innerHTML, comments: [] };
  if (!entry || entry.error) {
    throw new Error((entry && entry.error) || '提取失败');
  }

  // 趁正文还在 DOM 里，先留一份快照（X 会在滚动后把正文卸载）
  const wantDebug = Boolean(options && options.debugHtml);
  const debugSnapshot = wantDebug
    ? { page: document.documentElement.outerHTML, content: entry.contentHtml || '' }
    : null;

  // 阶段二：再滚下去加载评论
  let comments = [];
  try {
    if (phases.comments) await phases.comments();
    if (site === 'zhihu' && extractors.extractZhihuComments) {
      comments = extractors.extractZhihuComments({ author: entry.author });
    } else if (site === 'weibo' && extractors.extractWeiboComments) {
      comments = extractors.extractWeiboComments();
    } else if (site === 'x' && extractors.extractXThread) {
      comments = extractors.extractXThread({ author: entry.author });
    }
  } catch (error) {
    console.warn('[wzsc] 评论提取出错（忽略）:', error);
  }

  const result = Object.assign({}, entry, {
    comments: comments,
    siteId: site,
    pageUrl: location.href,
    extensionVersion: typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest
      ? chrome.runtime.getManifest().version
      : 'unknown'
  });
  // 调试模式：把页面源码一起带回去（用于排查抓取规则）
  if (debugSnapshot) {
    result.debugHtml = debugSnapshot.page;
    result.debugContentHtml = debugSnapshot.content;
  }
  // 调试模式（X）：评论是滚动之后才渲染出来的，开头那份快照里通常没有它们。
  // 这里补一份"评论加载完之后"的推文快照，评论被折叠 / 截断时才有据可查。
  if (wantDebug && site === 'x') {
    try {
      result.debugTweetsHtml = Array.from(document.querySelectorAll('article[data-testid="tweet"]'))
        .map((article) => article.outerHTML)
        .join('\n<!-- tweet -->\n');
    } catch (error) {
      console.warn('[wzsc] 推文快照出错（忽略）:', error);
    }
  }
  return result;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'collect') return undefined;
  collectPage({ debugHtml: Boolean(message.debugHtml) })
    .then((data) => sendResponse({ ok: true, data: data }))
    .catch((error) => sendResponse({ ok: false, error: String((error && error.message) || error) }));
  return true; // 异步响应
});
