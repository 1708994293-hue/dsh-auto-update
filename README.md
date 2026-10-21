# dsh-auto-update

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）插件：**每次打开 DSH 时自动检查你已经下载并启用的插件有没有新版本，发现后主动列出并询问是否更新**——点确认才更新，更新走 DSH 官方通道，不会覆盖你的 profile 配置。

- 启动约 8 秒后后台检查，不阻塞界面；
- 有新版本时右下角出现提示卡，逐条列出 `插件  当前版本 → 最新版本`；
- 按钮：**全部更新 / 稍后提醒**；无更新时完全静默；
- 更新完成后提示「重启 DSH 后生效」，与插件市场的更新语义一致。

## 安装

要求：`dsh` 0.2.1 及以上（插件声明了 `dsh.bundle` manifest）。

**从 npm 安装（推荐，任意平台）**

```sh
dsh plugin --profile desktop add dsh-auto-update
```

**从 GitHub 安装**

```sh
dsh plugin --profile desktop add github:<owner>/dsh-auto-update
```

**从本地目录安装**

```powershell
# Windows：脚本会复制插件并调用官方 dsh plugin 通道安装
pwsh -NoProfile -File scripts/install.ps1

# 任意平台：
dsh plugin --profile desktop add link:<本仓库绝对路径>
```

装完**完全退出并重启 DSH**，侧边栏「插件」页里会出现 `dsh-auto-update`。

## 如何工作

| 部分 | 文件 | 作用 |
| --- | --- | --- |
| Host 半 | `lib/index.js` | 启动延时检查、状态机、同源 HTTP 路由 `/dsh-auto-update/status|check|apply|dismiss` |
| Client 半 | `lib/client.js` | 注册 `shell.overlay` 提示卡，轮询状态、展示列表与按钮 |
| 检查/更新器 | `lib/update.mjs` | 读取 profile、查询 npm registry、按需调用官方 `dsh plugin ... add` |

检查范围：profile `package.json` 的 `dependencies` ∩ `dsh.profile.bundles`（即「已下载且已启用」），并排除市场里被禁用的包与非 registry 依赖（`file:` / `link:` / `git:` 等）。版本比较使用 semver，只在前向升级时列出，不会把插件降级。

更新方式：`<DSH exe> --expose-internals <app.asar>/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js plugin --profile <name> add <pkg>@<ver> --config.minimum-release-age=0`，即 DSH 插件市场使用的同一个官方通道。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `DSH_AUTO_UPDATE_DELAY_MS` | 启动后延时多久开始检查（默认 `8000`） |
| `DSH_AUTO_UPDATE_DISABLE=1` | 本次启动不检查、不显示提示 |
| `DSH_AUTO_UPDATE_PROFILE` | 覆盖 profile 名（默认读 `DSH_PROFILE`，否则 `desktop`） |
| `DSH_AUTO_UPDATE_DATA_DIR` | 覆盖日志/状态目录（默认插件包目录） |

## 日志

- `<插件目录>/logs/auto-update.log`：每次检查与更新的完整记录
- `<插件目录>/logs/plugin.log`：插件生命周期（启动、检查结果、用户确认、错误）
- `<插件目录>/state/last-run.json`：最近一次检查的结构化结果

插件目录：本地 `link:` 安装是 `~/.dsh/plugins/dsh-auto-update`；npm 安装是 profile 的 `node_modules/dsh-auto-update`。

## 手动使用

```sh
# 只检查，不做任何修改
node <插件目录>/lib/update.mjs --check

# 列出可更新项（JSON）
node <插件目录>/lib/update.mjs --check --json
```

`update.mjs` 支持 `--profile`、`--check`、`--json`、`--dry-run`、`--help`。

## 卸载

```sh
dsh plugin --profile desktop remove dsh-auto-update
```

Windows 本地安装可再用 `pwsh -NoProfile -File scripts/uninstall.ps1` 删除插件目录。

## 开发

```sh
node --check lib/index.js   # package.json 里 type=module
node lib/update.mjs --check --dry-run
```

本地联调可把 profile 依赖换成 `link:<仓库路径>`，改完代码重启 DSH 即可生效。

## 发布到插件市场

[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 是 DSH 插件目录（dsh-market 与「插件 → 发现」的索引都来自它）。上架步骤：仓库公开、带 `dsh-plugin` topic、仓库创建满 1 天，然后向该仓库提 PR，新增单文件 `data/plugins/<owner>__dsh-auto-update.yml`：

```yaml
url: https://github.com/<owner>/dsh-auto-update
name: <owner>/dsh-auto-update
category: workflow
description:
  en: Checks enabled DSH plugins for new versions at startup and asks before updating them.
  zh: 每次打开 DSH 自动检查已启用插件的新版本，列出并询问是否更新。
```

## English

A DeepSeek Harness plugin that checks your installed-and-enabled plugins for newer versions on every DSH launch, lists what it finds, and updates only after you confirm. Updates go through the official `dsh plugin add` channel and take effect after a restart.

```sh
dsh plugin --profile desktop add dsh-auto-update
```

## License

MIT
