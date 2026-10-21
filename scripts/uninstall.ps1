<#
.SYNOPSIS
    卸载 dsh-auto-update 插件：从 profile 移除 bundle 依赖与插件文件。

.DESCRIPTION
    1. 运行官方 `dsh plugin --profile <name> remove dsh-auto-update`；
    2. 删除 $DshHome\plugins\dsh-auto-update（可用 -KeepFiles 保留日志/状态）；
    3. 清理旧版可能残留在 cordis.patch.yml 的受管块（带备份）。

.PARAMETER ProfileName
    DSH profile 名称，桌面版默认 desktop。

.PARAMETER DshHome
    DSH_HOME，默认 %USERPROFILE%\.dsh。

.PARAMETER DshExe
    DeepSeek Harness.exe 路径；默认自动查找。

.PARAMETER KeepFiles
    只从 profile 卸载，保留插件目录里的日志与状态。

.EXAMPLE
    pwsh -NoProfile -File uninstall.ps1
#>
[CmdletBinding()]
param(
    [string]$ProfileName = 'desktop',
    [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }),
    [string]$DshExe,
    [switch]$KeepFiles
)

$ErrorActionPreference = 'Stop'

$installDir = Join-Path $DshHome 'plugins\dsh-auto-update'
$profileDir = Join-Path $DshHome "profiles\$ProfileName"
$profilePackage = Join-Path $profileDir 'package.json'
$patchFile = Join-Path $profileDir 'cordis.patch.yml'

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
    return $null
}

if (Test-Path -LiteralPath $profilePackage) {
    $profileJson = Get-Content -LiteralPath $profilePackage -Raw | ConvertFrom-Json
    if ($profileJson.dependencies.'dsh-auto-update') {
        Write-Host '[1/3] 从 profile 移除 bundle'
        $exe = Resolve-DshExe
        if (-not $exe) { throw '找不到 DeepSeek Harness.exe，请用 -DshExe 指定' }
        $cli = Join-Path (Split-Path $exe) 'resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js'
        $previousRunAsNode = $env:ELECTRON_RUN_AS_NODE
        $env:ELECTRON_RUN_AS_NODE = '1'
        try {
            # Electron 是 GUI 子系统程序：用 `&` 调用不会等待、也不写 $LASTEXITCODE，
            # 必须用 Start-Process -Wait -PassThru 拿真实退出码；ArgumentList 用单个字符串并显式加引号，
            # 否则含空格的路径（DeepSeek Harness）会被再次拆开。
            $argLine = "--expose-internals `"$cli`" plugin --profile $ProfileName remove dsh-auto-update --config.minimum-release-age=0"
            $proc = Start-Process -FilePath $exe -ArgumentList $argLine -NoNewWindow -Wait -PassThru
            if ($proc.ExitCode -ne 0) { throw "dsh plugin remove 失败（退出码 $($proc.ExitCode)）" }
        }
        finally {
            if ($null -eq $previousRunAsNode) { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
            else { $env:ELECTRON_RUN_AS_NODE = $previousRunAsNode }
        }
    }
    else {
        Write-Host '[1/3] profile 里没有 dsh-auto-update 依赖，跳过'
    }

    $after = Get-Content -LiteralPath $profilePackage -Raw | ConvertFrom-Json
    if ($after.dependencies.'dsh-auto-update') { throw '卸载失败：依赖仍在 profile package.json 中（可能 DSH 正在运行或 pnpm 报错）' }
    if (@($after.dsh.profile.bundles) -contains 'dsh-auto-update') { throw '卸载失败：dsh.profile.bundles 里仍有 dsh-auto-update' }
    Write-Host '    已从依赖与 bundles 中移除'
}
else {
    Write-Host '[1/3] 找不到 profile package.json，跳过 profile 卸载'
}

Write-Host '[2/3] 清理旧版 cordis.patch.yml 受管块'
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

Write-Host '[3/3] 删除插件文件'
if ($KeepFiles) {
    Write-Host "    保留 $installDir（-KeepFiles）"
}
elseif (Test-Path -LiteralPath $installDir) {
    Remove-Item -LiteralPath $installDir -Recurse -Force
    Write-Host "    已删除 $installDir"
}
else {
    Write-Host '    插件目录不存在，跳过'
}

Write-Host ''
Write-Host '完成。重启 DSH 后插件列表中不再出现 dsh-auto-update。'
