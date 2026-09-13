'use strict';

const statusEl = document.getElementById('status');
const resultEl = document.getElementById('result');
const saveBtn = document.getElementById('save');
const hintEl = document.querySelector('.hint');
const debugEl = document.getElementById('debug');

chrome.runtime.sendMessage({ type: 'health' }, (response) => {
  if (response && response.ok) {
    statusEl.innerHTML = '本机服务已连接 ✔<br>版本 ' + (response.version || '?') + '（端口 ' + (response.base || '').replace('http://127.0.0.1:', '') + '）';
    saveBtn.disabled = false;
    if (hintEl) hintEl.style.display = 'none';
  } else {
    statusEl.innerHTML = '<b>本机服务未启动</b><br>请先双击项目里的「启动收藏服务.cmd」';
    saveBtn.disabled = true;
    if (hintEl) hintEl.style.display = 'block';
  }
});

/** 给页面发采集指令；如果内容脚本没注入（页面在装扩展之前打开），自动注入后重试 */
async function requestCollect(tabId, debugHtml) {
  const trySend = () =>
    new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { type: 'collect', debugHtml: Boolean(debugHtml) }, (response) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(response || { ok: false, error: '页面没有响应' });
      });
    });

  let response = await trySend();
  if (response && response.ok) return response;

  // 兜底：手动注入一次（需要用户点扩展时授予的 activeTab 权限）
  await new Promise((resolve) => {
    chrome.scripting.executeScript(
      { target: { tabId: tabId }, files: ['src/extractors.js', 'src/prepare-dom.js', 'src/content.js'] },
      () => resolve()
    );
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  response = await trySend();
  return response;
}

saveBtn.addEventListener('click', async () => {
  saveBtn.disabled = true;
  resultEl.textContent = '正在提取页面内容（滚动、展开全文与评论）…';

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    resultEl.textContent = '没找到当前标签页。';
    saveBtn.disabled = false;
    return;
  }

  const collected = await requestCollect(tab.id, debugEl && debugEl.checked);
  if (!collected || !collected.ok) {
    resultEl.textContent =
      '提取失败：' +
      ((collected && collected.error) || '未知错误') +
      '\n\n请按 F5 刷新一下当前页面再试（有些页面不允许扩展注入，例如浏览器内置页面）。';
    saveBtn.disabled = false;
    return;
  }

  resultEl.textContent = '正在保存（下载图片）…';
  chrome.runtime.sendMessage({ type: 'save', payload: collected.data }, (saved) => {
    saveBtn.disabled = false;
    if (saved && saved.ok) {
      resultEl.innerHTML =
        '已保存 ✔\n' +
        saved.file +
        '\n' +
        saved.chars +
        ' 字 · 图片 ' +
        saved.images +
        ' · 评论 ' +
        saved.comments +
        '\n\n位置：' +
        (saved.filePath || saved.repo || '');
    } else {
      resultEl.textContent = '保存失败：' + ((saved && saved.error) || '未知错误');
    }
  });
});

const openRepoBtn = document.getElementById('openRepo');
openRepoBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'openRepo' }, (response) => {
    if (response && response.ok) resultEl.textContent = '已打开收藏仓库文件夹：\n' + response.repo;
    else resultEl.textContent = '打开失败：' + ((response && response.error) || '请确认本机服务在运行');
  });
});
