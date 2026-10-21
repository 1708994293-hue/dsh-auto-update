# Changelog

## 1.0.0 — 2026-10-21

首个公开版本。

- 每次 DSH 启动后延时检查已下载且已启用的插件（`dependencies` ∩ `dsh.profile.bundles`，排除市场禁用项与非 registry 依赖）。
- 发现新版本时在 Web 界面右下角列出 `当前 → 最新`，由用户确认后才更新。
- 更新走官方 `dsh plugin --profile <name> add <pkg>@<ver> --config.minimum-release-age=0` 通道，重启 DSH 后生效。
- Host 半提供同源 HTTP 路由 `/dsh-auto-update/status|check|apply|dismiss`，Client 半通过 `shell.overlay` 展示提示卡。
- 支持 `--check` / `--json` / `--dry-run` 手动运行，日志与状态写入插件目录。
