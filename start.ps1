# Лаунчер CanAI: находит или скачивает Node.js, устанавливает зависимости,
# один раз собирает клиент и запускает production-сервер на свободных портах.
# Файл хранится в UTF-8 с BOM для корректной кириллицы в Windows PowerShell 5.1.
$ErrorActionPreference = 'Stop'
# ⚠️ Полоса прогресса Windows PowerShell 5.1 тормозит Invoke-WebRequest и
# Expand-Archive в разы: архив Node.js (35,7 МБ) на чистой Windows скачивался
# 98 с с ней и 6 с без неё (замер 28.09.2026). Свой ход лаунчер пишет строками.
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

# ⚠️ Первый запуск покупатель проходит один. Непойманная ошибка PowerShell
# печатает красную простыню («CategoryInfo», «FullyQualifiedErrorId»), по которой
# не понять, что делать, — проверка на чистой Windows 28.09.2026 показала её на
# первом же шаге, скачивании Node.js без сети. Поэтому любая остановка
# объясняется словами; окно держит `pause` в «Start CanAI.bat».
trap {
    Write-Host ''
    Write-Host "[CanAI] $($_.Exception.Message)" -ForegroundColor Red
    Write-Host '[CanAI] Startup stopped. Fix the cause and start CanAI again; if you are unsure what to do, send this window to the person supporting your installation.'
    exit 1
}

# ⚠️ Архив, скачанный из интернета, помечает каждый распакованный файл, и на
# КАЖДОМ двойном щелчке по .bat Windows спрашивает «Не удаётся проверить
# издателя» — окно держит запуск, пока человек не ответит (проверка на чистой
# Windows 28.09.2026). Первый запуск человек уже разрешил, поэтому пометку с
# НАШИХ файлов запуска снимаем: следующий запуск и остановка не спрашивают
# снова. Трогаем только корень папки CanAI.
try {
    Get-ChildItem -Path (Join-Path $root '*') -Include '*.bat', '*.ps1' -File -ErrorAction Stop |
        Unblock-File -ErrorAction SilentlyContinue
} catch {}

# Proxy. Where the team server is unreachable directly, people switch a proxy
# on in Windows and the browser starts working while CanAI does not: Node never
# reads proxy variables on its own, so the request goes direct and stalls on
# connect. Measured on a live install: 577 ms through the proxy, 10.7 s and a
# failure without it.
#
# ⚠️ Прокси определяется ДО скачивания Node.js и `npm ci`: сеть, где наружу
# пускают только через прокси, нужна уже первому запуску. Раньше этот блок стоял
# перед стартом сервера, и `npm ci` у такого покупателя шёл напрямую и падал
# (найдено проверкой на чистой Windows 28.09.2026). Nothing is forced: without a
# configured proxy the variables stay untouched.
function Get-CanAiSystemProxy {
    try {
        $settings = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction Stop
        if ([int]$settings.ProxyEnable -ne 1) { return $null }
        $server = [string]$settings.ProxyServer
        if (-not $server) { return $null }
        # "host:port" or "http=host:port;https=host:port" - take the https entry
        # when it is spelled out, otherwise the plain one.
        if ($server -match '(?:^|;)\s*https=([^;]+)') { $server = $Matches[1] }
        elseif ($server -match '(?:^|;)\s*http=([^;]+)') { $server = $Matches[1] }
        elseif ($server -match ';') { return $null }
        if ($server -notmatch '^[a-zA-Z][a-zA-Z0-9+.-]*://') { $server = "http://$server" }
        return $server
    } catch { return $null }
}

if (-not $env:HTTPS_PROXY -and -not $env:https_proxy) {
    $systemProxy = Get-CanAiSystemProxy
    if ($systemProxy) { $env:HTTPS_PROXY = $systemProxy }
}
$canAiUsesProxy = [bool]($env:HTTPS_PROXY -or $env:https_proxy -or $env:HTTP_PROXY -or $env:http_proxy)
if ($canAiUsesProxy) {
    # The app's own servers must never go through the proxy: the tablet page lives
    # on this machine and on the local network.
    if (-not $env:NO_PROXY -and -not $env:no_proxy) {
        $env:NO_PROXY = 'localhost,127.0.0.1,::1,.local'
    }
    # No ?? here: Windows PowerShell 5.1 has no null-coalescing operator.
    $shownProxy = if ($env:HTTPS_PROXY) { $env:HTTPS_PROXY } elseif ($env:https_proxy) { $env:https_proxy } elseif ($env:HTTP_PROXY) { $env:HTTP_PROXY } else { $env:http_proxy }
    Write-Host "[CanAI] Using proxy $shownProxy"
}

$bundledNode = Join-Path $root 'runtime\node'
$nodeVersion = 'v22.23.1'
$nodeZipSha256 = '7df0bc9375723f4a86b3aa1b7cc73342423d9677a8df4538aca31a049e309c29'

function Get-CanAiFileSha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha.Dispose()
        $stream.Dispose()
    }
}

function Install-BundledNode {
    Write-Host "[CanAI] Downloading portable Node.js $nodeVersion (about 30 MB, one time)…"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $zip = Join-Path $env:TEMP 'canai-node.zip'
    $unpack = Join-Path $root 'runtime\node-unpack'
    $download = @{
        Uri = "https://nodejs.org/dist/$nodeVersion/node-$nodeVersion-win-x64.zip"
        OutFile = $zip
        UseBasicParsing = $true
    }
    # Системный прокси Invoke-WebRequest берёт сам, а заданный переменной — нет.
    # SOCKS он не умеет вовсе: такой адрес не передаём, пусть идёт как раньше.
    $downloadProxy = if ($env:HTTPS_PROXY) { $env:HTTPS_PROXY } elseif ($env:https_proxy) { $env:https_proxy } else { $null }
    if ($downloadProxy -and $downloadProxy -match '^https?://') { $download.Proxy = $downloadProxy }
    try {
        Invoke-WebRequest @download
    } catch {
        Remove-Item $zip -Force -ErrorAction SilentlyContinue
        throw "Could not download Node.js from nodejs.org ($($_.Exception.Message)). Check your internet connection, VPN, or proxy."
    }
    $actualHash = Get-CanAiFileSha256 $zip
    if ($actualHash -ne $nodeZipSha256) {
        Remove-Item $zip -Force -ErrorAction SilentlyContinue
        throw 'The Node.js archive checksum does not match'
    }
    if (Test-Path $unpack) { Remove-Item $unpack -Recurse -Force }
    New-Item -ItemType Directory -Force $unpack | Out-Null
    Expand-Archive $zip -DestinationPath $unpack -Force
    $downloaded = Join-Path $unpack "node-$nodeVersion-win-x64"
    if (-not (Test-Path (Join-Path $downloaded 'node.exe'))) { throw 'The downloaded Node.js archive is damaged or incomplete' }
    if (Test-Path $bundledNode) { Remove-Item $bundledNode -Recurse -Force }
    Move-Item $downloaded $bundledNode
    Remove-Item $unpack -Recurse -Force
    Remove-Item $zip -Force
}

if (Test-Path (Join-Path $bundledNode 'node.exe')) {
    $installedVersion = & (Join-Path $bundledNode 'node.exe') -v
    if ($installedVersion -ne $nodeVersion) { Install-BundledNode }
    $env:Path = "$bundledNode;$env:Path"
    Write-Host "[CanAI] Using bundled Node.js from runtime\node"
} elseif (Get-Command node -ErrorAction SilentlyContinue) {
    $systemVersion = node -v
    $systemMajor = [int](($systemVersion -replace '^v', '').Split('.')[0])
    if ($systemMajor -lt 22) { throw "Node.js 22 or newer is required; found $systemVersion" }
    Write-Host "[CanAI] Using system Node.js $systemVersion"
} else {
    Install-BundledNode
    $env:Path = "$bundledNode;$env:Path"
    Write-Host "[CanAI] Node.js installed in runtime\node"
}

function Test-CanAiDependenciesNeedSync([string]$Package) {
    $dir = Join-Path $root $Package
    $lock = Join-Path $dir 'package-lock.json'
    $modules = Join-Path $dir 'node_modules'
    $marker = Join-Path $modules '.canai-lock.sha256'
    $lockHash = Get-CanAiFileSha256 $lock
    $markerHash = if (Test-Path $marker) { (Get-Content $marker -Raw).Trim() } else { '' }
    return -not (Test-Path $modules) -or $markerHash -ne $lockHash
}

function Sync-CanAiDependencies([string]$Package) {
    if (-not (Test-CanAiDependenciesNeedSync $Package)) { return }
    $dir = Join-Path $root $Package
    $lock = Join-Path $dir 'package-lock.json'
    $marker = Join-Path $dir 'node_modules\.canai-lock.sha256'
    $lockHash = Get-CanAiFileSha256 $lock
    Write-Host "[CanAI] Syncing dependencies in '$Package'…"
    Push-Location $dir
    npm ci --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) { Pop-Location; throw "Could not install dependencies in '$Package' (npm ci, see the error above). For EPERM/EACCES, close development or preview servers using this folder and retry; also check file permissions or antivirus. For network errors, check your internet connection, VPN, or proxy." }
    Pop-Location
    Set-Content -Path $marker -Value $lockHash -Encoding Ascii
}

# Production-сервер запускается через server/node_modules и на Windows держит
# esbuild.exe открытым. Его зависимости синхронизируем только ПОСЛЕ проверки и
# безопасного shutdown прежнего экземпляра.
$serverDependenciesNeedSync = Test-CanAiDependenciesNeedSync 'server'

# ⚠️ Корневые и клиентские пакеты нужны ТОЛЬКО сборке интерфейса — сервер их не
# читает (движок лиц он отдаёт из собранного client/dist). В поставке интерфейс
# уже собран, а ставились они всегда: на чистой Windows 28.09.2026 это 260 МБ
# клиентских и 5 МБ корневых пакетов против 75 МБ серверных — покупатель качал и
# хранил их ни за что. Теперь они ставятся перед сборкой, когда она нужна.
$distIndex = Join-Path $root 'client\dist\index.html'
$tabletDistIndex = Join-Path $root 'client\dist\tablet\tablet.html'
$needsBuild = -not (Test-Path $distIndex) -or -not (Test-Path $tabletDistIndex)
# ⚠️ Поставке покупателя (build-info.json есть, .git нет) интерфейс собран
# заранее, и по датам её судить нельзя: у архива, скачанного из интернета,
# Проводник при распаковке ставит КАЖДОМУ файлу время распаковки — замер
# 28.09.2026: новее собранного index.html оказались 943 исходника из 943 (без
# пометки «из интернета» — 0). По датам лаунчер пересобирал интерфейс у каждого
# покупателя и качал для этого 265 МБ пакетов. Копия, которая обновляется через
# git, по-прежнему решает по датам: у неё исходники правда меняются.
$shippedBuild = (Test-Path (Join-Path $root 'build-info.json')) -and -not (Test-Path (Join-Path $root '.git'))
if (-not $needsBuild -and -not $shippedBuild) {
    $distTime = (Get-Item $distIndex).LastWriteTimeUtc
    $sourceDirs = @((Join-Path $root 'client\src'), (Join-Path $root 'client\public'))
    # packages\ — общие исходники, которые тоже попадают в собранный интерфейс
    # (страницы берут packages\prompt-chat и packages\model-catalog, а сервер читает
    # те же файлы на лету). Без этой папки правка, сделанная только там, доходила
    # до сервера, но не до собранных страниц. Папки может не быть — это не ошибка.
    $sharedSources = Join-Path $root 'packages'
    if (Test-Path $sharedSources) { $sourceDirs += $sharedSources }
    # @(): при одном найденном файле PowerShell вернул бы сам файл, и «+=» ниже упал бы.
    $sourceFiles = @(Get-ChildItem $sourceDirs -Recurse -File)
    $sourceFiles += Get-Item (Join-Path $root 'client\package.json'), (Join-Path $root 'client\package-lock.json'), (Join-Path $root 'client\vite.config.ts'), (Join-Path $root 'client\vite.tablet.config.ts')
    $needsBuild = $null -ne ($sourceFiles | Where-Object { $_.LastWriteTimeUtc -gt $distTime } | Select-Object -First 1)
}
if ($needsBuild) {
    foreach ($pkg in @('.', 'client')) { Sync-CanAiDependencies $pkg }
    Write-Host "[CanAI] Building the UI (about 10 seconds)…"
    Push-Location (Join-Path $root 'client')
    npm run build
    if ($LASTEXITCODE -ne 0) { Pop-Location; throw 'Could not build the UI' }
    Pop-Location
}

$requestedPort = if ($env:PORT) { [int]$env:PORT } else { 8787 }
$requestedRemotePort = $null
if ($env:CANAI_REMOTE_PORT) {
    $parsedRemotePort = 0
    if (
        -not [int]::TryParse([string]$env:CANAI_REMOTE_PORT, [ref]$parsedRemotePort) -or
        $parsedRemotePort -lt 1 -or
        $parsedRemotePort -gt 65535
    ) {
        throw "Invalid tablet port CANAI_REMOTE_PORT: $($env:CANAI_REMOTE_PORT)"
    }
    $requestedRemotePort = $parsedRemotePort
}
$dataRoot = if ($env:CANAI_DATA_DIR) {
    $resolvedDataRoot = [IO.Path]::GetFullPath($env:CANAI_DATA_DIR)
    $env:CANAI_DATA_DIR = $resolvedDataRoot
    $resolvedDataRoot
} else {
    Join-Path $root 'server\data'
}
$controlPath = Join-Path $dataRoot 'runtime-control.json'

function Get-CanAiServerFingerprint {
    $serverRoot = Join-Path $root 'server'
    $files = @(Get-ChildItem (Join-Path $serverRoot 'src') -Recurse -File)
    $files += Get-Item (Join-Path $serverRoot 'package.json'), (Join-Path $serverRoot 'package-lock.json')
    [string[]]$entries = $files | ForEach-Object {
        $relative = $_.FullName.Substring($serverRoot.Length + 1).Replace('\', '/')
        $hash = Get-CanAiFileSha256 $_.FullName
        "$relative=$hash"
    }
    [Array]::Sort($entries, [StringComparer]::Ordinal)
    $bytes = [Text.Encoding]::UTF8.GetBytes(($entries -join "`n"))
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

$serverFingerprint = Get-CanAiServerFingerprint
$env:CANAI_SERVER_FINGERPRINT = $serverFingerprint

# Is anything listening on our port? (.NET check works on any PowerShell version)
function Test-PortListening([int]$p) {
    $client = New-Object Net.Sockets.TcpClient
    try {
        $client.Connect('127.0.0.1', $p)
        return $true
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Find-FreeCanAiPort([int]$StartPort, [object]$FixedRemotePort = $null) {
    $maxMainPort = if ($null -eq $FixedRemotePort) { 65533 } else { 65535 }
    if ($StartPort -lt 1 -or $StartPort -gt $maxMainPort) { return $null }
    $last = [Math]::Min($maxMainPort, $StartPort + 99)
    for ($candidate = $StartPort; $candidate -le $last; $candidate++) {
        $remoteCandidate = if ($null -eq $FixedRemotePort) { $candidate + 2 } else { [int]$FixedRemotePort }
        if (
            $candidate -ne $remoteCandidate -and
            -not (Test-PortListening $candidate) -and
            -not (Test-PortListening $remoteCandidate)
        ) {
            return $candidate
        }
    }
    return $null
}

function Get-CanAiRuntimeControl {
    try {
        if (-not (Test-Path -LiteralPath $controlPath -PathType Leaf)) { return $null }
        $item = Get-Item -LiteralPath $controlPath
        if ($item.Length -gt 16384) { return $null }
        $control = Get-Content -LiteralPath $controlPath -Raw | ConvertFrom-Json
        $controlPort = [int]$control.port
        if (
            $control.version -ne 1 -or
            $controlPort -lt 1 -or
            $controlPort -gt 65535 -or
            [string]::IsNullOrWhiteSpace([string]$control.instanceId)
        ) {
            return $null
        }
        return $control
    } catch {
        return $null
    }
}

# Return the status only when the listener is recognizably CanAI.
function Get-CanAiStatus([string]$u) {
    try {
        $response = Invoke-WebRequest "$u/api/status" -UseBasicParsing -TimeoutSec 3
        $status = $response.Content | ConvertFrom-Json
        if ($null -eq $status.falConfigured -or $null -eq $status.mockMode) { return $null }
        return $status
    } catch {
        return $null
    }
}

function Request-CanAiShutdown([string]$u, [object]$status, [string]$file, [int]$p) {
    try {
        if (-not (Test-Path -LiteralPath $file)) { throw 'control file is missing' }
        $controlItem = Get-Item -LiteralPath $file
        if ($controlItem.Length -gt 16384) { throw 'control file is too large' }
        $control = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
        $token = [string]$control.shutdownToken
        if (
            $control.version -ne 1 -or
            $control.port -ne $p -or
            [string]$control.instanceId -ne [string]$status.instanceId -or
            [string]::IsNullOrWhiteSpace($token) -or
            $token.Length -gt 256
        ) {
            throw 'control file does not match the running server'
        }
    } catch {
        Write-Host '[CanAI] Could not verify that the demo server belongs to this CanAI copy.'
        Write-Host '[CanAI] Nothing was stopped. Close the dev server manually and try again.'
        return $false
    }

    try {
        Invoke-WebRequest "$u/api/lifecycle/shutdown" `
            -Method Post `
            -Headers @{ 'x-canai-shutdown-token' = $token } `
            -UseBasicParsing `
            -TimeoutSec 5 | Out-Null
    } catch {
        Write-Host '[CanAI] The demo server did not accept the safe shutdown request.'
        Write-Host '[CanAI] Nothing was stopped. Close the dev server manually and try again.'
        return $false
    }

    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $deadline) {
        if (-not (Test-PortListening $p)) { return $true }
        Start-Sleep -Milliseconds 250
    }
    Write-Host '[CanAI] The demo server did not release its port within 15 seconds.'
    Write-Host '[CanAI] The production server was not started so no process would be killed forcefully.'
    return $false
}

# The launcher can write into the server log too: it is the only one still
# alive when the server dies for good.
function Write-ServerLogLine([string]$text) {
    try {
        $dir = Join-Path $dataRoot 'logs'
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        Add-Content -Path (Join-Path $dir 'server.log') -Value "[$stamp] $text" -Encoding utf8
    } catch {}
}

function Show-ServerLogTail {
    $log = Join-Path $dataRoot 'logs\server.log'
    if (Test-Path $log) {
        Write-Host ''
        Write-Host '[CanAI] Last lines of server\data\logs\server.log:'
        Get-Content $log -Tail 15
    }
}

# A second copy cannot take the same port: instead of looping forever with
# "EADDRINUSE", say what is going on and reuse the copy that already runs.
$knownControl = Get-CanAiRuntimeControl
if ($null -ne $knownControl -and [int]$knownControl.port -ne $requestedPort) {
    $knownPort = [int]$knownControl.port
    $knownUrl = "http://127.0.0.1:$knownPort"
    if (Test-PortListening $knownPort) {
        $knownStatus = Get-CanAiStatus $knownUrl
        if ($null -ne $knownStatus -and [string]$knownStatus.instanceId -eq [string]$knownControl.instanceId) {
            $knownFingerprint = [string]$knownStatus.serverFingerprint
            $knownOutdated = $serverDependenciesNeedSync -or [string]::IsNullOrWhiteSpace($knownFingerprint) -or $knownFingerprint -ne $serverFingerprint
            if (-not [bool]$knownStatus.mockMode -and -not $knownOutdated) {
                Write-Host ''
                Write-Host '[CanAI] CanAI is already running on its fallback port; opening it in the browser.'
                Write-Host "[CanAI] Address: $knownUrl. A second instance is not needed."
                if (-not $env:CANAI_NO_BROWSER) { Start-Process $knownUrl }
                Write-Host '[CanAI] This window will stay open; press any key when you want to close it.'
                exit 0
            }
            Write-Host ''
            Write-Host '[CanAI] Found an older CanAI instance on the fallback port; shutting it down safely.'
            if (-not (Request-CanAiShutdown $knownUrl $knownStatus $controlPath $knownPort)) { exit 1 }
        }
    }
}

$requestedUrl = "http://127.0.0.1:$requestedPort"
if (Test-PortListening $requestedPort) {
    $status = Get-CanAiStatus $requestedUrl
    if ($null -ne $status) {
        $runningFingerprint = [string]$status.serverFingerprint
        $serverOutdated = $serverDependenciesNeedSync -or [string]::IsNullOrWhiteSpace($runningFingerprint) -or $runningFingerprint -ne $serverFingerprint
        if ([bool]$status.mockMode -or $serverOutdated) {
            Write-Host ''
            if ([bool]$status.mockMode) {
                Write-Host '[CanAI] Found a demo dev server; shutting it down safely.'
            } else {
                Write-Host '[CanAI] An update was installed; restarting the server safely.'
            }
            if (-not (Request-CanAiShutdown $requestedUrl $status $controlPath $requestedPort)) { exit 1 }
            if ([bool]$status.mockMode) {
                Write-Host '[CanAI] Demo server stopped. Starting regular CanAI.'
            } else {
                Write-Host '[CanAI] Old server stopped. Starting the updated CanAI.'
            }
        } else {
            Write-Host ''
            Write-Host '[CanAI] CanAI is already running; opening it in the browser.'
            Write-Host "[CanAI] Address: $requestedUrl. A second instance is not needed."
            if (-not $env:CANAI_NO_BROWSER) { Start-Process $requestedUrl }
            Write-Host '[CanAI] This window will stay open; press any key when you want to close it.'
            exit 0
        }
    } else {
        Write-Host ''
        Write-Host "[CanAI] Port $requestedPort is used by another program; looking for a free address."
    }
}

Sync-CanAiDependencies 'server'

$selectedPort = Find-FreeCanAiPort $requestedPort $requestedRemotePort
if ($null -eq $selectedPort) {
    Write-Host ''
    Write-Host "[CanAI] No free CanAI ports were found starting at $requestedPort."
    Write-Host '[CanAI] Free the required port and try again.'
    exit 1
}
$port = [int]$selectedPort
$remotePort = if ($null -eq $requestedRemotePort) { $port + 2 } else { [int]$requestedRemotePort }
$env:PORT = [string]$port
$env:CANAI_REMOTE_PORT = [string]$remotePort
$url = "http://127.0.0.1:$port"
if ($port -ne $requestedPort) {
    Write-Host "[CanAI] Using free address $url (tablet port: $remotePort)."
}

# Launcher всегда запускает production. Переменная могла остаться в родительской
# PowerShell-сессии после ручного npm run dev и не должна воскресить demo-режим.
Remove-Item Env:CANAI_MOCK -ErrorAction SilentlyContinue

Write-Host ''
Write-Host "[CanAI] Starting… The browser will open at $url, when the app is ready."
Write-Host '[CanAI] To stop the app, close this window.'
Write-Host ''

# Открыть адрес мало — надо УБЕДИТЬСЯ, что браузер по нему пришёл.
#
# Chrome с несколькими профилями встречает холодный запуск экраном «Who's using
# Chrome?» и открытый адрес при этом теряет: приложение работает, порт слушает,
# а человек смотрит на выбор профиля и видит, что канвас не открылся сам
# (09.09.2026). Сервер отмечает, запрашивал ли кто-нибудь страницу интерфейса
# (uiOpened), поэтому здесь можно не гадать: не пришёл — заходим ещё раз, и к
# этому времени профиль обычно уже выбран, а значит второй заход попадает по
# адресу.
#
# ⚠️ Говорить об этом отсюда НЕЛЬЗЯ: задание живёт отдельным процессом, и его
# Write-Host до окна человека не доходит, пока идёт сервер. Поэтому строку с
# адресом печатает сам сервер — он же и знает, приходил ли за страницей кто-то.
function Start-CanAiBrowserWatcher([string]$u, [string]$fingerprint) {
    # Settings keeps the existing tab connected while its updater restarts us.
    if ($env:CANAI_NO_BROWSER) { return $null }
    return Start-Job -ScriptBlock {
        param($targetUrl, $expectedFingerprint)
        function Get-CanAiStatus($url) {
            try {
                $response = Invoke-WebRequest "$url/api/status" -UseBasicParsing -TimeoutSec 2
                return $response.Content | ConvertFrom-Json
            } catch { return $null }
        }
        $ready = $false
        for ($i = 0; $i -lt 60; $i++) {
            Start-Sleep -Seconds 1
            $status = Get-CanAiStatus $targetUrl
            if ($status -and -not [bool]$status.mockMode -and [string]$status.serverFingerprint -eq $expectedFingerprint) {
                $ready = $true
                break
            }
        }
        if (-not $ready) { return }
        # A tab of this app is ALREADY open - opening a second one is what makes
        # two tabs fight over one board and leaves a conflict copy behind. The
        # server sees a live tab by the status poll a browser sends.
        #
        # The wait matters: a restarted server starts with an empty mark, and a
        # tab that is still open needs a moment to poll again. Without it we
        # would decide before it had a chance and open the second tab anyway.
        Start-Sleep -Seconds 4
        $status = Get-CanAiStatus $targetUrl
        if ($status -and [bool]$status.uiAlive) { return }
        foreach ($attempt in 1, 2) {
            Start-Process $targetUrl
            for ($i = 0; $i -lt 12; $i++) {
                Start-Sleep -Seconds 1
                $status = Get-CanAiStatus $targetUrl
                if ($status -and [bool]$status.uiOpened) { return }
            }
        }
    } -ArgumentList $u, $fingerprint
}

# Proxy for the server itself (the variables were chosen at the top). The switch
# must be set BEFORE the process starts - Node reads it at bootstrap, and
# assigning it from inside the code changes nothing (verified). It is set here,
# not at the top, so that `npm ci` keeps working exactly as it always did.
if ($canAiUsesProxy -and -not $env:NODE_USE_ENV_PROXY) { $env:NODE_USE_ENV_PROXY = '1' }

# Corporate VPN often installs its own trusted root. Modern portable Node can
# use the Windows certificate store without weakening TLS verification.
if ((-not $env:NODE_OPTIONS) -or ($env:NODE_OPTIONS -notmatch '(?:^|\s)--use-system-ca(?:\s|$)')) {
    try {
        $nodeHelp = (& node --help 2>$null) -join "`n"
        if ($nodeHelp -match '--use-system-ca') {
            if ($env:NODE_OPTIONS) { $env:NODE_OPTIONS = "$($env:NODE_OPTIONS) --use-system-ca" }
            else { $env:NODE_OPTIONS = '--use-system-ca' }
        }
    } catch {}
}

# A hard crash of Node itself - out of memory above all - prints to the console
# and dies with it: the window closes and nothing is left to look at. The app
# "kept crashing" for days and server.log held not one line about it. The built
# in diagnostic report costs nothing while all is well and leaves a file with
# the reason, the stacks and the memory when it is not.
$logDir = Join-Path $dataRoot 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
foreach ($reportFlag in @('--report-on-fatalerror', "--report-directory=`"$logDir`"")) {
    $escaped = [Regex]::Escape($reportFlag.Split('=')[0])
    if ((-not $env:NODE_OPTIONS) -or ($env:NODE_OPTIONS -notmatch "(?:^|\s)$escaped(?:=|\s|$)")) {
        if ($env:NODE_OPTIONS) { $env:NODE_OPTIONS = "$($env:NODE_OPTIONS) $reportFlag" }
        else { $env:NODE_OPTIONS = $reportFlag }
    }
}

# Run the server; restart it automatically if it ever crashes. A crash that
# happens right after start is a startup failure, not a hiccup: after a few of
# them in a row we stop and explain instead of spamming the window forever.
$maxQuickFailures = 3
$quickFailures = 0
# Address the browser was already sent to. A restart on the SAME address must
# not open a second tab: the person still has the first one and it reconnects
# by itself, while two tabs on one board make the server write a conflict copy
# - so one crash would cost a duplicated board. A NEW address (the port got
# taken) has nobody looking at it, and there we do open the browser.
$openedUrl = $null
while ($true) {
    $browserJob = $null
    if ($openedUrl -ne $url) {
        $browserJob = Start-CanAiBrowserWatcher $url $serverFingerprint
        $openedUrl = $url
    }
    $startedAt = Get-Date
    npm --prefix server run start
    # The launcher writes down EVERY end of the server, a clean one included.
    # That is the whole trick for telling two very different deaths apart: if
    # this line is missing while the server logged a signal, the console window
    # itself was closed and took the launcher with it. If the line is there,
    # the server went away on its own and the launcher outlived it.
    # The code is taken FIRST: anything called in between could change it.
    $exitCode = $LASTEXITCODE
    Write-ServerLogLine "[launcher] server stopped, exit code $exitCode"
    if ($exitCode -eq 0) { break }
    if ($null -ne $browserJob) {
        Stop-Job $browserJob -ErrorAction SilentlyContinue
        Remove-Job $browserJob -Force -ErrorAction SilentlyContinue
    }

    if (((Get-Date) - $startedAt).TotalSeconds -lt 10) { $quickFailures++ } else { $quickFailures = 1 }

    if ($quickFailures -lt $maxQuickFailures -and ((Test-PortListening $port) -or (Test-PortListening $remotePort))) {
        $nextPort = Find-FreeCanAiPort ($port + 1) $requestedRemotePort
        if ($null -eq $nextPort) {
            Write-Host ''
            Write-Host "[CanAI] No other free ports were found after the startup conflict."
            exit 1
        }
        $port = [int]$nextPort
        $remotePort = if ($null -eq $requestedRemotePort) { $port + 2 } else { [int]$requestedRemotePort }
        $env:PORT = [string]$port
        $env:CANAI_REMOTE_PORT = [string]$remotePort
        $url = "http://127.0.0.1:$port"
        Write-Host "[CanAI] The port was taken; choosing another free address: $url (tablet port: $remotePort)."
    }

    if ($quickFailures -ge $maxQuickFailures) {
        Write-Host ''
        Write-Host "[CanAI] The server failed to start $quickFailures times in a row; stopping."
        if ((Test-PortListening $port) -or (Test-PortListening $remotePort)) {
            if ($null -ne (Get-CanAiStatus $url)) {
                Write-Host "[CanAI] Another CanAI instance is already running: open $url"
            } else {
                Write-Host "[CanAI] Port $port or tablet port $remotePort is used by another program; close it and try again."
            }
        }
        Show-ServerLogTail
        Write-Host ''
        Write-Host '[CanAI] If the error repeats, send server\data\logs\server.log to the person supporting your installation.'
        exit 1
    }

    Write-Host "[CanAI] The server stopped unexpectedly (code $exitCode). Restarting in 2 seconds… (attempt $quickFailures of $maxQuickFailures)"
    Start-Sleep -Seconds 2
}
