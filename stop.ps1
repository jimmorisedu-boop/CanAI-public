# Безопасно завершает только тот экземпляр CanAI, который подтверждён локальным control-файлом.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$dataRoot = if ($env:CANAI_DATA_DIR) {
    [IO.Path]::GetFullPath($env:CANAI_DATA_DIR)
} else {
    Join-Path $root 'server\data'
}
$controlPath = Join-Path $dataRoot 'runtime-control.json'
$control = $null
try {
    if (Test-Path -LiteralPath $controlPath -PathType Leaf) {
        $controlItem = Get-Item -LiteralPath $controlPath
        if ($controlItem.Length -le 16384) {
            $candidate = Get-Content -LiteralPath $controlPath -Raw | ConvertFrom-Json
            $candidatePort = [int]$candidate.port
            if ($candidate.version -eq 1 -and $candidatePort -ge 1 -and $candidatePort -le 65535) {
                $control = $candidate
            }
        }
    }
} catch {
    $control = $null
}
$port = if ($null -ne $control) { [int]$control.port } elseif ($env:PORT) { [int]$env:PORT } else { 8787 }
$url = "http://127.0.0.1:$port"

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

function Get-CanAiStatus([string]$u) {
    try {
        $response = Invoke-WebRequest "$u/api/status" -UseBasicParsing -TimeoutSec 3
        $status = $response.Content | ConvertFrom-Json
        if (
            $null -eq $status.falConfigured -or
            $null -eq $status.mockMode -or
            [string]::IsNullOrWhiteSpace([string]$status.instanceId)
        ) {
            return $null
        }
        return $status
    } catch {
        return $null
    }
}

# Без control-файла лаунчер не знает фактический порт (start.ps1 мог уйти с
# 8787 на свободную пару). Чистая подсказка без остановки: чужой CanAI или
# чужая программа в диапазоне — не повод считать ЭТУ копию работающей.
# Список слушающих берём из netstat — пробивать 100 портов коннектами долго.
function Find-ListeningCandidatePorts {
    $found = @()
    try {
        foreach ($line in @(netstat -ano -p tcp)) {
            if ($line -notmatch 'LISTENING') { continue }
            $parts = @($line -split '\s+' | Where-Object { $_ })
            if ($parts.Count -lt 2) { continue }
            $local = $parts[1]
            $colon = $local.LastIndexOf(':')
            if ($colon -lt 0) { continue }
            $p = 0
            if (-not [int]::TryParse($local.Substring($colon + 1), [ref]$p)) { continue }
            if ($p -ge 8787 -and $p -le 8886 -and $p -ne $port) { $found += $p }
        }
    } catch {}
    return @($found | Select-Object -Unique)
}

if (-not (Test-PortListening $port)) {
    if ($null -eq $control) {
        $others = Find-ListeningCandidatePorts
        if ($others.Count -gt 0) {
            Write-Host "[CanAI] Hint: something is listening in the CanAI port range: $($others -join ', ')."
            Write-Host '[CanAI] If this is your running CanAI and runtime-control.json was lost, restore'
            Write-Host '[CanAI] server\data\runtime-control.json and run the stop command again.'
        }
    }
    Write-Host '[CanAI] CanAI is already stopped.'
    exit 0
}

$status = Get-CanAiStatus $url
if ($null -eq $status) {
    Write-Host "[CanAI] Port $port is used by another program."
    Write-Host '[CanAI] Nothing was stopped.'
    exit 1
}

try {
    if ($null -eq $control) { throw 'control file is missing or damaged' }
    $token = [string]$control.shutdownToken
    if (
        $control.version -ne 1 -or
        $control.port -ne $port -or
        [string]$control.instanceId -ne [string]$status.instanceId -or
        [string]::IsNullOrWhiteSpace($token) -or
        $token.Length -gt 256
    ) {
        throw 'control file does not match the running server'
    }
} catch {
    Write-Host '[CanAI] Could not verify that the running server belongs to this CanAI copy.'
    Write-Host '[CanAI] Nothing was stopped.'
    exit 1
}

try {
    Invoke-WebRequest "$url/api/lifecycle/shutdown" `
        -Method Post `
        -Headers @{ 'x-canai-shutdown-token' = $token } `
        -UseBasicParsing `
        -TimeoutSec 5 | Out-Null
} catch {
    Write-Host '[CanAI] The server did not accept the safe shutdown request.'
    Write-Host '[CanAI] Nothing was stopped.'
    exit 1
}

$deadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $deadline) {
    if (-not (Test-PortListening $port)) {
        Write-Host '[CanAI] CanAI stopped.'
        exit 0
    }
    Start-Sleep -Milliseconds 250
}

Write-Host '[CanAI] The server did not release its port within 15 seconds.'
Write-Host '[CanAI] No processes were killed forcefully.'
exit 1
