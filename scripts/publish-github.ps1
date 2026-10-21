<#
.SYNOPSIS
    把 dsh-auto-update 仓库发布到 GitHub（公开仓库 + dsh-plugin topic）。

.DESCRIPTION
    1. 检查 git / gh 是否存在，缺失时尝试用 winget 安装；
    2. 未登录 GitHub 时启动 `gh auth login --web`（在浏览器里完成一次授权）；
    3. 补全 package.json 的 repository/homepage/bugs；
    4. git init / commit，`gh repo create --public --source . --push`；
    5. 添加 dsh-plugin 等 topic，并生成提交 awesome-dsh-plugin 用的条目文件。

.EXAMPLE
    pwsh -NoProfile -File scripts/publish-github.ps1
    pwsh -NoProfile -File scripts/publish-github.ps1 -Owner myname -Repo dsh-auto-update
#>
[CmdletBinding()]
param(
    [string]$Owner,
    [string]$Repo = 'dsh-auto-update',
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

function Add-ToolPaths {
    $candidates = @(
        'C:\Program Files\Git\cmd',
        (Join-Path $env:LOCALAPPDATA 'Programs\Git\cmd')
    )
    foreach ($p in $candidates) { if ((Test-Path -LiteralPath $p) -and ($env:PATH -notlike "*$p*")) { $env:PATH = "$p;$env:PATH" } }
    $ghCandidates = @(
        'C:\Program Files\GitHub CLI',
        (Join-Path $env:LOCALAPPDATA 'Programs\GitHub CLI'),
        (Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps')
    )
    foreach ($p in $ghCandidates) { if ((Test-Path -LiteralPath $p) -and ($env:PATH -notlike "*$p*")) { $env:PATH = "$p;$env:PATH" } }
}

function Ensure-Tool([string]$Name, [string]$WingetId) {
    Add-ToolPaths
    if (Get-Command $Name -ErrorAction SilentlyContinue) { return }
    if ($SkipInstall) { throw "缺少 $Name，请先安装（winget install --id $WingetId -e）" }
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw "缺少 $Name，且没有 winget；请手动安装后重试" }
    Write-Host "安装 $Name（winget $WingetId）..."
    & winget install --id $WingetId -e --source winget --accept-package-agreements --accept-source-agreements --silent
    Add-ToolPaths
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) { throw "$Name 安装后仍未找到，请重开终端后重试" }
}

Ensure-Tool 'git' 'Git.Git'
Ensure-Tool 'gh' 'GitHub.cli'

Write-Host ''
Write-Host '检查 GitHub 登录状态'
& gh auth status *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host '未登录 GitHub，启动 gh auth login --web（按提示在浏览器里输入一次性代码完成授权）'
    & gh auth login --web --git-protocol https
    if ($LASTEXITCODE -ne 0) { throw 'GitHub 登录失败' }
}

$login = (& gh api user --jq .login).Trim()
$userId = (& gh api user --jq .id).Trim()
if (-not $Owner) { $Owner = $login }
Write-Host "GitHub 用户：$login；目标仓库：$Owner/$Repo"

if (-not (git config user.name)) { git config user.name $login }
if (-not (git config user.email)) { git config user.email "$userId+$login@users.noreply.github.com" }

Write-Host ''
Write-Host '补全 package.json 的仓库信息'
$nodeScript = @'
const fs = require('node:fs');
const file = 'package.json';
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
const owner = process.argv[1], repo = process.argv[2];
pkg.repository = { type: 'git', url: `git+https://github.com/${owner}/${repo}.git` };
pkg.homepage = `https://github.com/${owner}/${repo}#readme`;
pkg.bugs = { url: `https://github.com/${owner}/${repo}/issues` };
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
console.log('    repository:', pkg.repository.url);
'@
& node -e $nodeScript $Owner $Repo
if ($LASTEXITCODE -ne 0) { throw '更新 package.json 失败' }

Write-Host ''
Write-Host '初始化 git 仓库并提交'
if (-not (Test-Path -LiteralPath (Join-Path $root '.git'))) { & git init -b main *> $null }
& git add -A
& git commit -m "feat: dsh-auto-update 1.0.0 - 启动时检查插件新版本并询问是否更新" *> $null
if ($LASTEXITCODE -ne 0) { Write-Host '    没有新改动需要提交' }

Write-Host ''
Write-Host '创建/推送 GitHub 仓库'
$remote = "https://github.com/$Owner/$Repo.git"
$hasRepo = $false
& gh repo view "$Owner/$Repo" *> $null
if ($LASTEXITCODE -eq 0) { $hasRepo = $true }
if ($hasRepo) {
    $existing = (& git remote) -split "`n" | Where-Object { $_.Trim() -eq 'origin' }
    if (-not $existing) { & git remote add origin $remote }
    & git push -u origin main
}
else {
    & gh repo create "$Owner/$Repo" --public --source . --remote origin --push `
        --description "DSH 插件：启动时检查已启用插件的新版本，列出并询问是否更新"
}
if ($LASTEXITCODE -ne 0) { throw '推送 GitHub 失败' }

Write-Host ''
Write-Host '添加 dsh-plugin topic'
& gh repo edit "$Owner/$Repo" --add-topic dsh-plugin --add-topic deepseek-harness --add-topic dsh
if ($LASTEXITCODE -ne 0) { Write-Host '    topic 设置失败，可在网页手工添加 dsh-plugin' }

Write-Host ''
Write-Host '生成 awesome-dsh-plugin 条目'
$entry = Join-Path $root "market-entry.yml"
$content = @"
url: https://github.com/$Owner/$Repo
name: $Owner/$Repo
category: workflow
description:
  en: Checks installed and enabled DSH plugins for new versions on every startup and asks before updating them.
  zh: 每次打开 DSH 自动检查已启用插件的新版本，列出并询问是否更新。
"@
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($entry, $content, $utf8NoBom)
Write-Host "    已写入：$entry"
Write-Host "    提交方式：fork awesome-dsh-plugin，把该文件放到 data/plugins/$Owner`__$Repo.yml 后提 PR"

Write-Host ''
Write-Host '完成。'
Write-Host "  仓库：https://github.com/$Owner/$Repo"
Write-Host '  任意设备安装：'
Write-Host "    dsh plugin --profile desktop add github:$Owner/$Repo"
Write-Host '  发布 npm 后也可以：dsh plugin --profile desktop add dsh-auto-update'
