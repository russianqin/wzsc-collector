#!/usr/bin/env node
'use strict';

/**
 * 取消安装（双击「2-取消随浏览器启动.cmd」）：
 * 让服务退出、删掉浏览器登记、清理旧版本留下的开机启动项。扩展本身不动。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = __dirname;
const HOST_NAME = 'com.wzsc.collector';
const REG_KEYS = [
  'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\' + HOST_NAME,
  'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\' + HOST_NAME,
  'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\' + HOST_NAME
];

function killByCommandLine(processName, keyword) {
  const script = [
    '$target = $env:WZSC_KILL_KEYWORD;',
    "Get-CimInstance Win32_Process -Filter \"Name='" + processName + "'\" |",
    '  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$target*" } |',
    '  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'
  ].join(' ');
  try {
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      stdio: 'ignore',
      env: Object.assign({}, process.env, { WZSC_KILL_KEYWORD: keyword })
    });
  } catch (error) {
    /* 没杀到也没关系 */
  }
}

async function shutdownService() {
  let stopped = 0;
  for (let port = 8765; port <= 8768; port += 1) {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/shutdown', { method: 'POST' });
      if (response.ok) stopped += 1;
    } catch (error) {
      /* 没在跑 */
    }
  }
  return stopped;
}

async function main() {
  console.log('正在取消本机服务…');

  const stopped = await shutdownService();
  console.log('  已通知 ' + stopped + ' 个正在运行的服务退出');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
  killByCommandLine('node.exe', path.join('src', 'server.js'));
  console.log('  已确认后台没有残留');

  REG_KEYS.forEach((key) => {
    spawnSync('reg', ['delete', key, '/f'], { stdio: 'ignore' });
  });
  console.log('  已删掉浏览器里的登记');

  // 旧版本留下的东西（开机启动项、停止标记）一并清理
  const legacyLink = path.join(
    process.env.APPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Roaming'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
    '收藏助手（随浏览器启动）.lnk'
  );
  if (fs.existsSync(legacyLink)) {
    fs.rmSync(legacyLink, { force: true });
    console.log('  已删除旧版留下的开机启动项');
  }
  const stopFile = path.join(ROOT, 'stop.txt');
  if (fs.existsSync(stopFile)) fs.rmSync(stopFile, { force: true });

  console.log('');
  console.log('完成。以后不会再有任何后台服务；扩展本身没动。');
  console.log('想恢复：双击「1-一键安装.cmd」。');
}

main().catch((error) => {
  console.log('出错了：' + error.message);
  process.exit(1);
});
