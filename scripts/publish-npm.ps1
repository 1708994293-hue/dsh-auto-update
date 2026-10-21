<#
.SYNOPSIS
    发布 dsh-auto-update 到 npm（npm 上包名为 @sueleven/dsh-auto-update；发布后任意设备可 `dsh plugin add @sueleven/dsh-auto-update` 安装）。

.DESCRIPTION
    1. 本地语法检查及前端加载回归测试；
    2. 检查 npm 登录状态（未登录会提示先运行 npm login --auth-type=web）；
    3. npm publish --access public；
    4. 从 registry 读回版本确认发布成功。

.EXAMPLE
    pwsh -NoProfile -File scripts/publish-npm.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$pkg = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
if (-not $pkg.name) { throw 'package.json 里没有 name' }
Write-Host "发布包：$($pkg.name)@$($pkg.version)"

Write-Host ''
Write-Host '[1/3] 本地检查'
& npm run check
if ($LASTEXITCODE -ne 0) { throw '语法检查或前端加载回归测试失败' }
Write-Host '    语法及前端加载检查 OK'

Write-Host ''
Write-Host '[2/3] npm 登录状态'
& npm whoami *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host '    未登录 npm。请先运行： npm login --auth-type=web'
    throw '需要先登录 npm'
}
$who = (& npm whoami).Trim()
Write-Host "    已登录：$who"

Write-Host ''
Write-Host '[3/3] npm publish'
& npm publish --access public
if ($LASTEXITCODE -ne 0) { throw 'npm publish 失败' }

Write-Host ''
Write-Host '校验 registry'
$encoded = $pkg.name.Replace('/', '%2F')
$script = "const r=await fetch('https://registry.npmjs.org/$encoded/latest');const j=await r.json();console.log('registry version:',j.version);"
& node --input-type=module -e $script
if ($LASTEXITCODE -ne 0) { throw 'registry 校验失败' }

Write-Host ''
Write-Host '完成。任意设备安装：'
Write-Host "  dsh plugin --profile desktop add $($pkg.name)"
