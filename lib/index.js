/**
 * Host half of `dsh-auto-update`.
 *
 * On every Harness launch it runs the bundled update checker (`update.mjs --check --json`),
 * keeps the result in memory, and serves it to the client half over one HTTP route.
 * Nothing is installed unless the user confirms in the Web UI (`POST …/apply`).
 *
 * Routes (all under `/dsh-auto-update`, same-origin from the Web page):
 *   GET  /dsh-auto-update/status   -> current state
 *   POST /dsh-auto-update/check    -> re-run the check now
 *   POST /dsh-auto-update/apply    -> install every listed update
 *   POST /dsh-auto-update/dismiss  -> hide the prompt for this launch
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = '@sueleven/dsh-auto-update';
export const inject = ['webServer'];

const ROUTE_PREFIX = '/dsh-auto-update';
const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT_PATH = join(PACKAGE_DIR, 'lib', 'update.mjs');
const STATE_DIR = join(PACKAGE_DIR, 'state');
const LOG_DIR = join(PACKAGE_DIR, 'logs');
const CHECK_TIMEOUT_MS = 120_000;
const APPLY_TIMEOUT_MS = 15 * 60_000;
const STARTUP_DELAY_MS = Number(process.env.DSH_AUTO_UPDATE_DELAY_MS || 8_000);

const state = {
  phase: 'idle', // idle | checking | available | updating | done | error
  profile: process.env.DSH_AUTO_UPDATE_PROFILE || process.env.DSH_PROFILE || 'desktop',
  checkedAt: null,
  checkedCount: 0,
  skippedCount: 0,
  updates: [],
  dismissed: false,
  error: null,
  message: null,
};

let pendingTimer;
let checkPromise = null;
let applyPromise = null;
let disposed = false;

/* ------------------------------------------------------------------ utils */

function ensureDir(dir) {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
}

function log(line) {
  ensureDir(LOG_DIR);
  try {
    writeFileSync(join(LOG_DIR, 'plugin.log'), `${new Date().toISOString()} ${line}\n`, { flag: 'a' });
  } catch {
    /* ignore */
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  ensureDir(dirname(file));
  try {
    writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  } catch {
    /* ignore */
  }
}

function parseJsonOutput(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Run the bundled updater as a child of the Host process (Electron in Node mode). */
function runUpdater(args, timeoutMs) {
  return new Promise((resolve) => {
    if (!existsSync(SCRIPT_PATH)) {
      resolve({ ok: false, code: null, out: '', err: `找不到更新脚本: ${SCRIPT_PATH}` });
      return;
    }
    let child;
    try {
      child = spawn(process.execPath, [SCRIPT_PATH, ...args], {
        cwd: PACKAGE_DIR,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_AUTO_UPDATE_DATA_DIR: PACKAGE_DIR },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ ok: false, code: null, out: '', err: String(error?.message || error) });
      return;
    }
    const LIMIT = 512 * 1024;
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      if (out.length < LIMIT) out += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      if (err.length < LIMIT) err += chunk.toString('utf8');
    });
    let settled = false;
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    child.on('error', (error) => finish({ ok: false, code: null, out, err: `${err}${String(error?.message || error)}` }));
    child.on('close', (code, signal) => finish({ ok: code === 0, code, signal, out, err }));
    child.on('exit', (code, signal) => finish({ ok: code === 0, code, signal, out, err }));
  });
}

/* ------------------------------------------------------------ check / apply */

async function runCheck() {
  if (disposed) return;
  if (state.phase === 'updating') return;
  if (checkPromise) return checkPromise;
  state.phase = 'checking';
  state.error = null;
  state.dismissed = false;
  log(`检查开始 profile=${state.profile}`);
  checkPromise = (async () => {
    const args = ['--profile', state.profile, '--check', '--json', '--quiet', '--launched-by', 'dsh-plugin'];
    if (process.execPath) args.push('--dsh-exe', process.execPath);
    const result = await runUpdater(args, CHECK_TIMEOUT_MS);
    const json = parseJsonOutput(result.out);
    if (json) {
      state.updates = Array.isArray(json.updates) ? json.updates.map((item) => ({ name: item.name, from: item.from, to: item.to })) : [];
      state.checkedCount = Array.isArray(json.checked) ? json.checked.length : 0;
      state.skippedCount = Array.isArray(json.skipped) ? json.skipped.length : 0;
      state.checkedAt = json.at || new Date().toISOString();
      state.error = json.ok === false ? json.error || '部分插件版本检查失败' : null;
    } else {
      state.updates = [];
      state.error = result.ok
        ? '更新检查脚本没有返回结果'
        : `更新检查失败：${result.err.trim() || `退出码 ${result.code}`}`;
    }
    if (state.updates.length > 0) state.phase = 'available';
    else state.phase = 'idle';
    state.message = null;
    log(
      `检查结束 可更新=${state.updates.length} 检查=${state.checkedCount} 跳过=${state.skippedCount}${
        state.error ? ` 错误=${state.error}` : ''
      }`,
    );
    writeJson(join(STATE_DIR, 'plugin-state.json'), snapshot());
    return json;
  })()
    .catch((error) => {
      state.phase = 'idle';
      state.error = String(error?.message || error);
      log(`检查异常：${state.error}`);
      return null;
    })
    .finally(() => {
      checkPromise = null;
    });
  return checkPromise;
}

async function runApply() {
  if (disposed) return;
  if (state.phase === 'updating') return;
  if (state.updates.length === 0) return;
  if (applyPromise) return applyPromise;
  const targets = state.updates.slice();
  state.phase = 'updating';
  state.message = `正在更新 ${targets.map((item) => item.name).join('、')}…`;
  state.error = null;
  log(`用户确认更新：${targets.map((item) => `${item.name} ${item.from}->${item.to}`).join('，')}`);
  writeJson(join(STATE_DIR, 'plugin-state.json'), snapshot());
  applyPromise = (async () => {
    const args = ['--profile', state.profile, '--launched-by', 'user-confirmed'];
    if (process.execPath) args.push('--dsh-exe', process.execPath);
    const result = await runUpdater(args, APPLY_TIMEOUT_MS);
    const lastRun = readJson(join(STATE_DIR, 'last-run.json'));
    const ok = Boolean(lastRun?.ok) && result.ok;
    if (ok) {
      state.updates = [];
      state.phase = 'done';
      state.message = `已更新 ${targets.map((item) => `${item.name} ${item.from} → ${item.to}`).join('，')}，重启 DSH 后生效。`;
    } else {
      state.phase = 'error';
      state.error = lastRun?.error || (result.err.trim() || `更新命令退出码 ${result.code}`);
      state.message = '更新失败，详见插件日志。';
    }
    log(`更新结束 ok=${ok}${state.error ? ` 错误=${state.error}` : ''}`);
    writeJson(join(STATE_DIR, 'plugin-state.json'), snapshot());
    return lastRun;
  })()
    .catch((error) => {
      state.phase = 'error';
      state.error = String(error?.message || error);
      state.message = '更新失败，详见插件日志。';
      return null;
    })
    .finally(() => {
      applyPromise = null;
    });
  return applyPromise;
}

function snapshot() {
  return {
    phase: state.phase,
    profile: state.profile,
    checkedAt: state.checkedAt,
    checkedCount: state.checkedCount,
    skippedCount: state.skippedCount,
    updates: state.updates,
    dismissed: state.dismissed,
    error: state.error,
    message: state.message,
  };
}

/* ------------------------------------------------------------------- routes */

function sendJson(res, status, data) {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function createHandler() {
  return (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://dsh.internal');
      const path = url.pathname;
      if (!path.startsWith(ROUTE_PREFIX)) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      const route = path.slice(ROUTE_PREFIX.length) || '/';
      const method = req.method ?? 'GET';
      if (method === 'GET' && route === '/status') {
        sendJson(res, 200, snapshot());
        return;
      }
      if (method === 'POST' && route === '/check') {
        runCheck().catch(() => {});
        sendJson(res, 202, snapshot());
        return;
      }
      if (method === 'POST' && route === '/apply') {
        if (state.updates.length === 0) {
          sendJson(res, 409, { ...snapshot(), error: '没有可更新的插件' });
          return;
        }
        runApply().catch(() => {});
        sendJson(res, 202, snapshot());
        return;
      }
      if (method === 'POST' && route === '/dismiss') {
        state.dismissed = true;
        writeJson(join(STATE_DIR, 'plugin-state.json'), snapshot());
        sendJson(res, 200, snapshot());
        return;
      }
      sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      sendJson(res, 500, { error: String(error?.message || error) });
    }
  };
}

/* -------------------------------------------------------------------- entry */

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx) {
  ensureDir(STATE_DIR);
  writeJson(join(STATE_DIR, 'plugin-boot.json'), {
    at: new Date().toISOString(),
    pid: process.pid,
    profile: state.profile,
    packageDir: PACKAGE_DIR,
    electron: process.versions.electron ?? null,
    node: process.versions.node ?? null,
  });
  log(`插件启动 pid=${process.pid} profile=${state.profile} packageDir=${PACKAGE_DIR}`);

  if (process.env.DSH_AUTO_UPDATE_DISABLE === '1') {
    log('已被 DSH_AUTO_UPDATE_DISABLE=1 关闭：本次不检查、不提供界面');
    return;
  }

  const webServer = ctx.webServer;
  if (webServer === undefined || typeof webServer.register !== 'function') {
    log('未找到 webServer 服务，仅做检查、不提供界面');
    return;
  }

  const disposeRoute = webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: createHandler(),
  });

  pendingTimer = setTimeout(() => {
    runCheck().catch(() => {});
  }, STARTUP_DELAY_MS);
  pendingTimer.unref?.();

  ctx.on('dispose', () => {
    disposed = true;
    if (pendingTimer !== undefined) clearTimeout(pendingTimer);
    try {
      disposeRoute?.();
    } catch {
      /* ignore */
    }
  });
}
