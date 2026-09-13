'use strict';

const extractors = require('./extractors');

/**
 * 微信内置浏览器的 User-Agent。
 * 评论接口会做风控：用普通桌面浏览器的身份去调，会被挡在「验证」页；
 * 换成 MicroMessenger 身份后，更接近微信客户端里的真实请求。
 */
const WECHAT_UA =
  'Mozilla/5.0 (Linux; Android 13; PGT-AN00 Build/HUAWEIPGT-AN00; wv) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 XWEB/1160113 MMWEBSDK/20240301 MicroMessenger/8.0.49.2600(0x2800313D) ' +
  'WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64';

/**
 * 微信公众号的留言：网页版不渲染，但文章页面里内联了接口参数
 * （__biz / appmsgid / comment_id），微信客户端就是调 mp/appmsg_comment 渲染留言的。
 * 这里用 Playwright 的请求上下文去取（带 cookie + Referer），取不到就返回空数组。
 */
function mapWeixinComments(data) {
  const list = data && (data.elected_comment || data.comment || []);
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => ({
      avatar: item.avatar || '',
      nick: item.nick_name || '',
      likes: item.like_num ? String(item.like_num) : '',
      text: (item.content || '').trim(),
      author: false,
      replies: item.reply
        ? [
            {
              avatar: item.reply.avatar || '',
              nick: item.reply.nick_name || '',
              likes: item.reply.like_num ? String(item.reply.like_num) : '',
              text: (item.reply.content || '').trim(),
              author: true,
              replies: []
            }
          ]
        : []
    }))
    .filter((comment) => comment.text);
}

async function fetchWeixinComments(page, context) {
  const params = await page.evaluate(() => {
    const html = document.documentElement.outerHTML;
    const pick = (re) => {
      const m = html.match(re);
      return m ? m[1] : null;
    };
    return {
      biz: pick(/biz\s*[:=]\s*["'](Mz[A-Za-z0-9+/=]{6,})/),
      appmsgid: pick(/appmsgid\s*[:=]\s*["']?(\d{6,})/),
      commentId: pick(/comment_id\s*[:=]\s*['"]?(\d{6,})/),
      idx: pick(/\bidx\s*[:=]\s*["']?(\d+)/) || '1'
    };
  });
  if (!params.biz || !params.appmsgid) {
    console.log('  （页面里没找到评论接口参数，跳过公众号留言）');
    return [];
  }

  const url =
    'https://mp.weixin.qq.com/mp/appmsg_comment?action=getcomment&scene=0&__biz=' +
    encodeURIComponent(params.biz) +
    '&appmsgid=' +
    params.appmsgid +
    '&idx=' +
    params.idx +
    '&comment_id=' +
    (params.commentId || '') +
    '&offset=0&limit=100&is_need_comment=1';

  // 方式一：在页面内部发请求（最接近微信客户端的调用方式，带完整页面上下文与 cookie）
  try {
    const text = await page.evaluate(async (target) => {
      const response = await fetch(target, {
        credentials: 'include',
        headers: { 'X-Requested-With': 'XMLHttpRequest' }
      });
      return await response.text();
    }, url);
    try {
      const parsed = JSON.parse(text);
      const comments = mapWeixinComments(parsed);
      if (comments.length > 0) {
        console.log('  （公众号留言：页面内请求成功）');
        return comments;
      }
    } catch {
      console.log('  （页面内请求没拿到 JSON，返回片段：' + text.replace(/\s+/g, ' ').slice(0, 70) + '）');
    }
  } catch (error) {
    console.log('  （页面内请求失败：' + error.message + '）');
  }

  // 方式二：用 Playwright 的请求上下文再试一次
  try {
    const response = await context.request.get(url, {
      headers: { Referer: page.url(), 'X-Requested-With': 'XMLHttpRequest' }
    });
    const text = await response.text();
    const comments = mapWeixinComments(JSON.parse(text));
    if (comments.length > 0) {
      console.log('  （公众号留言：请求上下文调用成功）');
      return comments;
    }
  } catch (error) {
    console.log('  （公众号留言接口调用失败：' + error.message + '）');
  }
  return [];
}

const SITES = [
  {
    id: 'weixin',
    label: '微信公众号',
    test: (host) => host === 'mp.weixin.qq.com',
    referer: 'https://mp.weixin.qq.com/',
    userAgent: WECHAT_UA,
    extract: extractors.extractWeixin,
    fetchComments: fetchWeixinComments,
    prepare: async (page) => {
      // 触发懒加载图片 + 展开"阅读全文"
      await page.evaluate(() => {
        const more = document.querySelector('#js_content .js_show_more, a.read_more');
        if (more && more.click) more.click();
      }).catch(() => {});
      await autoScroll(page, 3);
    },
    prepareComments: null
  },
  {
    id: 'zhihu',
    label: '知乎',
    test: (host) => /zhihu\.com$/.test(host),
    referer: 'https://www.zhihu.com/',
    extract: extractors.extractZhihu,
    extractComments: extractors.extractZhihuComments,
    prepare: async (page) => {
      const answerId = (page.url().match(/answer\/(\d+)/) || [])[1];
      if (answerId) {
        await page
          .evaluate((id) => {
            const card =
              document.querySelector('[data-zop*=\'"itemId":"' + id + '"\']') ||
              document.querySelector('[data-zop*="' + id + '"]');
            if (!card) return;
            card.scrollIntoView({ block: 'center' });
            const expand = Array.from(card.querySelectorAll('button, a')).find((el) => /阅读全文|展开/.test(el.innerText || ''));
            if (expand) expand.click();
          }, answerId)
          .catch(() => {});
        await page.waitForTimeout(1500);
      }
      await autoScroll(page, 2);
    },
    // 阶段二：点开评论、展开子回复、加载更多（正文已经在阶段一读完了）
    prepareComments: async (page) => {
      const answerId = (page.url().match(/answer\/(\d+)/) || [])[1];
      await page
        .evaluate((id) => {
          const card = id
            ? document.querySelector('[data-zop*=\'"itemId":"' + id + '"\']') || document.querySelector('[data-zop*="' + id + '"]')
            : document.querySelector('.ContentItem.AnswerItem, .AnswerCard');
          if (!card) return;
          const button = Array.from(card.querySelectorAll('button')).find((el) => /评论/.test(el.innerText || ''));
          if (button) button.click();
        }, answerId)
        .catch(() => {});
      await page.waitForTimeout(2500);

      // 展开"查看全部 N 条回复"（作者本人的回复常在这些子回复里）
      for (let i = 0; i < 3; i += 1) {
        const expanded = await page
          .evaluate(() => {
            const more = Array.from(document.querySelectorAll('button')).find((el) =>
              /查看全部\s*\d*\s*条回复|展开.*回复/.test(el.innerText || '')
            );
            if (more) {
              more.click();
              return true;
            }
            return false;
          })
          .catch(() => false);
        if (!expanded) break;
        await page.waitForTimeout(1800);
      }

      // 3) 尽量多加载一些评论
      for (let i = 0; i < 4; i += 1) {
        const clicked = await page.evaluate(() => {
          const more = Array.from(document.querySelectorAll('button, a, span')).find((el) =>
            /更多评论|加载更多|查看全部评论|展开更多/.test(el.innerText || '')
          );
          if (more) {
            more.click();
            return true;
          }
          return false;
        }).catch(() => false);
        if (!clicked) break;
        await page.waitForTimeout(1500);
      }
    }
  },
  {
    id: 'weibo',
    label: '新浪微博',
    test: (host) => /(^|\.)weibo\.(com|cn)$/.test(host),
    referer: 'https://weibo.com/',
    extract: extractors.extractWeibo,
    extractComments: extractors.extractWeiboComments,
    prepare: async (page) => {
      await page.evaluate(() => {
        const expand = Array.from(document.querySelectorAll('a, span')).find((el) => /展开全文|全文/.test(el.innerText || ''));
        if (expand) expand.click();
      }).catch(() => {});
      await autoScroll(page, 2);
    },
    prepareComments: async (page) => {
      for (let i = 0; i < 5; i += 1) {
        const clicked = await page.evaluate(() => {
          const more = Array.from(document.querySelectorAll('a, span, button')).find((el) =>
            /查看更多|加载更多|展开更多/.test(el.innerText || '')
          );
          if (more) {
            more.click();
            return true;
          }
          return false;
        }).catch(() => false);
        if (!clicked) break;
        await page.waitForTimeout(1200);
      }
      await autoScroll(page, 4);
    }
  },
  {
    id: 'x',
    label: 'X (Twitter)',
    test: (host) => /(^|\.)(x\.com|twitter\.com)$/.test(host),
    referer: 'https://x.com/',
    extract: extractors.extractX,
    extractComments: extractors.extractXThread,
    // 阶段一：只滚两轮让图片加载（滚太远 X 会把正文从 DOM 卸载），并点开"Show more"
    prepare: async (page) => {
      await autoScroll(page, 2);
      await page
        .evaluate(() => {
          const more = Array.from(document.querySelectorAll('button, div[role="button"], span, a')).find((el) =>
            /^(Show more|显示更多|展开)$/.test((el.innerText || '').trim())
          );
          if (more && more.click) more.click();
        })
        .catch(() => {});
      await page.waitForTimeout(1000);
      await autoScroll(page, 2);
    },
    // 阶段二：滚到底部加载回复，并展开"显示更多回复"
    prepareComments: async (page) => {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      await page.waitForTimeout(2000);
      for (let i = 0; i < 4; i += 1) {
        const clicked = await page
          .evaluate(() => {
            const more = Array.from(document.querySelectorAll('div[role="button"], button, span, a')).find((el) =>
              /^(Show more replies|Show replies|显示更多回复|查看更多回复)$/.test((el.innerText || '').trim())
            );
            if (more) {
              more.click();
              return true;
            }
            return false;
          })
          .catch(() => false);
        await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.2)).catch(() => {});
        await page.waitForTimeout(1500);
        if (!clicked && i >= 2) break;
      }
    }
  },
  {
    id: 'generic',
    label: '通用网页',
    test: () => true,
    referer: null,
    extract: extractors.extractGeneric,
    extractComments: null,
    prepare: async (page) => {
      await autoScroll(page, 3);
    },
    prepareComments: null
  }
];

async function autoScroll(page, rounds = 4) {
  for (let i = 0; i < rounds; i += 1) {
    await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.9))).catch(() => {});
    await page.waitForTimeout(600);
  }
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(400);
}

function pickSite(url) {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    host = '';
  }
  return SITES.find((site) => site.test(host)) || SITES[SITES.length - 1];
}

/** 只保留"精选"或"与作者有互动"的评论；都分不清时就退回前 N 条 */
function filterComments(comments, config) {
  if (!comments || comments.length === 0) return [];
  if (config.commentFilter === 'none') return [];
  if (config.commentFilter === 'all') return comments.slice(0, config.maxComments);
  const curated = comments.filter((comment) => comment.author || comment.likes);
  if (curated.length > 0) return curated.slice(0, config.maxComments);
  return comments.slice(0, Math.min(10, config.maxComments));
}

module.exports = { SITES, pickSite, filterComments, autoScroll };
