<#
install-agent-browser-windows.ps1 — provisions a Windows machine to be an agent-browser box.

Run it in an ELEVATED PowerShell on the Windows machine. It is idempotent: run it again after a failure,
or after editing it, and it re-does only what is missing.

THIS SCRIPT IS ALSO THE TOOLING MANIFEST. Everything the box needs is pinned right here with the version
and the checksum it is verified against, so there is one list and it is the list that actually runs. The
prose version is the "Prerequisites" section of README.md.

  Node.js 24.20.0 x64, portable zip     -> C:\nodejs         checksum published by nodejs.org
  ws 8.21.3 (npm)                       -> C:\agent-browser  the only runtime dependency browse.js has
  OpenSSH Server 9.5.0.0, MSI           -> C:\Program Files\OpenSSH   so another machine can reach this box
  Microsoft Edge                        -> already on Windows 10 and 11; not installed here
  PowerShell 5.1                        -> already on Windows 10 and 11; nothing to install

WHY A PINNED ZIP AND A PINNED MSI RATHER THAN A PACKAGE MANAGER: winget is absent from some Windows
editions and cannot be relied on. A pinned URL plus a checksum works on every edition, needs no package
manager, and can be staged offline by dropping the files next to this script.

WHY NOT `Add-WindowsCapability -Name OpenSSH.Server`, which is the answer most documents give: it works,
but it pulls from Windows Update, so it takes as long as that service feels like taking and it fails
outright on a machine that cannot reach it. The
MSI is deterministic. If you would rather use the capability, README.md (Install, step 1) has the one line.
#>
[CmdletBinding()]
param(
  [string] $HomeDir   = 'C:\agent-browser',
  [string] $NodeDir   = 'C:\nodejs',
  [string] $CdpPort   = '9222',
  [string] $EdgeProfile = 'C:\agent-browser\edge-profile',
  [string] $TaskName  = 'AgentBrowserEdge',
  [string] $AuthorizedKey,                       # the calling machine's PUBLIC key, one line
  [switch] $SkipOpenSSH
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'      # without this, Invoke-WebRequest crawls on large files

# ---- pins ---------------------------------------------------------------------------------------------
$NODE_VER  = '24.20.0'
$NODE_URL  = "https://nodejs.org/dist/v$NODE_VER/node-v$NODE_VER-win-x64.zip"
$NODE_SHA  = '6cac9ffbca8f6a47091e4b5c772e0606049c3871cb67d900c0cedde630e545ba'   # nodejs.org SHASUMS256.txt
$SSH_VER   = 'v9.5.0.0p1-Beta'
$SSH_URL   = "https://github.com/PowerShell/Win32-OpenSSH/releases/download/$SSH_VER/OpenSSH-Win64-v9.5.0.0.msi"
$SSH_SHA   = '6333f5b38313360a2c960ea7afa3086002f479bad663f20f92a4889063fe925c'   # measured from the release asset
# NOTE ON THE OpenSSH VERSION: do NOT follow that project's `releases/latest`. It resolves to a Preview
# build. This pin is the newest tag that is not a Preview.

function Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    $m" -ForegroundColor Green }

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
        ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this in an ELEVATED PowerShell (right-click -> Run as administrator)."
}

function Get-Pinned([string]$url, [string]$sha, [string]$dest) {
  # A file already sitting beside this script wins, so the whole install can be staged offline.
  $local = Join-Path $PSScriptRoot (Split-Path $url -Leaf)
  if (Test-Path $local) { Copy-Item $local $dest -Force }
  elseif (-not (Test-Path $dest)) { Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing }
  $got = (Get-FileHash $dest -Algorithm SHA256).Hash.ToLower()
  if ($got -ne $sha.ToLower()) {
    Remove-Item $dest -Force
    throw "CHECKSUM MISMATCH for $url`n  expected $sha`n  got      $got`nThe file was deleted. Do not retry blindly - find out why."
  }
}

# The account comes from the logon token, not $env:USERDOMAIN: over an OpenSSH login on a workgroup
# machine that variable reads WORKGROUP, and WORKGROUP\<user> is no account at all.
$me = [Security.Principal.WindowsIdentity]::GetCurrent().Name

# A new folder under C:\ inherits "Authenticated Users: Modify", which would let any local account swap
# node.exe or plant browse.env.ps1 and run code as whoever calls browse next. So inheritance is cut and only
# these entries remain. SIDs, not names, because the names are translated on non-English Windows.
$SYS_ADMINS = @('*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F')   # SYSTEM, Administrators: full
$USERS_RX   = '*S-1-5-32-545:(OI)(CI)RX'                            # Users: read and run
function Lock-Folder([string]$path, [string[]]$grants) {
  $a = @($path, '/inheritance:r')
  foreach ($g in $grants) { $a += '/grant:r'; $a += $g }
  & icacls @a | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls could not lock down $path" }
}

# ---- 1. directories -----------------------------------------------------------------------------------
Step 'Directories'
foreach ($d in @($HomeDir, (Join-Path $HomeDir 'state'), $EdgeProfile)) {
  if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}
# The browser runs as $me without elevation, so it gets write access to its profile and state only; those
# two hold sign-ins and tab URLs, so no other account can read them.
Lock-Folder $HomeDir ($SYS_ADMINS + $USERS_RX)
foreach ($d in @((Join-Path $HomeDir 'state'), $EdgeProfile)) { Lock-Folder $d ($SYS_ADMINS + "${me}:(OI)(CI)M") }
Ok "$HomeDir, $HomeDir\state, $EdgeProfile (locked down)"

# ---- 2. Node ------------------------------------------------------------------------------------------
Step "Node.js $NODE_VER"
if (Test-Path (Join-Path $NodeDir 'node.exe')) {
  Ok "already at $NodeDir ($(& (Join-Path $NodeDir 'node.exe') -v))"
} else {
  $zip = Join-Path $env:TEMP "node-v$NODE_VER-win-x64.zip"
  Get-Pinned $NODE_URL $NODE_SHA $zip
  $stage = Join-Path $env:TEMP "node-stage-$NODE_VER"
  if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath $stage -Force
  Move-Item (Join-Path $stage "node-v$NODE_VER-win-x64") $NodeDir -Force
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
  Ok "installed to $NodeDir ($(& (Join-Path $NodeDir 'node.exe') -v))"
}
# PATH, machine-wide, so an SSH login finds node without sourcing anything.
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
if ($machinePath -notlike "*$NodeDir*") {
  [Environment]::SetEnvironmentVariable('Path', "$machinePath;$NodeDir", 'Machine')
  Ok "added $NodeDir to the machine PATH (new logins only)"
}
$env:Path = "$env:Path;$NodeDir"
Lock-Folder $NodeDir ($SYS_ADMINS + $USERS_RX)

# ---- 3. ws, the one runtime dependency ----------------------------------------------------------------
Step 'ws 8.21.3 (npm)'
if (Test-Path (Join-Path $HomeDir 'node_modules\ws\index.js')) { Ok 'already installed' }
else {
  Push-Location $HomeDir
  try { & (Join-Path $NodeDir 'npm.cmd') install ws@8.21.3 --no-audit --no-fund | Out-Null }
  finally { Pop-Location }
  if (-not (Test-Path (Join-Path $HomeDir 'node_modules\ws\index.js'))) { throw "npm install ws did not produce node_modules\ws" }
  Ok 'installed'
}

# ---- 4. OpenSSH Server --------------------------------------------------------------------------------
if (-not $SkipOpenSSH) {
  Step "OpenSSH Server $SSH_VER"
  if (Get-Service sshd -ErrorAction SilentlyContinue) { Ok 'already installed' }
  else {
    $msi = Join-Path $env:TEMP 'OpenSSH-Win64.msi'
    Get-Pinned $SSH_URL $SSH_SHA $msi
    $p = Start-Process msiexec.exe -ArgumentList @('/i', "`"$msi`"", '/qn', 'ADDLOCAL=Server') -Wait -PassThru
    if ($p.ExitCode -ne 0) { throw "msiexec exited $($p.ExitCode)" }
    Ok 'installed'
  }
  Set-Service sshd -StartupType Automatic
  if ((Get-Service sshd).Status -ne 'Running') { Start-Service sshd }
  Ok "service $((Get-Service sshd).Status), start $((Get-Service sshd).StartType)"

  # Home and work networks, from the local subnet only: never a public Wi-Fi.
  if (-not (Get-NetFirewallRule -Name 'agent-browser-sshd' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name 'agent-browser-sshd' -DisplayName 'OpenSSH Server (agent-browser)' `
      -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
  }
  Set-NetFirewallRule -Name 'agent-browser-sshd' -Profile Private,Domain -RemoteAddress LocalSubnet
  # Add-WindowsCapability (README step 1) opens its own rule on every profile; narrow it the same way.
  Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue |
    Set-NetFirewallRule -Profile Private,Domain -RemoteAddress LocalSubnet
  Ok 'firewall: inbound TCP 22 allowed from the local subnet, private and domain networks only'

  if ($AuthorizedKey) {
    # An ADMINISTRATOR account does NOT read ~/.ssh/authorized_keys on Windows. It reads this file instead,
    # and it must be owned by Administrators with SYSTEM and Administrators the only entries in its ACL -
    # sshd refuses it otherwise and the refusal looks exactly like a wrong key. This trips up everyone once.
    $adminKeys = 'C:\ProgramData\ssh\administrators_authorized_keys'
    $existing = if (Test-Path $adminKeys) { Get-Content $adminKeys } else { @() }
    if ($existing -notcontains $AuthorizedKey) { Add-Content -Path $adminKeys -Value $AuthorizedKey }
    icacls $adminKeys /inheritance:r /grant 'SYSTEM:F' /grant 'BUILTIN\Administrators:F' | Out-Null
    Ok "authorized key installed in $adminKeys"

    # With a key in place, passwords are switched off, so nobody can guess one. sshd keeps the FIRST value
    # it reads for a setting, so the line goes at the top. sshd writes this file on its first start (above).
    $cfg = 'C:\ProgramData\ssh\sshd_config'
    if (-not (Test-Path $cfg)) { throw "$cfg missing - sshd has not finished its first start; re-run this installer" }
    $lines = @(Get-Content $cfg)
    if ($lines.Count -eq 0 -or $lines[0] -ne 'PasswordAuthentication no') {
      Set-Content -Path $cfg -Value (@('PasswordAuthentication no') + $lines) -Encoding ascii
      Restart-Service sshd
    }
    Ok 'sshd: key sign-in only (PasswordAuthentication no)'
  }
}

# ---- 5. the Edge scheduled task -----------------------------------------------------------------------
# WHY A SCHEDULED TASK AND NOT A SERVICE OR A PLAIN Start-Process: Edge must run in the INTERACTIVE desktop
# session. A Windows service runs in session 0, which has no desktop; a browser started there is not the
# browser a website sees, and neither UI Automation nor a keystroke can reach it. A task that runs as the
# logged-on user, triggered at logon, puts Edge exactly where it has to be - and `schtasks /Run` can then
# start it from an SSH login, which is the whole reason this is a task rather than a shortcut.
Step "Edge scheduled task '$TaskName'"
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
if (-not (Test-Path $edge)) { $edge = 'C:\Program Files\Microsoft\Edge\Application\msedge.exe' }
if (-not (Test-Path $edge)) { throw "msedge.exe not found - install Microsoft Edge first" }

# EDGE FLAGS, each one load-bearing:
#   --remote-debugging-port  the CDP endpoint everything here talks to.
#   --user-data-dir          MANDATORY. Edge refuses remote debugging on the DEFAULT profile, silently:
#                            the port simply never opens. A dedicated profile directory is the fix, and it
#                            also keeps the agent's browsing out of the human's own profile.
#   --no-first-run, --no-default-browser-check  a first-run dialog would block the very first CDP call.
#   --force-renderer-accessibility  makes the browser publish the UI Automation tree the prompt probe reads.
$edgeArgs = @(
  "--remote-debugging-port=$CdpPort"
  "--user-data-dir=`"$EdgeProfile`""
  '--no-first-run'
  '--no-default-browser-check'
  '--force-renderer-accessibility'
) -join ' '

$action  = New-ScheduledTaskAction -Execute $edge -Argument $edgeArgs
$trigger = New-ScheduledTaskTrigger -AtLogOn
$set     = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
             -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $set `
  -Principal $principal -Force | Out-Null
Ok "registered, runs as $me at logon"

# ---- 6. done ------------------------------------------------------------------------------------------
Step 'Next'
Write-Host @"
    Copy browse.js, browse.ps1 and browse-drive-native-browser-prompts.ps1 into $HomeDir.
    Start the browser:   schtasks /Run /TN $TaskName
    Prove CDP answers:   (Invoke-WebRequest http://localhost:$CdpPort/json/version -UseBasicParsing).Content
    Then try it:         powershell -NoProfile -ExecutionPolicy Bypass -File $HomeDir\browse.ps1 open-url https://example.com
"@
