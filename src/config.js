'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const DEFAULTS = {
  repoPath: '.',
  assetsDirName: 'assets',
  images: 'keep-remote',
  includeComments: true,
  commentFilter: 'author',
  video: 'poster',
  maxComments: 50
};

function loadConfig(explicitPath) {
  const candidates = [explicitPath, path.join(ROOT, 'config.json'), path.join(ROOT, 'config.example.json')].filter(Boolean);
  const file = candidates.find((candidate) => fs.existsSync(candidate));
  if (!file) {
    throw new Error('找不到配置文件，请把 config.example.json 复制成 config.json 并填好 repoPath');
  }
  const config = Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(file, 'utf8')));
  config.configFile = file;
  config.repoPath = path.resolve(config.repoPath);
  // 允许临时指定仓库（测试时用）
  if (process.env.WZSC_REPO) config.repoPath = path.resolve(process.env.WZSC_REPO);
  return config;
}

module.exports = { loadConfig, ROOT, DEFAULTS };
