<#
browse.ps1 — production entry point for the Windows agent-browser. ALWAYS invoke through this, never
`node browse.js` directly.

It does three things browse.js deliberately does not do for itself:
  1. SERIALIZES concurrent callers, so many agent sessions can drive one browser at once. This is the
     feature, not an implementation detail: each session addresses its OWN tab (keyed on BROWSE_SESSION),
     and per-INVOCATION locking is enough because no session ever touches another session's tab. A
     multi-step sequence therefore cannot be clobbered by another session interleaving between its steps.
  2. CAPS every call at 240 seconds. A stuck call would otherwise hold the lock and block every other
     session until somebody noticed. On the cap the process is killed, the lock releases, and the caller
     gets the one line that names the next move.
  3. Loads browse.env.ps1 if the box has one, so per-box settings live outside git and outside this file.

Upstream equivalent: the Linux version's flock + timeout wrapper.
Setup recipe: README.md.
#>
[CmdletBinding()]
param([Parameter(ValueFromRemainingArguments = $true)] [string[]] $Rest)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

$HomeDir = if ($env:BROWSE_HOME) { $env:BROWSE_HOME } else { 'C:\agent-browser' }

# PER-BOX KNOBS, if this box has any. Loaded INSIDE the entry point so every caller gets them, including a
# bare `ssh <box> powershell -File C:\agent-browser\browse.ps1 ...` that sets no environment at all.
# Fail-soft: absent is normal and changes nothing.
# A value already set by the CALLER WINS here. Set defaults in browse.env.ps1 with
# `if (-not $env:X) { $env:X = '…' }` and the caller keeps the last word, which is what makes a one-off override on the command line actually work.
$EnvFile = Join-Path $HomeDir 'browse.env.ps1'
if (Test-Path $EnvFile) { . $EnvFile }

if (-not $env:BROWSE_SESSION) { $env:BROWSE_SESSION = '' }

$node = if ($env:BROWSE_NODE) { $env:BROWSE_NODE } else { 'C:\nodejs\node.exe' }
if (-not (Test-Path $node)) {
  [Console]::Error.WriteLine("ERR browse: node not found at $node - set BROWSE_NODE or fix the install (README.md)")
  exit 4
}
$script = Join-Path $HomeDir 'browse.js'
if (-not (Test-Path $script)) {
  [Console]::Error.WriteLine("ERR browse: browse.js not found at $script")
  exit 4
}

# QUOTE EVERY ARGUMENT FOR node's command line. Start-Process joins -ArgumentList with plain spaces and no
# quoting, so a selector with a space, an enter-text value or run-js code would arrive split into several
# arguments. This applies the Windows argv rules (CommandLineToArgvW, which node's parser follows): wrap in
# quotes, write an embedded quote as \", and double backslashes only where they precede a quote or the
# closing quote. Everything else is passed through byte for byte.
function ConvertTo-NodeArg([string]$a) {
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append('"')
  $bs = 0
  foreach ($c in $a.ToCharArray()) {
    if ($c -eq '\') { $bs++; continue }
    if ($c -eq '"') { [void]$sb.Append('\' * (2 * $bs + 1)).Append('"'); $bs = 0; continue }
    if ($bs) { [void]$sb.Append('\' * $bs); $bs = 0 }
    [void]$sb.Append($c)
  }
  [void]$sb.Append('\' * (2 * $bs)).Append('"')
  return $sb.ToString()
}
$argv = @($script)
if ($Rest) { $argv += $Rest }
$argLine = ($argv | ForEach-Object { ConvertTo-NodeArg $_ }) -join ' '

# ONE call at a time, machine-wide. A named mutex in the Global\ namespace is the Windows equivalent of
# upstream's flock on a lockfile, and it is strictly better in one way that matters here: the OS releases it
# when the owning process dies, so a killed call cannot strand the lock the way a leaked file descriptor can.
$mutex = New-Object System.Threading.Mutex($false, 'Global\agent-browser-browse')
$held  = $false
try {
  # Wait up to the same 240s the call itself is capped at. Longer would let a queue build up silently;
  # shorter would fail calls that were only ever going to be slow.
  try { $held = $mutex.WaitOne(240000) }
  catch [System.Threading.AbandonedMutexException] { $held = $true }   # previous holder was killed; the lock is ours
  if (-not $held) {
    [Console]::Error.WriteLine('ERR browse: waited 240s for another browse call to finish and gave up')
    exit 75
  }

  $p = Start-Process -FilePath $node -ArgumentList $argLine -NoNewWindow -PassThru   # ONE pre-quoted string, passed verbatim
  # TOUCH .Handle BEFORE WAITING, or .ExitCode reads back 0 no matter what node did. Start-Process -PassThru
  # hands back a Process object that has not cached the OS handle; once the process exits, the exit status is
  # unreadable and the property quietly answers 0. That turns EVERY failing verb into a success at the caller,
  # which is the worst possible direction for this bug to fail in - a caller cannot check what it is not told.
  $null = $p.Handle
  if (-not $p.WaitForExit(240000)) {
    try { $p.Kill() } catch {}
    # TEACH ON TIMEOUT. On the cap node is killed before it can print anything, so without these two lines
    # the caller sees a bare exit code and no stderr at all. A frozen renderer (a native dialog) and the
    # heavy-tab wedge are indistinguishable at this level; dismiss-dialog's probe is what tells them apart.
    [Console]::Error.WriteLine('ERR browse: hard-capped at 240s - the call was killed and the lock released')
    [Console]::Error.WriteLine('call timed out - if a tab is frozen by an orphaned native dialog, run: browse dismiss-dialog --probe-only')
    exit 124
  }
  exit $p.ExitCode
}
finally {
  if ($held) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
