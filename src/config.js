'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const DEFAULTS = {
  repoPath: '.',
  assetsDirName: 'assets',
  images: 'download',
  includeComments: true,
  commentFilter: 'author',
  video: 'poster',
  browserChannel: 'msedge',
  userDataDir: '.browser-profile',
  headless: false,
  delaySeconds: [5, 12],
  maxComments: 50,
  filenameTemplate: '{num}.{title}'
};

function loadConfig(explicitPath) {
  const candidates = [explicitPath, path.join(ROOT, 'config.json'), path.join(ROOT, 'config.example.json')].filter(Boolean);
  const file = candidates.find((candidate) => fs.existsSync(candidate));
  if (!file) {
    throw new Error('找不到配置文件，请先复制 config.example.json 为 config.json');
  }
  const config = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  config.configFile = file;
  config.repoPath = path.resolve(config.repoPath);
  config.userDataDir = path.resolve(ROOT, config.userDataDir);
  // 允许临时指定仓库（调试/多仓库时用）
  if (process.env.WZSC_REPO) config.repoPath = path.resolve(process.env.WZSC_REPO);
  return config;
}

module.exports = { loadConfig, ROOT, DEFAULTS };
