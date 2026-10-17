param([switch]$PlanOnly)
$ErrorActionPreference = 'Stop'
# Explicit user action only. Never terminates Desktop or takes a writer.
$endpoint = 'ws://127.0.0.1:4509'
$stateDirectory = Join-Path $env:LOCALAPPDATA 'ChatGPT Goal Controller\shared-codex'
$manifestPath = Join-Path $stateDirectory 'server.json'
$mutex = New-Object Threading.Mutex($false, 'Local\GoalControllerSharedCodex4509')
$acquired = $false
try {
    $acquired = $mutex.WaitOne(0)
    if (-not $acquired) { throw 'Ortak Codex baslatma islemi zaten suruyor.' }
    $desktop = Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
    if (-not $desktop) { throw 'Codex Desktop kurulumu bulunamadi.' }
    $desktopExecutable = Join-Path $desktop.InstallLocation 'app\ChatGPT.exe'
    if (-not (Test-Path -LiteralPath $desktopExecutable -PathType Leaf)) {
        $desktopExecutable = Join-Path $desktop.InstallLocation 'app\Codex.exe'
    }
    if (-not (Test-Path -LiteralPath $desktopExecutable -PathType Leaf)) { throw 'Codex Desktop executable bulunamadi.' }
    $desktopProcesses = @(Get-Process -Name ChatGPT,Codex -ErrorAction SilentlyContinue | Where-Object {
        try { -not $_.Path -or $_.Path -eq $desktopExecutable } catch { $true }
    })
    if ($desktopProcesses.Count -gt 0 -and -not $PlanOnly) {
        throw 'Once Codex Desktop uygulamasindan tamamen cikin. Bu islem acik Codex uygulamasini kapatmaz. Sonra bu dugmeye yeniden basin.'
    }
    $codexRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
    $engine = Get-ChildItem -LiteralPath $codexRoot -Filter codex.exe -File -Recurse |
        Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if (-not $engine) { throw 'Bu kullanici icin Codex engine bulunamadi.' }
    if ($PlanOnly) {
        @{ desktop = $desktopExecutable; engine = $engine.FullName; endpoint = $endpoint;
            desktopRunning = $desktopProcesses.Count -gt 0; changesMade = $false } | ConvertTo-Json
        return
    }
    New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
    $ownedServer = $null
    if (Test-Path -LiteralPath $manifestPath) {
        $saved = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        if ($saved.endpoint -eq $endpoint -and $saved.pid -is [int]) {
            $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $($saved.pid)" -ErrorAction SilentlyContinue
            if ($candidate -and $candidate.ExecutablePath -eq $saved.executable -and
                $candidate.CommandLine.Contains('--listen') -and $candidate.CommandLine.Contains($endpoint) -and
                $candidate.CreationDate.ToUniversalTime().ToString('o') -eq $saved.createdAt) {
                $ownedServer = $candidate
            }
        }
    }
    if (-not $ownedServer) {
        $occupied = @(Get-NetTCPConnection -LocalPort 4509 -State Listen -ErrorAction SilentlyContinue)
        if ($occupied.Count -gt 0) { throw '4509 portunu baska bir islem kullaniyor; devralinmadi.' }
        $server = Start-Process -FilePath $engine.FullName -ArgumentList @('app-server','--listen',$endpoint,'--analytics-default-enabled') `
            -WorkingDirectory $env:USERPROFILE -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $stateDirectory 'server.stdout.log') `
            -RedirectStandardError (Join-Path $stateDirectory 'server.stderr.log')
        $ownedServer = Get-CimInstance Win32_Process -Filter "ProcessId = $($server.Id)"
        if (-not $ownedServer) { throw 'Ortak Codex sunucusu baslatilamadi; shared-codex loglarini inceleyin.' }
        @{ pid = $server.Id; executable = $engine.FullName; endpoint = $endpoint;
            createdAt = $ownedServer.CreationDate.ToUniversalTime().ToString('o') } |
            ConvertTo-Json | Set-Content -LiteralPath $manifestPath -Encoding UTF8
    }
    $ready = $false
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while ([DateTime]::UtcNow -lt $deadline) {
        try {
            $health = Invoke-WebRequest -Uri 'http://127.0.0.1:4509/readyz' -UseBasicParsing -TimeoutSec 1
            if ($health.StatusCode -eq 200) { $ready = $true; break }
        } catch { }
        if (-not (Get-Process -Id $ownedServer.ProcessId -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 200
    }
    if (-not $ready) { throw 'Ortak sunucu hazir olmadi. Otomatik yeniden baslatma veya Desktop acma yapilmadi.' }
    $listeners = @(Get-NetTCPConnection -LocalPort 4509 -State Listen -ErrorAction Stop)
    if ($listeners.Count -eq 0 -or @($listeners | Where-Object { $_.OwningProcess -ne $ownedServer.ProcessId -or $_.LocalAddress -ne '127.0.0.1' }).Count -gt 0) {
        throw 'Ortak sunucunun port sahipligi dogrulanamadi; Desktop acilmadi.'
    }
    # Desktop must not inherit execFile's stdout/stderr pipes: it outlives this
    # launcher, otherwise Node waits for those pipes until its launch timeout.
    # Scope environment changes to this short-lived launcher and restore them.
    $previousEndpoint = $env:CODEX_APP_SERVER_WS_URL
    $previousForceCli = $env:CODEX_APP_SERVER_FORCE_CLI
    try {
        $env:CODEX_APP_SERVER_WS_URL = $endpoint
        Remove-Item Env:CODEX_APP_SERVER_FORCE_CLI -ErrorAction SilentlyContinue
        $desktopProcess = Start-Process -FilePath $desktopExecutable -WorkingDirectory $env:USERPROFILE -PassThru `
            -RedirectStandardOutput (Join-Path $stateDirectory 'desktop.stdout.log') `
            -RedirectStandardError (Join-Path $stateDirectory 'desktop.stderr.log')
        if (-not $desktopProcess) { throw 'Codex Desktop baslatma sonucu alinamadi; yeniden denemeden once acik uygulamayi kontrol edin.' }
    } finally {
        $env:CODEX_APP_SERVER_WS_URL = $previousEndpoint
        $env:CODEX_APP_SERVER_FORCE_CLI = $previousForceCli
    }
    Write-Output 'Codex ortak yerel baglanti ile acildi. Goal Controller icinde Simdi Kontrol Et dugmesine basin.'
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally {
    if ($acquired) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
