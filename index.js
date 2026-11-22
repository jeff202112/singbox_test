#!/usr/bin/env node
/**
 * TUIC + Hysteria2 + Reality 一键部署脚本（纯 Node.js 实现，无需 start.sh）
 *
 * 运行:  node index.js
 *
 * 所有配置都在下面的 CONFIG 中修改，也可用环境变量覆盖（环境变量优先级更高）。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawn } = require('child_process');

// ================== 端口设置 ==================
const CONFIG = {
  // 填入 tuic 节点端口；留空或 0 表示不启用
  TUIC_PORT: process.env.TUIC_PORT || '',

  // 填入 hy2 节点端口；留空或 0 表示不启用
  HY2_PORT: process.env.HY2_PORT || '',

  // 填入 reality 节点端口（UDP/TCP 可以共用 1 个端口）；留空或 0 表示不启用
  REALITY_PORT: process.env.REALITY_PORT || '30196',

  // ================== Reality 设置 ==================
  // handshake.server 必须满足：1) 支持 TLS1.3 + X25519；2) 从服务器侧能稳定访问
  // 推荐选项：www.cloudflare.com / www.bing.com / www.microsoft.com / gateway.icloud.com
  // ⚠️ 修改后客户端链接里的 sni 也会自动同步为此值
  REALITY_SNI: process.env.REALITY_SNI || 'www.cloudflare.com',

  // ================== 其它设置 ==================
  // 日志级别：trace/debug/info/warn/error/fatal，排障建议 debug；排障完毕可改回 info
  LOG_LEVEL: process.env.LOG_LEVEL || 'debug',

  // 核心缺失时的保底版本号（自动获取 release 失败时使用）
  SINGBOX_FALLBACK_VER: '1.11.4',

  // 定时重启（北京时间 00:03）
  RESTART_ENABLED: process.env.RESTART_ENABLED || 'true',
  RESTART_HOUR: 0,   // 北京时间的“时”
  RESTART_MIN: 3,    // 北京时间的“分”
  CHECK_INTERVAL_SEC: 30,
};

const ROOT = __dirname;
const FILE_PATH = path.join(ROOT, '.npm');
const DATA_PATH = path.join(ROOT, 'singbox_data');
const LOG_PATH = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_PATH, 'singbox.log');
const SINGBOX_BIN = path.join(FILE_PATH, 'sb_core');

// ---------- 小工具 ----------
const C = {
  green: (s) => `\x1b[1;32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[1;33m${s}\x1b[0m`,
  red: (s) => `\x1b[1;31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[1;36m${s}\x1b[0m`,
};

function log(msg) {
  console.log(msg);
}

function syncSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function hasCmd(cmd) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function rmrf(p, opts = {}) {
  try {
    fs.rmSync(p, { recursive: true, force: true, ...opts });
  } catch {}
}

/** 只清理目录里的内容，保留目录本身 */
function cleanDir(dir) {
  try {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      rmrf(path.join(dir, name));
    }
  } catch {}
}

function download(url, filename) {
  if (hasCmd('curl')) {
    execFileSync('curl', ['-L', '-sS', '-o', filename, url], { stdio: ['ignore', 'ignore', 'inherit'] });
    log(C.green(`下载 ${filename} (curl)`));
  } else if (hasCmd('wget')) {
    execFileSync('wget', ['-q', '-O', filename, url], { stdio: ['ignore', 'ignore', 'inherit'] });
    log(C.green(`下载 ${filename} (wget)`));
  } else {
    log(C.red('未找到 curl 或 wget'));
    process.exit(1);
  }
}

function fetchText(url, timeoutSec = 5) {
  try {
    return execFileSync(
      hasCmd('curl') ? 'curl' : 'wget',
      hasCmd('curl')
        ? ['-s', '--max-time', String(timeoutSec), url]
        : ['-q', '-O', '-', '--timeout', String(timeoutSec), url],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
  } catch {
    return '';
  }
}

// ---------- 1. 目录准备 ----------
function prepareDirs() {
  for (const d of [FILE_PATH, DATA_PATH, LOG_PATH]) {
    fs.mkdirSync(d, { recursive: true });
  }
  process.env.FILE_PATH = FILE_PATH;
  process.env.DATA_PATH = DATA_PATH;
  process.env.LOG_PATH = LOG_PATH;
  process.env.LOG_LEVEL = CONFIG.LOG_LEVEL;
  process.env.LOG_FILE = LOG_FILE;
  process.env.XDG_DATA_HOME = '/tmp/.singbox_data';
  process.env.XDG_CACHE_HOME = '/tmp/.singbox_cache';
  process.env.TMPDIR = '/tmp';

  // 清理历史残留
  cleanDir(DATA_PATH);
  rmrf(path.join(os.homedir(), '.npm', '_logs'));
  rmrf(path.join(ROOT, 'npm-debug.log'));
  try {
    for (const f of fs.readdirSync(FILE_PATH)) {
      if (f.startsWith('sb_') && f !== 'sb_core') rmrf(path.join(FILE_PATH, f));
    }
  } catch {}
}

// ---------- 2. UUID ----------
function getUuid() {
  const uuidFile = path.join(FILE_PATH, 'uuid.txt');
  if (fs.existsSync(uuidFile)) {
    const uuid = fs.readFileSync(uuidFile, 'utf8').trim();
    log(C.yellow(`[UUID] 复用固定 UUID: ${uuid}`));
    return uuid;
  }
  const uuid = require('crypto').randomUUID();
  fs.writeFileSync(uuidFile, uuid, { mode: 0o600 });
  log(C.green(`[UUID] 首次生成并永久保存: ${uuid}`));
  return uuid;
}

// ---------- 3. 下载核心 ----------
function ensureCore() {
  if (fs.existsSync(SINGBOX_BIN)) {
    log(C.green('[核心] 已存在 Sing-box 核心，跳过下载'));
    return;
  }

  // 自动通过 API 获取最新的 release 版本号（剥离 v 前缀）
  let ver = '';
  const api = fetchText('https://api.github.com/repos/SagerNet/sing-box/releases/latest');
  const m = api.match(/"tag_name"\s*:\s*"v?([^"]+)"/);
  if (m) ver = m[1];
  if (!ver) ver = CONFIG.SINGBOX_FALLBACK_VER;

  const arch = os.arch();
  const map = {
    arm: 'linux-arm64',
    arm64: 'linux-arm64',
    x64: 'linux-amd64',
    s390x: 'linux-s390x',
  };
  const suffix = map[arch];
  if (!suffix) {
    log(C.red(`不支持的架构: ${arch}`));
    process.exit(1);
  }

  const url = `https://github.com/SagerNet/sing-box/releases/download/v${ver}/sing-box-${ver}-${suffix}.tar.gz`;
  const tarFile = path.join(FILE_PATH, 'singbox.tar.gz');

  log(C.yellow(`[下载] 未检测到 Sing-box 核心，正在下载最新版本 v${ver}...`));
  download(url, tarFile);

  const inTarDir = `sing-box-${ver}-${suffix}`;
  try {
    execFileSync('tar', ['-zxf', tarFile, '-C', FILE_PATH, '--strip-components=1', `${inTarDir}/sing-box`], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch {
    // 部分 tar 实现不支持指定包内路径，退化为全解压后移动
    execFileSync('tar', ['-zxf', tarFile, '-C', FILE_PATH], { stdio: ['ignore', 'ignore', 'ignore'] });
  }

  if (!fs.existsSync(SINGBOX_BIN)) {
    // 尝试找到解压出来的 sing-box
    const found = findFile(FILE_PATH, 'sing-box');
    if (found) fs.renameSync(found, SINGBOX_BIN);
  }
  rmrf(tarFile);
  if (fs.existsSync(SINGBOX_BIN)) fs.chmodSync(SINGBOX_BIN, 0o755);
}

function findFile(dir, name, depth = 4) {
  if (depth < 0 || !fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return full;
    if (entry.isDirectory()) {
      const r = findFile(full, name, depth - 1);
      if (r) return r;
    }
  }
  return null;
}

// ---------- 4. Reality 密钥 ----------
function ensureRealityKey() {
  if (!CONFIG.REALITY_PORT || CONFIG.REALITY_PORT === '0') return {};
  const keyFile = path.join(FILE_PATH, 'key.txt');
  if (fs.existsSync(keyFile)) {
    log(C.yellow('[密钥] 检测到已有密钥，复用...'));
    const content = fs.readFileSync(keyFile, 'utf8');
    return {
      private_key: (content.match(/PrivateKey:\s*(\S+)/) || [])[1] || '',
      public_key: (content.match(/PublicKey:\s*(\S+)/) || [])[1] || '',
    };
  }
  log(C.yellow('[密钥] 首次生成 Reality 密钥对...'));
  const output = execFileSync(SINGBOX_BIN, ['generate', 'reality-keypair'], { encoding: 'utf8' });
  fs.writeFileSync(keyFile, output, { mode: 0o600 });
  log(C.green('[密钥] 密钥已保存，重启后保持不变'));
  return {
    private_key: (output.match(/PrivateKey:\s*(\S+)/) || [])[1] || '',
    public_key: (output.match(/PublicKey:\s*(\S+)/) || [])[1] || '',
  };
}

// ---------- 5. 自签证书 ----------
function ensureCert() {
  const cert = path.join(FILE_PATH, 'cert.pem');
  const key = path.join(FILE_PATH, 'private.key');
  if (fs.existsSync(cert) && fs.existsSync(key)) return;

  if (hasCmd('openssl')) {
    execFileSync('openssl', ['ecparam', '-genkey', '-name', 'prime256v1', '-out', key], { stdio: 'ignore' });
    execFileSync(
      'openssl',
      ['req', '-new', '-x509', '-days', '3650', '-key', key, '-out', cert, '-subj', '/CN=bing.com'],
      { stdio: 'ignore' }
    );
  } else {
    // 内嵌兜底证书（CN=bing.com）
    fs.writeFileSync(key, EMBEDDED_PRIVATE_KEY);
    fs.writeFileSync(cert, EMBEDDED_CERT);
  }
  try {
    fs.chmodSync(key, 0o600);
  } catch {}
}

const EMBEDDED_PRIVATE_KEY = `-----BEGIN EC PARAMETERS-----
BgqghkjOPQQBw==
-----END EC PARAMETERS-----
-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIM4792SEtPqIt1ywqTd/0bYidBqpYV/+siNnfBYsdUYsAoGCCqGSM49
AwEHoUQDQgAE1kHafPj07rJG+HboH2ekAI4r+e6TL38GWASAnngZreoQDF16ARa
/TsyLyFoPkhTxSbehH/OBEjHtSZGaDhMqQ==
-----END EC PRIVATE KEY-----
`;

const EMBEDDED_CERT = `-----BEGIN CERTIFICATE-----
MIIBejCCASGgAwIBAgIUFWeQL3556PNJLp/veCFxGNj9crkwCgYIKoZIzj0EAwIw
EzERMA8GA1UEAwwIYmluZy5jb20wHhcNMjUwMTAxMDEwMTAwWhcNMzUwMTAxMDEw
MTAwWjATMREwDwYDVQQDDAhiaW5nLmNvbTBNBgqgGzM9AgEGCCqGSM49AwEHA0IA
BNZB2nz49O6yRvh26B9npACOK/nuky9/BlgEgDZ54Ga3qEAxdeWv07Mi8h
d5IR8Um3oR/zQRIx7UmRmg4TKmjUzBRMB0GA1UdDgQWBQTV1cFID7UISE7PLTBR
BfGbgrkMNzAfBgNVHSMEGDAWgBTV1cFID7UISE7PLTBRBfGbgrkMNzAPBgNVHRMB
Af8EBTADAQH/MAoGCCqGSM49BAMCA0cAMEQCIARDAJvg0vd/ytrQVvEcSm6XTlB+
eQ6OFb9LbLYL9Zi+AiffoMbi4y/0YUQlTtz7as9S8/lciBF5VCUoVIKS+vX2g==
-----END CERTIFICATE-----
`;

// ---------- 6. 生成 config.json ----------
function buildConfig(uuid, keyPair) {
  const { REALITY_PORT, TUIC_PORT, HY2_PORT, REALITY_SNI, LOG_LEVEL } = CONFIG;
  const inbounds = [];

  if (TUIC_PORT && TUIC_PORT !== '0') {
    inbounds.push({
      type: 'tuic',
      listen: '::',
      listen_port: Number(TUIC_PORT),
      users: [{ uuid, password: 'admin' }],
      congestion_control: 'bbr',
      tls: {
        enabled: true,
        alpn: ['h3'],
        certificate_path: path.join(FILE_PATH, 'cert.pem'),
        key_path: path.join(FILE_PATH, 'private.key'),
      },
    });
  }

  if (HY2_PORT && HY2_PORT !== '0') {
    inbounds.push({
      type: 'hysteria2',
      listen: '::',
      listen_port: Number(HY2_PORT),
      users: [{ password: uuid }],
      masquerade: 'https://bing.com',
      tls: {
        enabled: true,
        alpn: ['h3'],
        certificate_path: path.join(FILE_PATH, 'cert.pem'),
        key_path: path.join(FILE_PATH, 'private.key'),
      },
    });
  }

  if (REALITY_PORT && REALITY_PORT !== '0') {
    inbounds.push({
      type: 'vless',
      listen: '::',
      listen_port: Number(REALITY_PORT),
      users: [{ uuid, flow: 'xtls-rprx-vision' }],
      tls: {
        enabled: true,
        server_name: REALITY_SNI,
        reality: {
          enabled: true,
          handshake: { server: REALITY_SNI, server_port: 443 },
          private_key: keyPair.private_key,
          short_id: [''],
        },
      },
    });
  }

  const config = {
    log: { disabled: false, level: LOG_LEVEL, output: LOG_FILE, timestamp: true },
    inbounds,
    outbounds: [{ type: 'direct' }],
  };

  const configFile = path.join(FILE_PATH, 'config.json');
  fs.mkdirSync(FILE_PATH, { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  return configFile;
}

// ---------- 7. 启动核心 ----------
function startCore(configFile) {
  const errFd = fs.openSync(LOG_FILE, 'a');
  const child = spawn(SINGBOX_BIN, ['run', '-c', configFile], {
    detached: true,
    stdio: ['ignore', errFd, errFd],
  });
  child.unref();
  fs.closeSync(errFd);

  log(`[SING-BOX] 启动完成 PID=${child.pid}`);
  log(C.cyan(`[LOG] 级别=${CONFIG.LOG_LEVEL}  文件=${LOG_FILE}`));
  log(C.cyan(`[LOG] 实时查看: tail -f "${LOG_FILE}"`));
  log(C.cyan(`[LOG] 最近 50 行: tail -n 50 "${LOG_FILE}"`));

  // 给核心 2 秒初始化时间，如果进程立刻退出，把日志末尾打出来便于排障
  const start = Date.now();
  while (Date.now() - start < 2000) {
    try {
      process.kill(child.pid, 0);
    } catch {
      log(C.red('[SING-BOX] 进程异常退出！日志末尾：'));
      try {
        const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n');
        log(lines.slice(-30).join('\n'));
      } catch {}
      break;
    }
    syncSleep(200);
  }

  return child;
}

// ---------- 8. 生成订阅 ----------
function genSubscription(uuid, keyPair) {
  const { TUIC_PORT, HY2_PORT, REALITY_PORT, REALITY_SNI } = CONFIG;

  let IP = fetchText('http://ipv4.ip.sb', 2) || fetchText('https://api.ipify.org', 2) || 'IP_ERROR';
  IP = IP.trim();

  const lines = [];
  if (TUIC_PORT && TUIC_PORT !== '0') {
    lines.push(
      `tuic://${uuid}:admin@${IP}:${TUIC_PORT}?sni=www.bing.com&alpn=h3&congestion_control=bbr&allowInsecure=1#tuic_easyshare`
    );
  }
  if (HY2_PORT && HY2_PORT !== '0') {
    lines.push(`hysteria2://${uuid}@${IP}:${HY2_PORT}/?sni=www.bing.com&insecure=1#hy2_easyshare`);
  }
  if (REALITY_PORT && REALITY_PORT !== '0') {
    lines.push(
      `vless://${uuid}@${IP}:${REALITY_PORT}?encryption=none&flow=xtls-rprx-vision&security=reality&sni=${REALITY_SNI}&fp=firefox&pbk=${keyPair.public_key || ''}&type=tcp#reality_easyshare`
    );
  }

  const listFile = path.join(FILE_PATH, 'list.txt');
  const subFile = path.join(FILE_PATH, 'sub.txt');
  fs.writeFileSync(listFile, lines.join('\n') + (lines.length ? '\n' : ''));
  fs.writeFileSync(subFile, Buffer.from(lines.join('\n')).toString('base64'));

  log(lines.join('\n'));
  log(C.green(`\n${subFile} 已保存`));
}

// ---------- 9. 定时重启（北京时间 00:03）----------
function scheduleRestart(state) {
  if (CONFIG.RESTART_ENABLED !== 'true') return;
  log(`[定时重启:Sing-box] 已启动（北京时间 ${String(CONFIG.RESTART_HOUR).padStart(2, '0')}:${String(CONFIG.RESTART_MIN).padStart(2, '0')}）`);

  let lastRestartDay = -1;

  setInterval(() => {
    const beijingTs = Math.floor(Date.now() / 1000) + 8 * 3600;
    const H = Math.floor(beijingTs / 3600) % 24;
    const M = Math.floor(beijingTs / 60) % 60;
    const D = Math.floor(beijingTs / 86400);

    if (H === CONFIG.RESTART_HOUR && M === CONFIG.RESTART_MIN && D !== lastRestartDay) {
      lastRestartDay = D;
      log('[定时重启:Sing-box] 到达重启时间 → 重启 sing-box');

      try {
        if (state.child) process.kill(state.child.pid, 'SIGTERM');
      } catch {}
      setTimeout(() => {
        // 重启前归档旧日志，便于回溯
        try {
          if (fs.existsSync(LOG_FILE)) {
            const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
            fs.renameSync(LOG_FILE, `${LOG_FILE}.${ts}`);
          }
        } catch {}

        rmrf(path.join(os.homedir(), '.npm', '_logs'));
        rmrf(path.join(ROOT, 'npm-debug.log'));
        cleanDir(DATA_PATH);

        state.child = startCore(state.configFile);
        log(`[Sing-box重启完成] 新 PID: ${state.child.pid}  日志: ${LOG_FILE}`);
      }, 3000);
    }
  }, CONFIG.CHECK_INTERVAL_SEC * 1000);
}

// ---------- main ----------
function main() {
  prepareDirs();
  const uuid = getUuid();
  ensureCore();
  const keyPair = ensureRealityKey();
  ensureCert();

  const configFile = buildConfig(uuid, keyPair);
  const state = { child: null, configFile };
  state.child = startCore(configFile);

  genSubscription(uuid, keyPair);
  scheduleRestart(state);
}

if (require.main === module) {
  main();
}

module.exports = { CONFIG, buildConfig, genSubscription, main };
