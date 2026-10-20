# Builds a clean distribution zip for a release: no secret key, no personal data,
# no node_modules/runtime (the launcher installs them on first run), but WITH
# the prebuilt client (client\dist) so the first start is fast.
# Usage: powershell -ExecutionPolicy Bypass -File make-dist.ps1
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
Set-Location $root

Write-Host '[dist] Type-checking...'
npm run check
if ($LASTEXITCODE -ne 0) { throw 'type check failed' }

Write-Host '[dist] Building the client...'
npm run build
if ($LASTEXITCODE -ne 0) { throw 'client build failed' }

$stamp = Get-Date -Format 'yyyy-MM-dd'
$distRoot = [IO.Path]::GetFullPath((Join-Path $root 'dist-package'))
$expectedDistRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetFullPath($root)) 'dist-package'))
$rootPrefix = $root.TrimEnd('\') + '\'
if (-not [StringComparer]::OrdinalIgnoreCase.Equals($distRoot, $expectedDistRoot) -or
    -not $distRoot.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase) -or
    [IO.Path]::GetFileName($distRoot) -ne 'dist-package') {
    throw "Refusing unexpected distribution directory: $distRoot"
}
$existingDist = Get-Item -LiteralPath $distRoot -Force -ErrorAction SilentlyContinue
if ($null -ne $existingDist) {
    if (-not $existingDist.PSIsContainer) { throw "Refusing to remove non-directory distribution path: $distRoot" }
    if (($existingDist.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing to remove reparse-point distribution directory: $distRoot"
    }
    Remove-Item -LiteralPath $distRoot -Recurse -Force
}
$out = Join-Path $distRoot "CanAI-$stamp"
New-Item -ItemType Directory -Force $out | Out-Null

# What goes into the package. Deliberately NOT copied:
#   server\.env (the release user enters their own key), server\data (personal boards),
#   node_modules, runtime, .git, dist-package itself.
# Also deliberate:
#   - scripts\ — только сборочные инструменты (лицензии);
#     покупателю они не нужны.
#   - update.ps1/Update CanAI.bat — обновление тянет из приватного git-репозитория
#     и требует доступа соавтора; покупателю обновление приходит новым ZIP.
#   - licenses\ — ⚠️ ОБЯЗАТЕЛЬНА. THIRD-PARTY-NOTICES.md прямым текстом шлёт
#     покупателя за полными текстами «в папку licenses/», а в Windows-поставке
#     её не было вовсе: там лежат LGPL ffmpeg и LAME, то есть ровно те тексты,
#     которые обязаны ехать вместе с двоичными файлами. В macOS-поставке папка
#     была с самого начала — разошлись молча (найдено разбором поставки
#     17.09.2026).
$include = @(
    'client', 'server', 'packages', 'package.json', 'package-lock.json',
    'start.ps1', 'stop.ps1',
    'Start CanAI.bat', 'Stop CanAI.bat',
    'Migrate data.bat', 'migrate-data.ps1',
    'README.md', 'USER-GUIDE.md', 'TABLET-GUIDE.md', 'CHANGELOG.md', 'SECURITY.md',
    'THIRD-PARTY-NOTICES.md', 'licenses',
    'docs\agents',
    'docs\GETTING-STARTED.md', 'docs\help',
    'docs\images\assistant.jpg', 'docs\images\assets.jpg',
    'docs\images\canvas.jpg', 'docs\images\help.jpg',
    'docs\images\tablet.jpg', 'docs\images\workflows.jpg',
    'docs\images\gallery.jpg', 'docs\images\assistant-expanded.jpg',
    'docs\images\references.jpg', 'docs\images\compare.jpg',
    'docs\images\timeline.jpg', 'docs\images\trash.jpg',
    'docs\images\versions.jpg'
)
$include += 'LICENSE'
$publicProtocol = Join-Path $root 'docs\public\AGENT-PROTOCOL.md'
$publicManifest = Join-Path $root 'PUBLIC-SOURCE-MANIFEST.json'
$hasAuthoringProtocol = Test-Path $publicProtocol
$hasPublicManifest = $false
if (Test-Path $publicManifest) {
    try {
        $manifest = Get-Content -LiteralPath $publicManifest -Raw | ConvertFrom-Json
        $hasPublicManifest = ($manifest.format -eq 'canai-public-source' -and [int]$manifest.version -eq 1)
    } catch {
        $hasPublicManifest = $false
    }
}
if (-not $hasAuthoringProtocol -and -not $hasPublicManifest) {
    throw 'public protocol source is missing (expected docs\public\AGENT-PROTOCOL.md or a valid PUBLIC-SOURCE-MANIFEST.json)'
}
if ($hasPublicManifest -and -not (Test-Path (Join-Path $root 'docs\agents\README.md'))) {
    throw 'public protocol README is missing from the exported source'
}
foreach ($item in $include) {
    $src = Join-Path $root $item
    if (-not (Test-Path $src)) { throw "required file is missing: $item" }
    Write-Host "[dist] + $item"
    if (Test-Path $src -PathType Container) {
        # dist-tablet-cloud — планшетная страница ДЛЯ СЕРВЕРА КОМАНДЫ: её
        # раздаёт он сам, здесь она не открывается ничем и весит 28 МБ.
        $copyArgs = @('/E', '/XD', 'node_modules', 'data', 'dist-package', '.git', 'dist-tablet-cloud', '/XF', '.env', '*.env*')
        if ($item -eq 'docs\agents') {
            $copyArgs += @('CLOUD.md', 'IMPLEMENTATION.md', 'ADAPTATION.md')
            if ($hasAuthoringProtocol) { $copyArgs += 'README.md' }
        }
        robocopy $src (Join-Path $out $item) @copyArgs /NFL /NDL /NJH /NJS | Out-Null
        if ($LASTEXITCODE -ge 8) { throw "copy failed: $item" }
    } else {
        $destination = Join-Path $out $item
        New-Item -ItemType Directory -Force (Split-Path -Parent $destination) | Out-Null
        Copy-Item $src $destination -Force
    }
}

if ($hasAuthoringProtocol) {
    $protocolTarget = Join-Path $out 'docs\agents\README.md'
    New-Item -ItemType Directory -Force (Split-Path -Parent $protocolTarget) | Out-Null
    Copy-Item $publicProtocol $protocolTarget -Force
}

Write-Host '[dist] Building the third-party license list directly into the package...'
$licenseGenerator = Join-Path $root 'scripts\generate-third-party.mjs'
if (-not (Test-Path $licenseGenerator)) { throw 'third-party license generator is missing' }
node $licenseGenerator (Join-Path $out 'THIRD-PARTY-LICENSES.txt')
if ($LASTEXITCODE -ne 0) { throw 'third-party license generation failed' }

# Build number as a file: a release package has no .git, and without it every
# complaint starts with guessing which version they run (fix list item 5.1).
Write-Host '[dist] Writing build number...'
npm --prefix server run build-info -- $out
if ($LASTEXITCODE -ne 0) { throw 'build number is unknown' }
if (-not (Test-Path (Join-Path $out 'build-info.json'))) { throw 'build number is missing' }

# client\dist is excluded by the folder copy above only if named 'data'/'node_modules';
# make sure it IS present (prebuilt UI = fast first start).
if (-not (Test-Path (Join-Path $out 'client\dist\index.html'))) {
    Write-Host '[dist] copying client\dist...'
    robocopy (Join-Path $root 'client\dist') (Join-Path $out 'client\dist') /E /NFL /NDL /NJH /NJS | Out-Null
    if ($LASTEXITCODE -ge 8) { throw 'client dist copy failed' }
}

# Pages that must be built: the app and tablet entry points.
# Without the tablet page, a release user sees a missing-page error on first access.
foreach ($page in @('client\dist\index.html', 'client\dist\tablet\tablet.html')) {
    if (-not (Test-Path (Join-Path $out $page))) { throw "missing built page: $page" }
}

if (Test-Path (Join-Path $out 'server\.env')) { throw 'server secret leaked into package' }
if (Test-Path (Join-Path $out 'server\data')) { throw 'personal data leaked into package' }
if (-not (Test-Path (Join-Path $out 'client\public\fonts\OFL.txt'))) { throw 'font license is missing' }
if ((Get-Item (Join-Path $out 'THIRD-PARTY-LICENSES.txt')).Length -lt 10000) { throw 'third-party licenses are incomplete' }
if (-not (Get-ChildItem (Join-Path $out 'licenses') -File -ErrorAction SilentlyContinue)) { throw 'licenses folder is missing or empty' }
if (Test-Path (Join-Path $out 'client\dist-tablet-cloud')) { throw 'cloud tablet build leaked into package' }

$scanner = Join-Path $root 'scripts\scan-secrets.mjs'
if (-not (Test-Path $scanner)) { throw 'secret scanner is missing' }
Write-Host '[dist] Scanning package for secrets...'
node $scanner --source $out --mode dir --require-gitleaks
if ($LASTEXITCODE -ne 0) { throw 'secret scan failed' }

$zip = Join-Path $root "dist-package\CanAI-$stamp.zip"
Write-Host "[dist] Zipping to $zip ..."
Compress-Archive -Path $out -DestinationPath $zip -Force

Write-Host "[dist] Done: $zip"
$zipHash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -Path "$zip.sha256" -Value "$zipHash  $(Split-Path $zip -Leaf)" -Encoding Ascii
Write-Host '[dist] Verified: package has no server secret or personal data.'
