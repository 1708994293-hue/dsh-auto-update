#!/usr/bin/env node
/**
 * dsh-auto-update — 检查并更新 DSH profile 中「已下载且已启用」的第三方插件。
 *
 * 判定口径：
 *   - 已下载：profile 的 package.json dependencies 中声明；
 *   - 已启用：出现在 dsh.profile.bundles，或被 cordis.patch.yml 引用，
 *             且不在 .dsh-market/state.json 的 disabled 列表里；
 *   - 需要更新：npm registry 的 dist-tags.latest 严格高于已安装版本（semver 比较，
 *             不会降级、不会把 prerelease 覆盖成更旧的 stable）。
 *
 * 更新通道：官方 `dsh plugin --profile <name> add <pkg>@<ver> ... --config.minimum-release-age=0`
 * （等价于在 profile 目录里跑 pnpm add；pnpm 11 的 minimumReleaseAge 会把新版本拦掉，故显式关闭）。
 *
 * 用法：
 *   node update.mjs                       # 检查并更新（后台自动运行时的默认行为）
 *   node update.mjs --check               # 只检查，不更新
 *   node update.mjs --check --json        # 机器可读输出
 *   node update.mjs --dry-run             # 打印将要执行的命令，不真正执行
 *   node update.mjs --profile desktop
 *   node update.mjs --dsh-exe "C:\...\DeepSeek Harness.exe"
 *
 * 退出码：0 = 无更新或全部成功；1 = 出错/更新未成功。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
// 运行数据（state/logs）默认放在包根目录（脚本位于 <package>/lib/），可用 DSH_AUTO_UPDATE_DATA_DIR 覆盖。
const DATA_DIR = process.env.DSH_AUTO_UPDATE_DATA_DIR || path.dirname(SCRIPT_DIR);
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const DEFAULT_INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
const LOCK_STALE_MS = 30 * 60 * 1000;

/* ------------------------------------------------------------------ utils */

function stripBom(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function readText(file) {
  try {
    return stripBom(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readJson(file) {
  const text = readText(file);
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const opts = {
    profile: process.env.DSH_AUTO_UPDATE_PROFILE || process.env.DSH_PROFILE || 'desktop',
    check: false,
    json: false,
    dryRun: false,
    quiet: false,
    force: false,
    dshExe: null,
    launchedBy: 'manual',
    timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    const key = eq === -1 ? raw.slice(2) : raw.slice(2, eq);
    let value = eq === -1 ? undefined : raw.slice(eq + 1);
    const takeValue = () => {
      if (value !== undefined) return value;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`--${key} 缺少参数值`);
      i += 1;
      return next;
    };
    switch (key) {
      case 'profile':
        opts.profile = takeValue();
        break;
      case 'check':
      case 'status':
        opts.check = true;
        break;
      case 'json':
        opts.json = true;
        break;
      case 'dry-run':
        opts.dryRun = true;
        break;
      case 'quiet':
        opts.quiet = true;
        break;
      case 'force':
        opts.force = true;
        break;
      case 'dsh-exe':
        opts.dshExe = takeValue();
        break;
      case 'launched-by':
        opts.launchedBy = takeValue();
        break;
      case 'timeout':
        opts.timeoutMs = Number(takeValue());
        if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) throw new Error('--timeout 无效');
        break;
      case 'help':
      case 'h':
        opts.help = true;
        break;
      default:
        break;
    }
  }
  return opts;
}

/* --------------------------------------------------------------- logging */

function makeLogger(opts) {
  const logDir = path.join(DATA_DIR, 'logs');
  let logFile = null;
  try {
    fs.mkdirSync(logDir, { recursive: true });
    logFile = path.join(logDir, 'auto-update.log');
    try {
      const st = fs.statSync(logFile);
      if (st.size > MAX_LOG_BYTES) fs.renameSync(logFile, path.join(logDir, 'auto-update.old.log'));
    } catch {
      /* 文件不存在或无法轮转，忽略 */
    }
  } catch {
    logFile = null;
  }
  const write = (line) => {
    if (logFile) {
      try {
        fs.appendFileSync(logFile, line + '\n');
      } catch {
        /* 日志失败不影响主流程 */
      }
    }
    if (!opts.quiet) process.stdout.write(line + '\n');
  };
  return {
    info: (msg) => write(`[${new Date().toISOString()}] ${msg}`),
    raw: (msg) => write(msg),
    file: logFile,
  };
}

function writeJsonSafe(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  } catch {
    /* 状态写入失败不影响主流程 */
  }
}

/* ---------------------------------------------------------------- semver */

function parseVersion(input) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(input ?? '').trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split('.') : [],
  };
}

function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1; // 稳定版 > 预发布
  if (b.length === 0) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1; // 数字标识符优先级低于字母
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** a > b ? 1 : a < b ? -1 : 0；无法解析时返回 null。 */
function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return null;
  if (va.major !== vb.major) return va.major > vb.major ? 1 : -1;
  if (va.minor !== vb.minor) return va.minor > vb.minor ? 1 : -1;
  if (va.patch !== vb.patch) return va.patch > vb.patch ? 1 : -1;
  return comparePrerelease(va.pre, vb.pre);
}

function isUpgrade(installed, latest) {
  const cmp = compareVersions(installed, latest);
  return cmp !== null && cmp < 0;
}

/* ------------------------------------------------------------ profile data */

const NON_REGISTRY_SPEC = /^(?:file:|link:|portal:|workspace:|git\+|git:|github:|https?:|ssh:|\/|\.{1,2}[\\/])/i;

function loadProfileData(dshHome, profile) {
  const profileDir = path.join(dshHome, 'profiles', profile);
  const pkgPath = path.join(profileDir, 'package.json');
  const pkg = readJson(pkgPath);
  if (!pkg) throw new Error(`找不到或无法解析 profile package.json: ${pkgPath}`);

  const bundlesRaw = pkg?.dsh?.profile?.bundles;
  const bundles = Array.isArray(bundlesRaw)
    ? bundlesRaw.filter((x) => typeof x === 'string')
    : [];
  const patchText = readText(path.join(profileDir, 'cordis.patch.yml')) || '';
  const marketState = readJson(path.join(profileDir, '.dsh-market', 'state.json')) || {};
  const disabled = new Set(
    Array.isArray(marketState.disabled)
      ? marketState.disabled.filter((x) => typeof x === 'string')
      : [],
  );
  const dependencies =
    pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {};

  return { profileDir, pkg, pkgPath, bundles, patchText, disabled, dependencies };
}

function installedVersion(profileDir, name) {
  const pkg = readJson(path.join(profileDir, 'node_modules', name, 'package.json'));
  return typeof pkg?.version === 'string' ? pkg.version : null;
}

/** 已下载且已启用的候选插件。 */
function collectCandidates(data) {
  const candidates = [];
  const skipped = [];
  for (const [name, spec] of Object.entries(data.dependencies)) {
    const enabledByBundle = data.bundles.includes(name);
    const enabledByPatch = data.patchText.includes(name);
    if (!enabledByBundle && !enabledByPatch) {
      skipped.push({ name, reason: '未启用（不在 bundles / cordis.patch.yml）' });
      continue;
    }
    if (data.disabled.has(name)) {
      skipped.push({ name, reason: '已被插件市场禁用（.dsh-market/state.json）' });
      continue;
    }
    if (typeof spec !== 'string' || NON_REGISTRY_SPEC.test(spec)) {
      skipped.push({ name, reason: `非 registry 依赖（${String(spec)}）` });
      continue;
    }
    const installed = installedVersion(data.profileDir, name);
    if (!installed) {
      skipped.push({ name, reason: '未安装到 node_modules（无法确定当前版本）' });
      continue;
    }
    candidates.push({ name, spec, installed });
  }
  return { candidates, skipped };
}

/* --------------------------------------------------------------- registry */

const REGISTRY = process.env.DSH_AUTO_UPDATE_REGISTRY || 'https://registry.npmjs.org';

async function fetchLatestVersion(name) {
  const url = `${REGISTRY}/${name.replace('/', '%2F')}`;
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, attempt * 1200));
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/vnd.npm.install-v1+json' },
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) {
        lastError = new Error(`HTTP ${res.status}`);
        if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
        continue;
      }
      const body = await res.json();
      const latest = body?.['dist-tags']?.latest;
      if (typeof latest !== 'string' || !latest) throw new Error('响应里没有 dist-tags.latest');
      return { latest, tags: body['dist-tags'] || {} };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('无法访问 registry');
}

async function checkCandidates(candidates, log) {
  const results = [];
  const concurrency = 4;
  let cursor = 0;
  const worker = async () => {
    while (cursor < candidates.length) {
      const index = cursor;
      cursor += 1;
      const candidate = candidates[index];
      try {
        const { latest } = await fetchLatestVersion(candidate.name);
        const upgrade = isUpgrade(candidate.installed, latest);
        results[index] = {
          ...candidate,
          latest,
          updateAvailable: upgrade,
          reason: upgrade ? null : '已是最新或 registry 版本不高于当前版本',
        };
      } catch (error) {
        results[index] = {
          ...candidate,
          latest: null,
          updateAvailable: false,
          reason: `检查失败：${error?.message || error}`,
          error: true,
        };
      }
      if (!log) continue;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));
  return results;
}

/* ------------------------------------------------------------ dsh launcher */

function existingFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function candidateExePaths(opts) {
  const list = [];
  if (opts.dshExe) list.push(opts.dshExe);
  for (const key of ['DSH_DESKTOP_EXE', 'DSH_DESKTOP_NODE_EXECUTABLE']) {
    const value = process.env[key];
    if (value) list.push(value);
  }
  if (process.execPath) list.push(process.execPath);
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  list.push(path.join(localAppData, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'));
  try {
    const programs = path.join(localAppData, 'Programs');
    for (const entry of fs.readdirSync(programs, { withFileTypes: true })) {
      if (entry.isDirectory() && /deepseek/i.test(entry.name)) {
        list.push(path.join(programs, entry.name, 'DeepSeek Harness.exe'));
      }
    }
  } catch {
    /* 忽略扫描失败 */
  }
  return list;
}

/** DSH 桌面可执行文件的特征：同目录下存在 resources\app.asar。 */
function isDshExecutable(candidate) {
  if (!candidate || !/\.exe$/i.test(candidate) || !existingFile(candidate)) return false;
  try {
    return fs.existsSync(path.join(path.dirname(candidate), 'resources', 'app.asar'));
  } catch {
    return false;
  }
}

function resolveDshExe(opts) {
  for (const candidate of candidateExePaths(opts)) {
    if (isDshExecutable(candidate)) return candidate;
  }
  return null;
}

function cliEntryFor(exe) {
  return path.join(
    path.dirname(exe),
    'resources',
    'app.asar',
    'dsh',
    'node_modules',
    '@deepseek-ai',
    'dsh-desktop-host',
    'lib',
    'cli.js',
  );
}

/* ------------------------------------------------------------------- lock */

function acquireLock(stateDir, log) {
  const lockFile = path.join(stateDir, 'update.lock');
  try {
    const st = fs.statSync(lockFile);
    if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
      log.info(`清理过期锁（${Math.round((Date.now() - st.mtimeMs) / 1000)}s 未更新）`);
      fs.rmSync(lockFile, { force: true });
    }
  } catch {
    /* 无锁 */
  }
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const fd = fs.openSync(lockFile, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    fs.closeSync(fd);
    return lockFile;
  } catch {
    return null;
  }
}

function releaseLock(lockFile) {
  if (!lockFile) return;
  try {
    fs.rmSync(lockFile, { force: true });
  } catch {
    /* 忽略 */
  }
}

/* ---------------------------------------------------------------- install */

function buildInstallArgs(profile, updates) {
  const pinned = updates.map((u) => `${u.name}@${u.latest}`);
  const allExactSpecs = updates.every((u) => !/^[\^~]/.test(String(u.spec || '')));
  const args = ['plugin', '--profile', profile, 'add', ...pinned, '--config.minimum-release-age=0'];
  if (allExactSpecs) args.push('--save-exact');
  return args;
}

function tailBuffer(chunks, limit = 200 * 1024) {
  let total = 0;
  const kept = [];
  for (let i = chunks.length - 1; i >= 0; i -= 1) {
    total += chunks[i].length;
    kept.unshift(chunks[i]);
    if (total >= limit) break;
  }
  return Buffer.concat(kept).toString('utf8');
}

function runInstaller(exe, cliEntry, profile, updates, opts, log) {
  const args = ['--expose-internals', cliEntry, ...buildInstallArgs(profile, updates)];
  const profileDir = opts.profileDir;
  const runtimeBin = path.join(path.dirname(exe), 'resources', 'runtime', 'bin');
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_DESKTOP_NODE_EXECUTABLE: exe,
    DSH_HOME: opts.dshHome,
    PATH: existingFile(path.join(runtimeBin, 'node.cmd'))
      ? `${runtimeBin}${path.delimiter}${process.env.PATH || ''}`
      : process.env.PATH,
  };

  log.info(`执行：${exe} ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`);
  log.info(`工作目录：${profileDir}`);

  return new Promise((resolve) => {
    const stdout = [];
    const stderr = [];
    let settled = false;
    let child;
    try {
      child = spawn(exe, args, { cwd: profileDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, code: -1, signal: null, stdout: '', stderr: String(error?.message || error), timedOut: false });
      return;
    }
    child.stdout.on('data', (c) => stdout.push(Buffer.from(c)));
    child.stderr.on('data', (c) => stderr.push(Buffer.from(c)));
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout: tailBuffer(stdout), stderr: tailBuffer(stderr) });
    };
    const timer = setTimeout(() => {
      log.info(`安装超时（${Math.round(opts.timeoutMs / 1000)}s），尝试结束进程 ${child.pid}`);
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        /* 忽略 */
      }
      finish({ ok: false, code: -1, signal: 'timeout', timedOut: true });
    }, opts.timeoutMs);
    timer.unref?.();
    child.on('error', (error) => finish({ ok: false, code: -1, signal: null, timedOut: false, stderr: String(error?.message || error) }));
    child.on('close', (code, signal) => finish({ ok: code === 0, code, signal, timedOut: false }));
  });
}

/* ------------------------------------------------------------------- main */

function formatTable(rows, log) {
  const width = Math.max(0, ...rows.map((r) => r.name.length));
  for (const r of rows) {
    const state = r.updateAvailable ? '可更新' : r.error ? '检查失败' : '已最新';
    log.raw(`  ${r.name.padEnd(width)}  ${r.installed} -> ${r.latest ?? '?'}  ${state}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(readText(SCRIPT_PATH)?.split('\n').slice(0, 30).join('\n') + '\n');
    return 0;
  }

  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const stateDir = path.join(DATA_DIR, 'state');
  const log = makeLogger(opts);
  const startedAt = Date.now();
  const result = {
    at: new Date().toISOString(),
    launchedBy: opts.launchedBy,
    profile: opts.profile,
    dshHome,
    checked: [],
    skipped: [],
    updates: [],
    ok: true,
    error: null,
    exitCode: 0,
    durationMs: 0,
  };

  log.info(`==== dsh-auto-update 启动 (${opts.launchedBy}) profile=${opts.profile} check=${opts.check} dryRun=${opts.dryRun} ====`);

  let data;
  try {
    data = loadProfileData(dshHome, opts.profile);
  } catch (error) {
    result.ok = false;
    result.error = String(error?.message || error);
    log.info(`错误：${result.error}`);
    writeJsonSafe(path.join(stateDir, 'last-run.json'), { ...result, durationMs: Date.now() - startedAt });
    return 1;
  }

  const { candidates, skipped } = collectCandidates(data);
  result.skipped = skipped;
  log.info(`profile 目录：${data.profileDir}`);
  log.info(`已下载 ${Object.keys(data.dependencies).length} 个依赖，其中启用 ${candidates.length} 个参与检查；跳过 ${skipped.length} 个`);
  for (const item of skipped) log.info(`  跳过 ${item.name}：${item.reason}`);

  if (candidates.length === 0) {
    log.info('没有需要检查的插件，结束');
    writeJsonSafe(path.join(stateDir, 'last-run.json'), { ...result, durationMs: Date.now() - startedAt });
    return 0;
  }

  const checked = await checkCandidates(candidates, log);
  result.checked = checked.map((c) => ({ name: c.name, installed: c.installed, latest: c.latest, updateAvailable: c.updateAvailable }));
  const updates = checked.filter((c) => c.updateAvailable);
  result.updates = updates.map((c) => ({ name: c.name, from: c.installed, to: c.latest }));
  const failedChecks = checked.filter((c) => c.error);

  log.info('检查结果：');
  formatTable(checked, log);

  if (opts.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');

  if (updates.length === 0) {
    log.info(failedChecks.length > 0 ? '没有可更新项（部分检查失败）' : '全部已是最新，无需更新');
    if (failedChecks.length > 0) {
      result.ok = false;
      result.error = `${failedChecks.length} 个插件版本检查失败`;
    }
    writeJsonSafe(path.join(stateDir, 'last-run.json'), { ...result, durationMs: Date.now() - startedAt });
    return failedChecks.length > 0 ? 1 : 0;
  }

  log.info(`发现 ${updates.length} 个可更新插件：${updates.map((u) => `${u.name} ${u.installed}->${u.latest}`).join('，')}`);

  if (opts.check || opts.dryRun) {
    if (!opts.check) log.info('dry-run：不执行安装');
    writeJsonSafe(path.join(stateDir, 'last-run.json'), { ...result, durationMs: Date.now() - startedAt });
    return 0;
  }

  const exe = resolveDshExe(opts);
  if (!exe) {
    result.ok = false;
    result.error = '找不到 DeepSeek Harness.exe，无法调用 dsh plugin 更新';
    log.info(`错误：${result.error}`);
    writeJsonSafe(path.join(stateDir, 'last-run.json'), { ...result, durationMs: Date.now() - startedAt });
    return 1;
  }
  log.info(`使用 DSH 可执行文件：${exe}`);

  const lockFile = acquireLock(stateDir, log);
  if (!lockFile) {
    log.info('另一个更新进程正在运行，本次跳过（下次启动会重试）');
    result.ok = false;
    result.error = '另一个更新进程正在运行';
    writeJsonSafe(path.join(stateDir, 'last-run.json'), { ...result, durationMs: Date.now() - startedAt });
    return 1;
  }

  try {
    const install = await runInstaller(
      exe,
      cliEntryFor(exe),
      opts.profile,
      updates,
      { ...opts, profileDir: data.profileDir, dshHome },
      log,
    );
    if (install.stdout.trim()) log.raw(install.stdout.trimEnd());
    if (install.stderr.trim()) log.raw(install.stderr.trimEnd());

    result.install = {
      code: install.code,
      signal: install.signal,
      timedOut: install.timedOut,
      command: [exe, ...buildInstallArgs(opts.profile, updates)],
    };

    const verification = updates.map((u) => ({
      name: u.name,
      expected: u.latest,
      actual: installedVersion(data.profileDir, u.name),
    }));
    result.verification = verification;

    if (!install.ok) {
      result.ok = false;
      result.error = install.timedOut ? '更新超时' : `更新命令退出码 ${install.code}`;
      log.info(`更新失败：${result.error}`);
      return 1;
    }

    const bad = verification.filter((v) => compareVersions(v.actual, v.expected) !== 0);
    if (bad.length > 0) {
      result.ok = false;
      result.error = `更新后版本校验不一致：${bad.map((b) => `${b.name} 期望 ${b.expected} 实际 ${b.actual}`).join('，')}`;
      log.info(`版本校验失败：${result.error}`);
      return 1;
    }

    log.info(`更新成功：${updates.map((u) => `${u.name}@${u.latest}`).join('，')}（重启 DSH 后生效）`);
    return 0;
  } finally {
    releaseLock(lockFile);
    result.durationMs = Date.now() - startedAt;
    writeJsonSafe(path.join(stateDir, 'last-run.json'), result);
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    try {
      process.stderr.write(`dsh-auto-update 未捕获错误：${error?.stack || error}\n`);
    } catch {
      /* 忽略 */
    }
    process.exitCode = 1;
  },
);
