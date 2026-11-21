# Omarchy Server Windows Connector installer (PowerShell 5.1+ / PowerShell 7+)
# Runs as the current user via a Windows Scheduled Task (no admin required unless installing Python).
param(
    [string]$Server = "",
    [string]$Ca = "",
    [string]$Token = "",
    [string]$Allow = "",
    [string]$Source = "https://raw.githubusercontent.com/TouchWorkStation/omarchy-server",
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$TaskName = "OmarchyConnector"
$InstallDir = Join-Path $env:LOCALAPPDATA "omarchy-connector"
$AgentPath = Join-Path $InstallDir "agent.py"
$CaPath = Join-Path $InstallDir "server-ca.crt"

if ($Uninstall) {
    Write-Host "Removing Omarchy Server connector..."
    try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
    try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}
    if (Test-Path $InstallDir) {
        Remove-Item -Recurse -Force $InstallDir -ErrorAction SilentlyContinue
    }
    Write-Host "Omarchy Server connector removed."
    exit 0
}

if (-not $Server -or -not $Ca -or -not $Token) {
    Write-Error "Usage: install.ps1 -Server https://<host>:7780 -Ca <sha256> -Token <code...> [-Allow terminal,desktop,manage,files]"
    exit 1
}

$Server = $Server.TrimEnd("/")
$Source = $Source.TrimEnd("/")
$ExpectedCa = ($Ca -replace "[^0-9a-fA-F]", "").ToLowerInvariant()
if ($ExpectedCa.Length -ne 64) {
    Write-Error "Invalid -Ca SHA-256 fingerprint"
    exit 1
}

# Locate Python 3.8+
$Python = $null
foreach ($cand in @("python", "python3", "py")) {
    $cmd = Get-Command $cand -ErrorAction SilentlyContinue
    if ($cmd) {
        $ver = & $cmd.Source -c "import sys; print(sys.version_info >= (3, 8))" 2>$null
        if ($ver -eq "True") {
            $Python = $cmd.Source
            break
        }
    }
}
if (-not $Python) {
    Write-Error "Python 3.8+ is required. Install it from https://www.python.org or with: winget install Python.Python.3.12"
    exit 1
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# Download and pin the server CA certificate (verify DER SHA-256 fingerprint against -Ca).
$CaUrl = "$Server/api/tls/ca.crt"
Write-Host "Fetching server certificate from $CaUrl ..."
if ($PSVersionTable.PSVersion.Major -ge 6) {
    $CaBytes = (Invoke-WebRequest -Uri $CaUrl -SkipCertificateCheck -UseBasicParsing).Content
    if ($CaBytes -is [string]) { $CaBytes = [System.Text.Encoding]::UTF8.GetBytes($CaBytes) }
} else {
    $origCallback = [System.Net.ServicePointManager]::ServerCertificateValidationCallback
    try {
        [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
        $wc = New-Object System.Net.WebClient
        $CaBytes = $wc.DownloadData($CaUrl)
    } finally {
        [System.Net.ServicePointManager]::ServerCertificateValidationCallback = $origCallback
    }
}

$CaPem = [System.Text.Encoding]::UTF8.GetString($CaBytes)
$PemMatch = [regex]::Match($CaPem, "-----BEGIN CERTIFICATE-----(.*?)-----END CERTIFICATE-----", [System.Text.RegularExpressions.RegexOptions]::Singleline)
if (-not $PemMatch.Success) {
    Write-Error "Downloaded server CA is not a valid PEM certificate"
    exit 1
}
$DerBytes = [System.Convert]::FromBase64String(($PemMatch.Groups[1].Value -replace "\s+", ""))
$sha = [System.Security.Cryptography.SHA256]::Create()
$ActualCa = ([System.BitConverter]::ToString($sha.ComputeHash($DerBytes)) -replace "-", "").ToLowerInvariant()
if ($ActualCa -ne $ExpectedCa) {
    Write-Error "Server certificate fingerprint mismatch! Expected $ExpectedCa, got $ActualCa"
    exit 1
}
[System.IO.File]::WriteAllBytes($CaPath, $CaBytes)

# Download agent.py and verify it is valid Python before running
$AgentUrl = "$Source/main/connector/agent.py"
Write-Host "Downloading connector from $AgentUrl ..."
Invoke-WebRequest -Uri $AgentUrl -OutFile $AgentPath -UseBasicParsing
& $Python -c "import ast, sys; ast.parse(open(sys.argv[1], 'rb').read())" $AgentPath
if ($LASTEXITCODE -ne 0) {
    Remove-Item -Force $AgentPath -ErrorAction SilentlyContinue
    Write-Error "Downloaded connector script failed syntax verification"
    exit 1
}

# Enroll with the Omarchy Server using positional arguments: enroll SERVER TOKEN [ABILITIES]
Write-Host "Enrolling with $Server ..."
$EnrollArgs = @($AgentPath, "enroll", $Server, $Token)
if ($Allow) { $EnrollArgs += $Allow }
& $Python @EnrollArgs
if ($LASTEXITCODE -ne 0) {
    Write-Error "Enrollment failed (exit $LASTEXITCODE)"
    exit $LASTEXITCODE
}

# Register user Scheduled Task to run on logon (no extra args; pythonw/pyw avoids console window)
try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}

$PythonW = $Python -replace "(?i)python(\d+(?:\.\d+)?)?\.exe$", "pythonw.exe"
if ($PythonW -eq $Python) { $PythonW = $Python -replace "(?i)py\.exe$", "pyw.exe" }
$Exe = if (Test-Path $PythonW) { $PythonW } else { $Python }
$Action = New-ScheduledTaskAction -Execute $Exe -Argument "`"$AgentPath`"" -WorkingDirectory $InstallDir
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 0)
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description "Omarchy Server local swarm connector" | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host "Connected! Omarchy Server connector is running as Scheduled Task '$TaskName'."
