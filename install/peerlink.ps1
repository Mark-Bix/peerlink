# PeerLink setup for Windows (Windows PowerShell 5.1 or later).
#
# Installs what is missing (git, Node.js, Claude Code), adds and updates the
# PeerLink plugin, asks only for what it cannot know (team key, machine name),
# checks the connection, creates the "peerlink" command and a desktop shortcut,
# then starts a Claude session listening for the other machines.
#
#   PeerLink-Setup.cmd                       (double click: downloads and runs this script)
#   powershell -ExecutionPolicy Bypass -File peerlink.ps1 [-Name pc-ufficio] [-WorkDir C:\Dev] [-Reconfigure] [-NoLaunch]
#
# The team key can also come from the PEERLINK_TEAM_KEY environment variable;
# with it and -Name the setup asks nothing.

param(
    [string]$HubUrl = 'https://github.com/Mark-Bix/BixClaude-Mailbox.git',
    [string]$Marketplace = 'Mark-Bix/peerlink',
    [string]$Name = '',
    [string]$WorkDir = '',
    [switch]$Reconfigure,
    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$Plugin = 'peerlink@peerlink'
$LocalBin = Join-Path $env:USERPROFILE '.local\bin'
$ClaudeDir = $env:CLAUDE_CONFIG_DIR
if (-not $ClaudeDir) { $ClaudeDir = Join-Path $env:USERPROFILE '.claude' }

function Write-Step([string]$Text) { Write-Host ''; Write-Host "== $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "   $Text" -ForegroundColor Green }
function Write-Note([string]$Text) { Write-Host "   $Text" -ForegroundColor Yellow }

function Update-SessionPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user"
}

function Test-Command([string]$Name) { return [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

function Add-UserPath([string]$Dir) {
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not $user) { $user = '' }
    if (($user -split ';') -notcontains $Dir) {
        [Environment]::SetEnvironmentVariable('Path', ($user.TrimEnd(';') + ";$Dir").TrimStart(';'), 'User')
    }
    Update-SessionPath
}

function Install-WithWinget([string]$Id, [string]$Label) {
    if (-not (Test-Command 'winget')) {
        throw "$Label non è installato e winget non è disponibile: installalo a mano e rilancia il setup."
    }
    Write-Note "Installo $Label..."
    & winget install -e --id $Id --silent --accept-source-agreements --accept-package-agreements | Out-Null
    Update-SessionPath
}

function Invoke-Claude {
    # Runs claude with the given arguments; returns its output, throws on failure.
    $output = & claude @args 2>&1
    if ($LASTEXITCODE -ne 0) { throw ("claude " + ($args -join ' ') + " non è riuscito:`n" + ($output | Out-String)) }
    return $output
}

# ---- 1. prerequisites -------------------------------------------------------

Write-Step 'Controllo dei prerequisiti'
Update-SessionPath
if (-not (Test-Command 'git')) { Install-WithWinget 'Git.Git' 'Git' }
Write-Ok ("git: " + (& git --version))

$nodeOk = $false
if (Test-Command 'node') {
    $major = [int]((& node -v).TrimStart('v').Split('.')[0])
    $nodeOk = $major -ge 20
}
if (-not $nodeOk) { Install-WithWinget 'OpenJS.NodeJS.LTS' 'Node.js' }
Write-Ok ("node: " + (& node -v))

if (-not (Test-Command 'claude')) {
    Write-Note 'Installo Claude Code...'
    & ([scriptblock]::Create((Invoke-RestMethod 'https://claude.ai/install.ps1')))
    Add-UserPath $LocalBin
}
if (-not (Test-Command 'claude')) { Add-UserPath $LocalBin }
if (-not (Test-Command 'claude')) { throw 'Claude Code non risulta installato: apri un nuovo terminale e rilancia il setup.' }
Write-Ok ("claude: " + ((& claude --version) | Select-Object -First 1))

# ---- 2. plugin --------------------------------------------------------------

Write-Step 'Plugin PeerLink'
$marketplaces = (Invoke-Claude plugin marketplace list --json | Out-String) | ConvertFrom-Json
$known = @($marketplaces | Where-Object { $_.name -eq 'peerlink' }).Count -gt 0
if ($known) {
    Invoke-Claude plugin marketplace update peerlink | Out-Null
} else {
    Invoke-Claude plugin marketplace add $Marketplace | Out-Null
}

$installedFile = Join-Path $ClaudeDir 'plugins\installed_plugins.json'
$installed = $false
if (Test-Path $installedFile) {
    $installed = [bool]((Get-Content $installedFile -Raw | ConvertFrom-Json).plugins.$Plugin)
}
if ($installed) {
    Invoke-Claude plugin update $Plugin | Out-Null
    Write-Ok 'aggiornato'
} else {
    Invoke-Claude plugin install $Plugin | Out-Null
    Write-Ok 'installato'
}

# ---- 3. options -------------------------------------------------------------

Write-Step 'Configurazione'
$current = (Invoke-Claude plugin configure $Plugin --json | Out-String) | ConvertFrom-Json
function Test-OptionSet([string]$Key) { return @($current.configured) -contains $Key }

$values = @{}
# Forward slashes: "configure --values-stdin" refuses values containing a backslash.
if ($Reconfigure -or -not (Test-OptionSet 'hub_url')) { $values['hub_url'] = $HubUrl -replace '\\', '/' }

if ($Reconfigure -or -not (Test-OptionSet 'team_key')) {
    $key = $env:PEERLINK_TEAM_KEY
    if (-not $key) {
        $secure = Read-Host '   Chiave della squadra (il token GitHub; non viene mostrata)' -AsSecureString
        $key = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
    }
    if ($key) { $values['team_key'] = $key.Trim() }
}

if ($Reconfigure -or -not (Test-OptionSet 'peer_name')) {
    $machineName = $Name
    if (-not $machineName) {
        $default = $env:COMPUTERNAME.ToLower()
        $machineName = Read-Host "   Nome di questa macchina [$default]"
        if (-not $machineName) { $machineName = $default }
    }
    $values['peer_name'] = $machineName.Trim().ToLower()
}

if ($values.Count -gt 0) {
    # Fed to stdin from a file that exists only for this call, so the key never
    # appears on a command line. A pipe from PowerShell is not reliable here:
    # claude may read stdin before the data arrives and see it empty.
    $json = $values | ConvertTo-Json -Compress
    $file = Join-Path $env:TEMP ('peerlink-' + [guid]::NewGuid().ToString('N') + '.json')
    try {
        [System.IO.File]::WriteAllText($file, $json, (New-Object System.Text.UTF8Encoding($false)))
        $claudeExe = (Get-Command claude).Source
        $output = cmd /c "`"$claudeExe`" plugin configure $Plugin --values-stdin < `"$file`" 2>&1"
        if ($LASTEXITCODE -ne 0) { throw ("Configurazione non salvata:`n" + ($output | Out-String)) }
    } finally {
        Remove-Item $file -Force -ErrorAction SilentlyContinue
    }
    Write-Ok ('salvato: ' + (($values.Keys | Sort-Object) -join ', '))
} else {
    Write-Ok 'già configurato (rilancia con -Reconfigure per cambiare)'
}

# ---- 4. command and shortcut ------------------------------------------------

Write-Step 'Comando "peerlink" e collegamento sul desktop'
if (-not (Test-Path $LocalBin)) { New-Item -ItemType Directory -Force $LocalBin | Out-Null }
Add-UserPath $LocalBin
$launcher = Join-Path $LocalBin 'peerlink.cmd'
$launcherText = @(
    '@echo off',
    'rem PeerLink: a Claude session that listens for the other machines.',
    'claude --dangerously-load-development-channels plugin:peerlink@peerlink --permission-mode auto %*'
) -join "`r`n"
Set-Content -Path $launcher -Value $launcherText -Encoding Ascii
Write-Ok "comando: peerlink (in qualunque cartella: $launcher)"

if (-not $WorkDir) { $WorkDir = $env:USERPROFILE }
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'PeerLink.lnk'))
$link.TargetPath = "$env:SystemRoot\System32\cmd.exe"
$link.Arguments = "/k `"$launcher`""
$link.WorkingDirectory = $WorkDir
$link.Description = 'Claude in ascolto su PeerLink'
$link.Save()
Write-Ok "collegamento sul desktop: PeerLink (parte da $WorkDir)"

# ---- 5. check ---------------------------------------------------------------

Write-Step 'Verifica del collegamento'
$check = & claude -p 'Call the peerlink peer_list tool once and print its output verbatim, nothing else.' --allowedTools 'mcp__plugin_peerlink_peer__peer_list' --model haiku 2>&1 | Out-String
if ($LASTEXITCODE -eq 0 -and $check -match 'You are "') {
    Write-Host $check.Trim()
} else {
    Write-Note 'Verifica non riuscita. Se Claude Code non ha ancora fatto il login, avvia "claude" una volta, accedi, poi rilancia il setup.'
    Write-Note $check.Trim()
}

# ---- 6. start ---------------------------------------------------------------

Write-Host ''
Write-Host 'Fatto. Per avviare PeerLink in futuro: icona PeerLink sul desktop, oppure "peerlink" nella cartella del progetto.' -ForegroundColor Green
Write-Host 'Alla prima apertura Claude chiede di confermare i "development channels": conferma.'
if (-not $NoLaunch) {
    Write-Host ''
    Set-Location $WorkDir
    & $launcher
}
