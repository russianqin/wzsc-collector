#!/usr/bin/env node
'use strict';

/**
 * 一键安装（双击「1-一键安装.cmd」跑的就是这个）：
 *   1. 记下 Node 的位置
 *   2. 检查 / 生成配置文件
 *   3. 装运行依赖（turndown，只有第一次需要）
 *   4. 用 Windows 自带的 csc.exe 编译小助手 bin\wzsc-host.exe
 *   5. 写小助手的清单文件，并登记到 Edge / Chrome / Brave
 *   6. 试跑一次：让小助手把服务拉起来，确认能连上
 *
 * 装完之后：机器上平时没有任何东西在跑；
 * 你在扩展里点一下 → 浏览器启动小助手 → 小助手把服务拉起来；
 * 不用了 → 服务闲置几分钟后自己退出。
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');

const ROOT = __dirname;
const BIN = path.join(ROOT, 'bin');
const HOST_SRC = path.join(ROOT, 'tools', 'host.cs');
const HOST_EXE = path.join(BIN, 'wzsc-host.exe');
const HOST_NAME = 'com.wzsc.collector';
const HOST_MANIFEST = path.join(BIN, HOST_NAME + '.json');
const WATCHDOG = path.join(ROOT, '启动收藏助手.vbs');
const STARTUP_LINK_VBS = path.join(ROOT, 'tools', 'startup-link.vbs');
const STARTUP_LINK = path.join(
  process.env.APPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Roaming'),
  'Microsoft',
  'Windows',
  'Start Menu',
  'Programs',
  'Startup',
  '收藏助手（随浏览器启动）.lnk'
);
// manifest.json 里的 key 决定了扩展 ID 是固定的，这里必须一致
const EXTENSION_ID = 'blgbhlgdlgdfdhnfdnpabchipcdjbjkk';
const CSC_CANDIDATES = [
  path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
];
const REG_KEYS = [
  'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\' + HOST_NAME,
  'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\' + HOST_NAME,
  'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\' + HOST_NAME
];

function step(index, total, text) {
  console.log('');
  console.log('[' + index + '/' + total + '] ' + text);
}

function fail(text) {
  console.log('');
  console.log('出错了：' + text);
  process.exit(1);
}

async function waitForService(seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    for (let port = 8765; port <= 8768; port += 1) {
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/health', { cache: 'no-store' });
        if (response.ok) {
          const data = await response.json();
          if (data && data.ok) return data;
        }
      } catch (error) {
        /* 还没起来 */
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  return null;
}

/** 用"原生消息"的格式跟小助手说一句话，顺便验证它能不能把服务拉起来 */
async function smokeTest() {
  const payload = Buffer.from(JSON.stringify({ action: 'start' }), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  const result = spawnSync(HOST_EXE, [], { input: Buffer.concat([header, payload]), timeout: 15000 });
  if (result.error) return '小助手没跑起来：' + result.error.message;
  const stdout = result.stdout || Buffer.alloc(0);
  if (stdout.length < 4) return '小助手没有回话';
  const size = stdout.readUInt32LE(0);
  const text = stdout.slice(4, 4 + size).toString('utf8');
  const health = await waitForService(15);
  if (!health) return '小助手回话是 ' + text + '，但服务还没连上';
  return null;
}

async function main() {
  console.log('==============================================');
  console.log('  文章收藏助手 · 一键安装（只做一次）');
  console.log('==============================================');

  step(1, 7, '记下 Node 的位置');
  fs.writeFileSync(path.join(ROOT, 'node-path.txt'), process.execPath, 'utf8');
  console.log('    ' + process.execPath);

  step(2, 7, '检查配置文件 config.json');
  const configFile = path.join(ROOT, 'config.json');
  if (fs.existsSync(configFile)) {
    let repo = '(读不出来)';
    try {
      repo = JSON.parse(fs.readFileSync(configFile, 'utf8')).repoPath;
    } catch (error) {
      /* 忽略 */
    }
    console.log('    已存在，收藏仓库：' + repo);
  } else {
    const guess = path.join(process.env.USERPROFILE || '.', 'Desktop', 'WenZhangShouCang');
    fs.writeFileSync(
      configFile,
      JSON.stringify(
        {
          repoPath: guess,
          assetsDirName: 'assets',
          images: 'keep-remote',
          includeComments: true,
          commentFilter: 'author',
          video: 'poster',
          maxComments: 50
        },
        null,
        2
      ),
      'utf8'
    );
    console.log('    没找到，已按默认值生成：' + guess);
    console.log('    （如果不对，用记事本改 config.json 里的 repoPath）');
  }

  step(3, 7, '安装运行依赖（只有第一次需要，约 10 秒）');
  // 用一整条命令（不传 args）可以避免 Node 关于 shell 的告警
  const npm = spawnSync('npm install --omit=dev --no-audit --no-fund', {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true
  });
  if (npm.status !== 0) fail('依赖没装上。把上面的提示复制发我。');

  step(4, 7, '编译小助手（bin\\wzsc-host.exe）');
  fs.mkdirSync(BIN, { recursive: true });
  const csc = CSC_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (!csc) fail('没找到 Windows 自带的 csc.exe，编译不了小助手。');
  const compile = spawnSync(
    csc,
    ['/nologo', '/target:exe', '/out:' + HOST_EXE, '/reference:System.dll', HOST_SRC],
    { cwd: ROOT, encoding: 'utf8' }
  );
  if (compile.status !== 0 || !fs.existsSync(HOST_EXE)) {
    fail('编译失败：' + (compile.stdout || '') + (compile.stderr || ''));
  }
  console.log('    编译完成：' + HOST_EXE + '（' + fs.statSync(HOST_EXE).size + ' 字节）');

  step(5, 7, '登记到浏览器（Edge / Chrome / Brave，只改当前用户）');
  fs.writeFileSync(
    HOST_MANIFEST,
    JSON.stringify(
      {
        name: HOST_NAME,
        description: '文章收藏助手的本机小助手：按需启动本机服务',
        path: HOST_EXE,
        type: 'stdio',
        allowed_origins: ['chrome-extension://' + EXTENSION_ID + '/']
      },
      null,
      2
    ),
    'utf8'
  );
  const failed = [];
  REG_KEYS.forEach((key) => {
    const result = spawnSync('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', HOST_MANIFEST, '/f'], {
      encoding: 'utf8'
    });
    const output = String(result.stdout || '') + String(result.stderr || '');
    if (result.status !== 0) failed.push(key.split('\\')[2] + '：' + output.trim());
  });
  if (failed.length) {
    console.log('    有浏览器登记失败（不影响其它部分）：');
    failed.forEach((item) => console.log('      · ' + item));
    console.log('    如果扩展一直提示服务没起来，把这里的提示发我。');
  } else {
    console.log('    已登记（扩展 ID：' + EXTENSION_ID + '）');
  }

  step(6, 7, '设置成"随浏览器自动启动"（开机启动 + 隐藏窗口）');
  try {
    execFileSync('cscript', ['//nologo', STARTUP_LINK_VBS, 'add', STARTUP_LINK, WATCHDOG], { stdio: 'inherit' });
    spawn('wscript.exe', [WATCHDOG], { detached: true, stdio: 'ignore' }).unref();
    console.log('    已加入开机启动，并立刻启动一次（看不到窗口是正常的）');
  } catch (error) {
    console.log('    设置开机启动失败（不影响手动使用）：' + error.message);
  }

  step(7, 7, '试跑一次：确认服务已经待命');
  const problem = await smokeTest();
  if (problem) {
    console.log('    没成功：' + problem);
    console.log('    可以双击「2-取消随浏览器启动.cmd」清掉，然后把上面的内容发我。');
  } else {
    console.log('    成功 ✔ 本机服务已经能正常被唤起');
  }

  console.log('');
  console.log('==============================================');
  console.log('安装完成！');
  console.log('');
  console.log('平时怎么用：');
  console.log('  看到好文章 → 点浏览器右上角的扩展图标 → 保存这篇文章');
  console.log('  （服务跟着浏览器待命，点开就能用，不用等）');
  console.log('');
  console.log('最后一步（只在第一次，必须做）：在浏览器里重新加载扩展');
  console.log('  1. Edge 打开 edge://extensions');
  console.log('  2. 如果「文章收藏助手」还能看到，先点【移除】把它删掉');
  console.log('  3. 点【加载解压缩的扩展】，选本文件夹（' + ROOT + '）');
  console.log('     （因为这次的扩展 ID 固定成了 ' + EXTENSION_ID + '，必须重新加载一次）');
  console.log('==============================================');
}

main().catch((error) => fail(error.message));
