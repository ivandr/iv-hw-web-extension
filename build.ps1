# Сборка Chrome Web Store zip.
#
# Запускать из корня проекта: `.\build.ps1`
# Если PowerShell ругается на execution policy, запусти так:
#     powershell -ExecutionPolicy Bypass -File .\build.ps1
#
# Создаёт `warden-<version>.zip` в корне, имя версии берётся из manifest.json.
# В zip попадают ТОЛЬКО manifest.json + src/ + icons/ + _locales/. README, .git,
# .idea, tools/ (popup-preview), node_modules/, старые zip-ы — отсекаются.
#
# manifest.json в zip патчится: убираются host_permissions для localhost (нужны только
# в DEV-сборке Load unpacked для fan-out на локальный ms-hw). На прод-копии в Chrome Web
# Store фетчи на localhost не идут (chrome.management.getSelf().installType=='normal' →
# targets=[PROD] only), и broad-permission на localhost только провоцирует ревьюеров.
# Также вырезаются DEV-only: nextersglobal.com host_permissions и `webRequest`/`downloads`
# permissions (gamedata dumper — splitlib/переводы/remote-config в Chrome Downloads).
#
# Почему такой рукопашный способ: PowerShell 5.1 (Windows по умолчанию) в
# CreateFromDirectory пишет пути с backslash-ами — ZIP-спецификация требует
# forward-slashes, и это ломает кросс-платформенные анализаторы. Поэтому
# добавляем файлы по одному с явной заменой слэшей.

$ErrorActionPreference = 'Stop'
# PowerShell 5.1 по умолчанию шлёт Write-Host через legacy-кодировку консоли (cp866/Win1251),
# из-за чего русские строки рендерятся как "РЎРѕР·РґР°РЅ". Переключаем на UTF-8.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$base = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $base

# Читаем version из manifest.json чтобы имя zip'а отражало релиз
$manifestPath = Join-Path $base 'manifest.json'
if (-not (Test-Path $manifestPath)) {
    Write-Error "manifest.json not found in $base"
    exit 1
}
$manifest = Get-Content $manifestPath -Raw -Encoding utf8 | ConvertFrom-Json
$version = $manifest.version
if (-not $version) {
    Write-Error "version not set in manifest.json"
    exit 1
}

$zipPath = Join-Path $base "warden-$version.zip"
if (Test-Path $zipPath) {
    Remove-Item $zipPath -Force
}

# Чистим любые .zip кроме ожидаемого — чтобы в папке не копились версии
Get-ChildItem -Path $base -Filter 'warden-*.zip' -File | Where-Object { $_.FullName -ne $zipPath } | ForEach-Object {
    Write-Host "  удаляю устаревший: $($_.Name)" -ForegroundColor DarkGray
    Remove-Item $_.FullName -Force
}

Add-Type -AssemblyName System.IO.Compression.FileSystem

$zip = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')
try {
    # manifest.json в корне архива — без `http://localhost/*` в host_permissions
    # И без localhost-матчей в content_scripts (нужны только для DEV Load unpacked,
    # в prod-копии лишний broad-match привлекает внимание ревьюеров CWS).
    # Также вырезаем DEV-only фичи: gamedata dumper (nextersglobal.com host + webRequest/downloads
    # permissions) — он живёт только в DEV-сборке для выгрузки дампов у разработчика.
    $prodManifest = Get-Content $manifestPath -Raw -Encoding utf8 | ConvertFrom-Json

    $devOnlyHostRegex = '^(http://localhost|https://[^/]*\.nextersglobal\.com)'
    $kept     = @($prodManifest.host_permissions | Where-Object { $_ -notmatch $devOnlyHostRegex })
    $stripped = @($prodManifest.host_permissions | Where-Object { $_ -match $devOnlyHostRegex })
    $prodManifest.host_permissions = $kept
    if ($stripped.Count -gt 0) {
        Write-Host "  убрано из host_permissions для prod-сборки: $($stripped -join ', ')" -ForegroundColor DarkGray
    }

    $devOnlyPerms = @('webRequest', 'downloads')
    $permsKept     = @($prodManifest.permissions | Where-Object { $devOnlyPerms -notcontains $_ })
    $permsStripped = @($prodManifest.permissions | Where-Object { $devOnlyPerms -contains $_ })
    $prodManifest.permissions = $permsKept
    if ($permsStripped.Count -gt 0) {
        Write-Host "  убрано из permissions для prod-сборки: $($permsStripped -join ', ')" -ForegroundColor DarkGray
    }

    foreach ($cs in $prodManifest.content_scripts) {
        $csKept     = @($cs.matches | Where-Object { $_ -notmatch '^http://localhost' })
        $csStripped = @($cs.matches | Where-Object { $_ -match '^http://localhost' })
        $cs.matches = $csKept
        if ($csStripped.Count -gt 0) {
            Write-Host "  убрано из content_scripts.matches для prod-сборки: $($csStripped -join ', ')" -ForegroundColor DarkGray
        }
    }

    $prodManifestJson = $prodManifest | ConvertTo-Json -Depth 10

    $manifestEntry = $zip.CreateEntry('manifest.json', 'Optimal')
    $manifestStream = $manifestEntry.Open()
    try {
        $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($prodManifestJson)
        $manifestStream.Write($bytes, 0, $bytes.Length)
    } finally {
        $manifestStream.Dispose()
    }

    # src/, icons/ и _locales/ рекурсивно, с forward-slash entry names
    $prefix = $base + '\'
    Get-ChildItem -Path (Join-Path $base 'src'), (Join-Path $base 'icons'), (Join-Path $base '_locales') -Recurse -File | ForEach-Object {
        $rel = $_.FullName.Substring($prefix.Length).Replace('\', '/')
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel, 'Optimal') | Out-Null
    }
} finally {
    $zip.Dispose()
}

# Красивый отчёт
$info = Get-Item $zipPath
Write-Host ""
Write-Host "Создан: $($info.Name) ($([math]::Round($info.Length / 1024, 1)) KB)" -ForegroundColor Green

$entries = [System.IO.Compression.ZipFile]::OpenRead($zipPath).Entries
try {
    Write-Host "Файлов: $($entries.Count)"
    $entries | ForEach-Object { Write-Host "  $($_.FullName)" -ForegroundColor Gray }
} finally {
    # Закрываем read-handle перед выходом
    ($entries | Select-Object -First 1).Archive.Dispose()
}