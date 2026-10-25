/**
 * 页面内的"准备工作"，分两个阶段：
 *   content  阶段：只做最小的展开/滚动，**先把正文读出来**（X 这类站点滚动后会把正文从 DOM 卸载）
 *   comments 阶段：再滚到底部、点开评论区、加载更多评论
 * 同一份文件既能当扩展的内容脚本，也能被 Node 引用。
 */
(function (root) {
  'use strict';

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * 按钮文字归一化：去掉零宽字符、压平空白。
   * 知乎的"61 条评论"前面常夹一个不可见的 U+200B，
   * 不处理的话 /^\d+\s*条评论$/ 这种匹配会全部落空。
   */
  function normalizeLabel(text) {
    return String(text || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  async function autoScroll(rounds) {
    for (let i = 0; i < rounds; i += 1) {
      window.scrollBy(0, Math.round(window.innerHeight * 0.9));
      await sleep(600);
    }
    window.scrollTo(0, 0);
    await sleep(400);
  }

  function clickByText(selector, pattern, max = 1) {
    let clicked = 0;
    for (const node of Array.from(document.querySelectorAll(selector))) {
      if (clicked >= max) break;
      if (pattern.test(normalizeLabel(node.innerText)) && node.click) {
        node.click();
        clicked += 1;
      }
    }
    return clicked;
  }

  function findZhihuCard() {
    const answerId = (location.pathname.match(/answer\/(\d+)/) || [])[1];
    if (!answerId) return null;
    return (
      document.querySelector('[data-zop*=\'"itemId":"' + answerId + '"\']') || document.querySelector('[data-zop*="' + answerId + '"]')
    );
  }

  /* ---------------- 阶段一：打开正文 ---------------- */

  async function contentWeixin() {
    clickByText('a, span', /^(阅读全文|展开)$/);
    await autoScroll(3);
  }

  async function contentZhihu() {
    const card = findZhihuCard();
    if (card) {
      card.scrollIntoView({ block: 'center' });
      const expand = Array.from(card.querySelectorAll('button, a')).find((el) => /阅读全文|展开/.test(el.innerText || ''));
      if (expand) expand.click();
      await sleep(1500);
    }
    await autoScroll(2);
  }

  async function contentWeibo() {
    clickByText('a, span', /展开全文|全文/);
    await autoScroll(2);
  }

  async function contentX() {
    // 只滚两轮让图片加载，避免正文被虚拟列表卸载
    await autoScroll(2);
    clickByText('div[role="button"], button, span, a', /^(Show more|显示更多|展开)$/);
    await sleep(1000);
    await autoScroll(2);
  }

  async function contentGeneric() {
    await autoScroll(2);
  }

  /* ---------------- 阶段二：加载评论 ---------------- */

  async function commentsZhihu() {
    const card = findZhihuCard() || document.querySelector('.ContentItem.AnswerItem, .AnswerCard');

    // 评论面板有时是默认收起的。先在页面里等一会儿看有没有已经渲染出来的评论，
    // 没有再去点"打开评论"的入口——不能一上来就盲点，本来开着反而会被点关。
    if (!(await waitForZhihuComments(1500))) {
      const trigger = findZhihuCommentTrigger(card);
      if (trigger) trigger.click();
      if (!(await waitForZhihuComments(5000)) && card) {
        // 还没出来：把回答底部滚进视野再试一次（评论区一般就挂在回答下面）
        card.scrollIntoView({ block: 'end' });
        await sleep(800);
        const retry = findZhihuCommentTrigger(card);
        if (retry) retry.click();
        await waitForZhihuComments(5000);
      }
    }

    // 评论区里"展开回复 / 查看更多"之类的按钮
    for (let i = 0; i < 3; i += 1) {
      if (!clickByText('button', /查看全部\s*\d*\s*条回复|展开.*回复/)) break;
      await sleep(1200);
    }
    for (let i = 0; i < 3; i += 1) {
      if (!clickByText('button, a, span', /更多评论|加载更多|查看全部评论|展开更多/)) break;
      await sleep(1200);
    }
  }

  /** 评论区渲染出来没有（返回目前的评论条数） */
  function zhihuCommentCount() {
    return document.querySelectorAll('.CommentContent').length;
  }

  /** 等评论区出现，最多等 ms 毫秒 */
  async function waitForZhihuComments(ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (zhihuCommentCount() > 0) return true;
      await sleep(300);
    }
    return zhihuCommentCount() > 0;
  }

  /**
   * 找"打开评论"的入口：先在回答卡片里找，找不到再在整页找。
   * 知乎不同版本、不同入口（问题页 / 回答页 / 浮动面板）长得不一样，
   * 这里只认"像评论数"的文字，避免点到别的东西。
   */
  function findZhihuCommentTrigger(card) {
    const score = (el) => {
      const text = normalizeLabel(el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '');
      if (!text || text.length > 20) return 0;
      if (/^查看全部\s*\d*\s*条评论$/.test(text)) return 5;
      if (/^\d+\s*条评论$/.test(text)) return 4;
      if (/^评论\s*\d+$/.test(text)) return 3;
      if (text === '评论' || text === '添加评论') return 2;
      return 0;
    };
    const pick = (root) => {
      if (!root || !root.querySelectorAll) return null;
      let best = null;
      let bestScore = 0;
      Array.from(root.querySelectorAll('button, a, [role="button"]')).forEach((el) => {
        const value = score(el);
        if (value > bestScore) {
          best = el;
          bestScore = value;
        }
      });
      return best;
    };
    return pick(card) || pick(document);
  }

  async function commentsWeibo() {
    await autoScroll(2);
    for (let i = 0; i < 4; i += 1) {
      const clicked = clickByText('a, span, button', /查看更多|加载更多|展开更多/);
      window.scrollBy(0, Math.round(window.innerHeight * 1.2));
      await sleep(1200);
      if (!clicked && i >= 2) break;
    }
    window.scrollTo(0, 0);
  }

  async function commentsX() {
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(2000);
    for (let i = 0; i < 5; i += 1) {
      const clicked = clickByText(
        'div[role="button"], button, span, a',
        /^(Show more replies|Show replies|显示更多回复|查看更多回复)$/
      );
      window.scrollBy(0, Math.round(window.innerHeight * 1.2));
      await sleep(1500);
      if (!clicked && i >= 2) break;
    }
    // X 会把长推文 / 长回复折叠成"显示更多"，折叠状态下 DOM 里只有一截预览文本，
    // 回去读评论时就会从中间断掉。所以读之前先把页面上折叠的内容全部展开。
    await expandFoldedTweets();
  }

  /** 点开所有"显示更多"：每轮重新查一次，直到页面上再没有可点的为止 */
  async function expandFoldedTweets(rounds, perRound) {
    const total = rounds || 4;
    const each = perRound || 10;
    for (let i = 0; i < total; i += 1) {
      const clicked = clickByText(
        'div[role="button"], button, span, a',
        /^(Show more|显示更多|展开|展开全文|查看更多)$/,
        each
      );
      if (!clicked) return;
      await sleep(900);
    }
  }

  const PREPARE_API = {
    weixin: { content: contentWeixin, comments: null },
    zhihu: { content: contentZhihu, comments: commentsZhihu },
    weibo: { content: contentWeibo, comments: commentsWeibo },
    x: { content: contentX, comments: commentsX },
    generic: { content: contentGeneric, comments: null }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = PREPARE_API;
  } else if (typeof globalThis !== 'undefined') {
    globalThis.WZSC_PREPARE = PREPARE_API;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
