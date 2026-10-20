# Переносит доски, файлы и ключ fal.ai из ПРЕЖНЕЙ версии CanAI в эту (пункт 5.4
# списка исправлений). Запускается из НОВОЙ папки ярлыком
# «Migrate data.bat».
#
# ⚠️ Ничего не удаляет. Прежняя папка остаётся как была — её человек удалит сам,
# когда убедится, что доски на месте. То, что уже было в новой папке (пустая
# доска после пробного запуска, введённый ключ), откладывается рядом с отметкой
# времени, а не стирается.
#
# ⚠️ Копирование, а не перенос: прежняя папка — единственная страховка, пока
# человек не проверил новую версию. Поэтому после копирования сверяются число
# файлов и их общий объём — несовпадение останавливает всё словами.
param(
    # Папка прежней версии; без неё — окно выбора папки.
    [string]$From,
    # Без вопроса «перенести?» — для проверок.
    [switch]$Yes
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Say([string]$text) { Write-Host "[CanAI] $text" }

function Stop-Migration([string]$text) {
    Write-Host ''
    Write-Host "[CanAI] $text" -ForegroundColor Red
    Write-Host '[CanAI] Nothing was deleted; the old folder was left untouched.'
    exit 1
}

# Файл управления запущенным экземпляром принадлежит ПРЕЖНЕЙ копии: в новой он
# указывал бы на чужой сервер. Его не переносим и при сверке не считаем.
$skip = 'runtime-control.json'

function Measure-Tree([string]$dir) {
    $files = @(Get-ChildItem -LiteralPath $dir -Recurse -File -Force | Where-Object { $_.Name -ne $skip })
    $bytes = ($files | Measure-Object -Property Length -Sum).Sum
    if ($null -eq $bytes) { $bytes = 0 }
    return @{ Count = $files.Count; Bytes = [int64]$bytes }
}

function Format-Size([int64]$bytes) {
    if ($bytes -ge 1GB) { return ('{0:N1} GB' -f ($bytes / 1GB)) }
    if ($bytes -ge 1MB) { return ('{0:N0} MB' -f ($bytes / 1MB)) }
    return ('{0:N0} KB' -f [math]::Ceiling($bytes / 1KB))
}

# 1. Где прежняя версия.
if (-not $From) {
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = 'Choose the OLD CanAI folder (the one containing “Start CanAI.bat”)'
    $dialog.ShowNewFolderButton = $false
    # ⚠️ Окно выбора открывается ПОВЕРХ всех: без владельца оно нередко встаёт
    # позади консоли, и человек решает, что ничего не происходит.
    $owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }
    try { $picked = $dialog.ShowDialog($owner) } finally { $owner.Dispose() }
    if ($picked -ne [System.Windows.Forms.DialogResult]::OK) {
        Stop-Migration 'No folder was selected; nothing was copied.'
    }
    $From = $dialog.SelectedPath
}
$old = [IO.Path]::GetFullPath($From).TrimEnd('\')
$here = [IO.Path]::GetFullPath($root).TrimEnd('\')
if ($old -eq $here) { Stop-Migration 'The NEW folder was selected. Choose the old folder.' }
if ($here.StartsWith("$old\", [StringComparison]::OrdinalIgnoreCase)) {
    Stop-Migration 'The new version is inside the old one. Extract it into a separate folder beside it.'
}
$oldData = Join-Path $old 'server\data'
$oldEnv = Join-Path $old 'server\.env'
$oldIndex = Join-Path $oldData 'projects.json'
if (-not (Test-Path -LiteralPath $oldIndex -PathType Leaf)) {
    Stop-Migration "The folder $old has no CanAI boards (server\data\projects.json is missing). Choose the old folder containing Start CanAI.bat."
}

# ⚠️ Сначала в переменную, потом @(): в PowerShell 5.1 ConvertFrom-Json отдаёт
# массив в конвейер ОДНИМ объектом, и @(… | ConvertFrom-Json) насчитал бы
# одну доску вместо восьми.
$boards = 0
try {
    $index = Get-Content -LiteralPath $oldIndex -Raw -Encoding UTF8 | ConvertFrom-Json
    $boards = @($index).Count
} catch { $boards = 0 }
$source = Measure-Tree $oldData
Say "Old version: $old"
Say "Boards: $boards files: $($source.Count) size: $(Format-Size $source.Bytes)."
Say "fal.ai key: $(if (Test-Path -LiteralPath $oldEnv) { 'found; it will be copied' } else { 'not found' })."
if (-not $Yes) {
    $answer = Read-Host '[CanAI] Copy everything to the new version? The old folder will stay unchanged (y/n)'
    if ($answer -and $answer.Trim().ToLower() -notin @('д', 'да', 'y', 'yes')) {
        Stop-Migration 'Copy cancelled.'
    }
}

# 2. Обе версии обязаны стоять: копировать из-под работающего сервера нельзя —
# он пишет доску прямо в этот момент, и копия вышла бы с дырой.
foreach ($folder in @($old, $here)) {
    $stopScript = Join-Path $folder 'stop.ps1'
    if (-not (Test-Path -LiteralPath $stopScript -PathType Leaf)) { continue }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $stopScript | Out-Host
    if ($LASTEXITCODE -ne 0) {
        Stop-Migration "CanAI in $folder could not be stopped. Close its window and run the copy again."
    }
}

# 3. То, что уже есть в новой папке, — в сторону, а не в корзину.
$stamp = Get-Date -Format 'yyyy-MM-dd_HH-mm-ss'
$newServer = Join-Path $here 'server'
$newData = Join-Path $newServer 'data'
$newEnv = Join-Path $newServer '.env'
try {
    if (Test-Path -LiteralPath $newData) {
        Rename-Item -LiteralPath $newData -NewName "data-before-migration-$stamp"
        Say "New version data set aside: server\data-before-migration-$stamp"
    }
    if (Test-Path -LiteralPath $newEnv) {
        Rename-Item -LiteralPath $newEnv -NewName ".env-before-migration-$stamp"
        Say "New version key set aside: server\.env-before-migration-$stamp"
    }
} catch {
    Stop-Migration "Could not set aside the new version data: $($_.Exception.Message). Close programs holding these files and run the copy again."
}

# 4. Копирование. robocopy переживает длинные пути и повторяет занятые файлы.
Say 'Copying boards and files…'
& robocopy $oldData $newData /E /COPY:DAT /DCOPY:T /R:2 /W:1 /XF $skip /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Stop-Migration "Copy failed (robocopy code $LASTEXITCODE)." }
if (Test-Path -LiteralPath $oldEnv) { Copy-Item -LiteralPath $oldEnv -Destination $newEnv }

# 5. Сверка: столько же файлов и столько же байт.
$copied = Measure-Tree $newData
if ($copied.Count -ne $source.Count -or $copied.Bytes -ne $source.Bytes) {
    Stop-Migration ("Not everything was copied: files {0} of {1}, {2} of {3}. Check free disk space and run the copy again." -f `
        $copied.Count, $source.Count, (Format-Size $copied.Bytes), (Format-Size $source.Bytes))
}
if ((Test-Path -LiteralPath $oldEnv) -and -not (Test-Path -LiteralPath $newEnv)) {
    Stop-Migration 'The fal.ai key could not be copied.'
}

Write-Host ''
Say "Done: copied boards $boards, files $($copied.Count) ($(Format-Size $copied.Bytes))."
Say 'Start CanAI.bat in THIS folder and check your boards.'
Say 'Delete the old folder only after you verify everything is in place.'
exit 0
