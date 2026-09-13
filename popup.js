'use strict';

const statusEl = document.getElementById('status');
const resultEl = document.getElementById('result');
const saveBtn = document.getElementById('save');
const debugEl = document.getElementById('debug');

function ask(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(response || { ok: false, error: '没有响应' });
    });
  });
}

// 服务平时是不跑的：打开弹窗时先"叫醒"它（浏览器会启动小助手），
// 第一次大概要 1~2 秒，所以这里多试几次，别一上来就说没连上。
async function connect(tries = 4) {
  for (let i = 0; i < tries; i += 1) {
    statusEl.innerHTML = i === 0 ? '正在叫醒本机服务…' : '正在等本机服务起来…（' + (i + 1) + '/' + tries + '）';
    const response = await ask({ type: 'health' });
    if (response && response.ok) return response;
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  return null;
}

async function refreshStatus() {
  const service = await connect();
  if (service) {
    const port = String(service.base || '').replace('http://127.0.0.1:', '');
    statusEl.innerHTML = '本机服务已连接 ✔<br>版本 ' + (service.version || '?') + '（端口 ' + port + '）';
    saveBtn.disabled = false;
    return true;
  }
  statusEl.innerHTML =
    '<b>没连上本机服务</b><br>' +
    '· 刚开机的话：等几秒，再点一下上面的按钮<br>' +
    '· 一直这样：双击项目里的「1-一键安装.cmd」';
  saveBtn.disabled = true;
  return false;
}

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
  return trySend();
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

  resultEl.textContent = '正在保存…';
  const saved = await ask({ type: 'save', payload: collected.data });
  saveBtn.disabled = false;
  if (saved && saved.ok) {
    resultEl.textContent =
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

document.getElementById('openRepo').addEventListener('click', async () => {
  const response = await ask({ type: 'openRepo' });
  if (response && response.ok) resultEl.textContent = '已打开收藏仓库文件夹：\n' + response.repo;
  else resultEl.textContent = '打开失败：' + ((response && response.error) || '本机服务没连上');
});

document.getElementById('pasteSave').addEventListener('click', async () => {
  const number = document.getElementById('pasteNumber').value.trim();
  const text = document.getElementById('pasteText').value;
  if (!number) {
    resultEl.textContent = '请先填文章编号（例如 478）。';
    return;
  }
  if (!text.trim()) {
    resultEl.textContent = '请先把微信里的留言粘贴到下面的框里。';
    return;
  }
  resultEl.textContent = '正在写入…';
  const response = await ask({ type: 'pasteComments', number: number, text: text });
  if (response && response.ok) {
    const preview = (response.preview || [])
      .map((item) => '  · ' + item.nick + (item.author ? '（作者）' : '') + '：' + item.text)
      .join('\n');
    resultEl.textContent =
      '已写入 ' +
      response.file +
      '（' +
      response.count +
      ' 条' +
      (response.replaced ? '，替换了原有留言' : '') +
      '）\n' +
      preview;
    document.getElementById('pasteText').value = '';
  } else {
    resultEl.textContent = '写入失败：' + ((response && response.error) || '未知错误');
  }
});

refreshStatus();
