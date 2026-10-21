<#
.SYNOPSIS
    安装 dsh-auto-update 插件：装进当前 DSH profile 的插件列表，并在每次打开 DSH 时检查插件新版本、列出并询问是否更新。

.DESCRIPTION
    1. 把本仓库（插件包根目录）复制到 $DshHome\plugins\dsh-auto-update；
    2. 删除旧版手工写的 cordis.patch.yml 受管块（如存在，会备份）；
    3. 运行官方 `dsh plugin --profile <name> add link:<目录>` 把它作为正式 bundle 安装进 profile，
       DSH 会自动把它加入 dsh.profile.bundles 并显示在「插件」页；
    4. 插件在每次启动时延时检查已下载且启用的插件是否有新版本，在 Web 界面右下角列出并询问，
       用户确认后才调用官方 `dsh plugin ... add` 更新，更新在下次启动生效。

    安装后重启 DSH，即可在「插件」页看到 dsh-auto-update。

.PARAMETER ProfileName
    DSH profile 名称，桌面版默认 desktop。

.PARAMETER DshHome
    DSH_HOME，默认 %USERPROFILE%\.dsh。

.PARAMETER DshExe
    DeepSeek Harness.exe 路径；默认自动从卸载注册表/安装目录查找。

.PARAMETER SkipInstall
    只复制文件、不执行 `dsh plugin add`（调试用）。

.EXAMPLE
    pwsh -NoProfile -File install.ps1
#>
[CmdletBinding()]
param(
    [string]$ProfileName = 'desktop',
    [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }),
    [string]$DshExe,
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'

$sourceDir = Split-Path $PSScriptRoot -Parent
if (-not (Test-Path -LiteralPath (Join-Path $sourceDir 'package.json'))) {
    throw "找不到插件包目录：$sourceDir"
}

$installDir = Join-Path $DshHome 'plugins\dsh-auto-update'
# 包名以 package.json 为准（npm 发布名带 scope：@sueleven/dsh-auto-update）
$pkgName = (Get-Content -LiteralPath (Join-Path $sourceDir 'package.json') -Raw | ConvertFrom-Json).name
if (-not $pkgName) { throw '无法从 package.json 读取插件包名' }
$legacyNames = @('dsh-auto-update') | Where-Object { $_ -ne $pkgName }
$profileDir = Join-Path $DshHome "profiles\$ProfileName"
$profilePackage = Join-Path $profileDir 'package.json'
$patchFile = Join-Path $profileDir 'cordis.patch.yml'

if (-not (Test-Path -LiteralPath $profilePackage)) {
    throw "找不到 profile：$profileDir（请确认 -ProfileName 和 -DshHome 是否正确，或先启动一次 DSH）"
}

function Resolve-DshExe {
    if ($DshExe -and (Test-Path -LiteralPath $DshExe)) { return $DshExe }
    $uninstallRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
    if (Test-Path $uninstallRoot) {
        foreach ($key in Get-ChildItem $uninstallRoot) {
            $props = Get-ItemProperty $key.PSPath -ErrorAction SilentlyContinue
            if ($props.DisplayName -like 'DeepSeek Harness*' -and $props.InstallLocation) {
                $candidate = Join-Path $props.InstallLocation 'DeepSeek Harness.exe'
                if (Test-Path -LiteralPath $candidate) { return $candidate }
            }
        }
    }
    $candidate = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'
    if (Test-Path -LiteralPath $candidate) { return $candidate }
    throw '找不到 DeepSeek Harness.exe，请用 -DshExe 指定'
}

Write-Host "[1/4] 复制插件文件到 $installDir"
# 整体重建，避免残留旧文件（例如旧版放在根目录的 update.mjs）
if (Test-Path -LiteralPath $installDir) {
    Remove-Item -LiteralPath $installDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
# 只复制插件运行需要的文件（仓库里的 scripts/、.git、测试残留不进插件目录）
foreach ($item in @('package.json', 'cordis.patch.yml', 'icon.svg', 'README.md', 'LICENSE', 'lib')) {
    $src = Join-Path $sourceDir $item
    if (Test-Path -LiteralPath $src) {
        Copy-Item -LiteralPath $src -Destination $installDir -Recurse -Force
    }
}
# 清理旧版（手工 insert 方案）遗留的文件，避免与 bundle 双挂载
foreach ($legacy in @('plugin.cjs', 'run-now.cmd')) {
    $path = Join-Path $installDir $legacy
    if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Force
        Write-Host "    已删除旧版文件：$legacy"
    }
}

Write-Host "[2/4] 清理旧版 cordis.patch.yml 受管块"
if (Test-Path -LiteralPath $patchFile) {
    $original = Get-Content -LiteralPath $patchFile -Raw
    if ($null -eq $original) { $original = '' }
    $existing = [regex]::Match($original, '(?ms)^# >>> dsh-auto-update \(managed block\) >>>.*?^# <<< dsh-auto-update \(managed block\) <<<[ \t]*\r?\n?')
    if ($existing.Success) {
        $backup = "$patchFile.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        Copy-Item -LiteralPath $patchFile -Destination $backup -Force
        $content = $original.Remove($existing.Index, $existing.Length).TrimEnd() + "`n"
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($patchFile, $content, $utf8NoBom)
        Write-Host "    已移除旧受管块（备份：$backup）"
    }
    else {
        Write-Host '    没有旧受管块，跳过'
    }
}

Write-Host '[3/4] 检查文件'
Get-ChildItem -LiteralPath $installDir -File | ForEach-Object { Write-Host "    $($_.Name)  $($_.Length) B" }
Get-ChildItem -LiteralPath (Join-Path $installDir 'lib') -File | ForEach-Object { Write-Host "    lib\$($_.Name)  $($_.Length) B" }

if ($SkipInstall) {
    Write-Host '[4/4] 已跳过 `dsh plugin add`（-SkipInstall）'
    exit 0
}

Write-Host '[4/4] 安装为 profile bundle'
$exe = Resolve-DshExe
$asar = Join-Path (Split-Path $exe) 'resources\app.asar'
if (-not (Test-Path -LiteralPath $asar)) {
    throw "找不到 app.asar：$asar"
}
# CLI 入口在 app.asar 内部，只能交给 Electron-as-node 读取，不能用 Test-Path 探测
$cli = Join-Path $asar 'dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js'
# link: 让 profile 的 node_modules 直接指向插件目录（符号链接），源码改动立即生效；
# file: 会把整套文件复制进 node_modules，重装时还可能沿用旧副本。
$spec = 'link:' + $installDir
$previousRunAsNode = $env:ELECTRON_RUN_AS_NODE
$env:ELECTRON_RUN_AS_NODE = '1'
try {
    # Electron 是 GUI 子系统程序：用 `&` 调用不会等待、也不写 $LASTEXITCODE，
    # 必须用 Start-Process -Wait -PassThru 拿真实退出码；ArgumentList 用单个字符串并显式加引号，
    # 否则含空格的路径（DeepSeek Harness）会被再次拆开。
    # 先移除旧的无 scope 包名（历史安装），否则同一个插件会在 bundles 里出现两次、被挂载两次。
    $profileJsonBefore = Get-Content -LiteralPath $profilePackage -Raw | ConvertFrom-Json
    $beforeBundles = @($profileJsonBefore.dsh.profile.bundles)
    foreach ($legacy in $legacyNames) {
        $hasDep = @($profileJsonBefore.dependencies.PSObject.Properties.Name) -contains $legacy
        if (-not ($hasDep -or ($beforeBundles -contains $legacy))) { continue }
        Write-Host "    移除旧包名：$legacy"
        $legacyArgLine = "--expose-internals `"$cli`" plugin --profile $ProfileName remove $legacy --config.minimum-release-age=0"
        $legacyProc = Start-Process -FilePath $exe -ArgumentList $legacyArgLine -NoNewWindow -Wait -PassThru
        if ($legacyProc.ExitCode -ne 0) {
            Write-Warning "移除旧包名 $legacy 失败（退出码 $($legacyProc.ExitCode)），可手动执行：`"$exe`" --expose-internals `"$cli`" plugin --profile $ProfileName remove $legacy"
        }
    }

    $argLine = "--expose-internals `"$cli`" plugin --profile $ProfileName add `"$spec`" --config.minimum-release-age=0"
    $proc = Start-Process -FilePath $exe -ArgumentList $argLine -NoNewWindow -Wait -PassThru
    if ($proc.ExitCode -ne 0) {
        throw "dsh plugin add 失败（退出码 $($proc.ExitCode)）。可完全退出 DSH 后重试：`"$exe`" --expose-internals `"$cli`" plugin --profile $ProfileName add `"$spec`""
    }
}
finally {
    if ($null -eq $previousRunAsNode) { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
    else { $env:ELECTRON_RUN_AS_NODE = $previousRunAsNode }
}

Write-Host '    校验 profile'
$profileJson = Get-Content -LiteralPath $profilePackage -Raw | ConvertFrom-Json
$dep = @($profileJson.dependencies.PSObject.Properties) | Where-Object { $_.Name -eq $pkgName } | ForEach-Object { $_.Value }
$bundles = @($profileJson.dsh.profile.bundles)
if (-not $dep) { throw "安装后 profile package.json 里没有 $pkgName 依赖" }
if ($bundles -notcontains $pkgName) { throw "安装后 dsh.profile.bundles 里没有 $pkgName" }
Write-Host "    依赖：$dep"
Write-Host "    已加入 dsh.profile.bundles（$pkgName）"

Write-Host ''
Write-Host '完成。'
Write-Host "  插件目录：$installDir"
Write-Host "  插件列表：DSH 侧边栏「插件」页（Installed plugins）"
Write-Host "  日志：$installDir\logs\auto-update.log（检查/更新）与 logs\plugin.log（插件自身）"
Write-Host ''
Write-Host '请完全退出并重新启动 DSH。之后每次打开 DSH：右下角会列出可更新的插件并询问是否更新；'
Write-Host '点「全部更新」才会真正更新，更新在下次启动生效。'
Write-Host '临时关闭检查：设环境变量 DSH_AUTO_UPDATE_DISABLE=1。'
