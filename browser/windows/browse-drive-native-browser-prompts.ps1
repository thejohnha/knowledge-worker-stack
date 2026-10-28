<#
browse-drive-native-browser-prompts.ps1 — the OS layer of the Windows agent-browser.

Two jobs, one file, because they share the hard part:
  -Mode prompts   read the browser's OWN UI (permission bubbles, the saved-password chooser, infobars,
                  the print preview) through UI Automation, and optionally press something in it.
  -Mode press     send a real OS-level keystroke to the browser window.
  -Mode dump      print the raw UI Automation tree for this browser. Calibration aid: role names differ
                  between Edge builds, and this is how you find out what yours calls things before you
                  edit the role tables below.

The shared hard part is the OWNERSHIP PROOF. Neither UI Automation nor the keyboard knows which browser
owns a window. Unfiltered, a read leaks another window's contents and a press types into whatever the
person at this machine is using. So everything here is scoped to ONE process: the process that owns the
CDP LISTENING SOCKET on -Port. That process IS, by definition, the browser this call is talking to.

Upstream equivalent: the Linux version's AT-SPI probe, browse-drive-native-browser-prompts.py.
The traps below are lifted from it, because they are properties of the BROWSER, not of the toolkit.

CONTRACT — browse.js depends on every line of this:
  stdout  -Mode prompts, no press flag : a BARE JSON ARRAY  [{role,name,buttons[],entries?[]}]
          -Press <name>                : {"pressed":…, "in":…, "role":…}
          -PressEntry <name>           : {"pressedEntry":…, "in":…, "role":…}
          -PressEntryCard <lastfour>   : {"pressedCard":…, "in":…, "role":…}
          -Mode press                  : {"window":…, "windowName":…}  or  {"skipped":"<why>"}
  exit    0 ok · 2 no such button/entry · 3 cannot see the browser's UI tree · 4 usage or environment
  stderr  every failure, prefixed "browse-native-browser-prompts: "

An EMPTY ARRAY means "the browser has no prompt up". EXIT 3 means "I could not look". Those must never be
confusable, which is why exit 3 exists at all.

WINDOWS SESSION ISOLATION — read this before debugging an empty tree. UI Automation and the keyboard can
only reach windows in the SAME Windows session as the process calling them. A command arriving over SSH
normally lands in a non-interactive session, where the browser's windows are invisible: the tree comes back
empty and a press has nothing to type into. That is what exit 3's message is telling you. The fix is not to
retry, it is to run this script inside the interactive session — see README.md.
#>
[CmdletBinding()]
param(
  [ValidateSet('prompts','press','dump')] [string] $Mode = 'prompts',
  [string] $Port = '9222',
  [int]    $BrowserPid = 0,                # skip the socket lookup (testing, and the task hop passes it through)
  [string] $Press,                   # press a BUTTON by exact accessible name
  [string] $PressEntry,              # press a saved-password chooser ROW by exact accessible name
  [string] $PressEntryCard,          # press a saved-CARD row by its last four digits, never by label
  [string] $Key,                     # -Mode press: the key to send
  [switch] $Targeted                 # -Mode press: post to the proven window instead of the foreground one
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

function Die([string]$msg, [int]$code) {
  [Console]::Error.WriteLine("browse-native-browser-prompts: $msg")
  exit $code
}
function Emit($obj) { [Console]::Out.WriteLine((ConvertTo-Json $obj -Compress -Depth 8)) }

# ---- the ownership proof ----------------------------------------------------------------------------
# Who owns the CDP listening socket. Preferred over matching command lines: a command line pattern also
# matches the caller's own argv and returns every renderer as well as the browser, while the listening
# socket has exactly one owner. Upstream uses `ss` for this and measured that the socket owner is the same
# pid the accessibility tree reports for the browser.
function Get-BrowserPid([string]$p) {
  if ($BrowserPid -gt 0) { return $BrowserPid }
  try {
    $c = Get-NetTCPConnection -LocalPort ([int]$p) -State Listen -ErrorAction Stop | Select-Object -First 1
    if ($c) { return [int]$c.OwningProcess }
  } catch {
    # Get-NetTCPConnection is absent on some stripped builds; netstat is always there.
    $line = (netstat -ano -p TCP | Select-String -Pattern ":$p\s" | Select-String -Pattern 'LISTENING' | Select-Object -First 1)
    if ($line) {
      $f = ($line.ToString() -split '\s+') | Where-Object { $_ }
      if ($f.Count -ge 1) { return [int]$f[-1] }
    }
  }
  Die "nothing is listening on CDP port $p - is the browser up?" 4
}

$targetPid = Get-BrowserPid $Port

# ---- OS keystroke (-Mode press) ---------------------------------------------------------------------
if ($Mode -eq 'press') {
  if (-not $Key) { Die "-Mode press needs -Key" 4 }
  Add-Type -Namespace BrowseNative -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
'@
  $hwnd = [BrowseNative.Win]::GetForegroundWindow()
  if ($hwnd -eq [IntPtr]::Zero) { Emit @{ skipped = "no foreground window in this Windows session - the OS layer cannot reach the desktop from here" }; exit 0 }
  $wpid = 0; [void][BrowseNative.Win]::GetWindowThreadProcessId($hwnd, [ref]$wpid)
  $sb = New-Object System.Text.StringBuilder 256
  [void][BrowseNative.Win]::GetWindowTextW($hwnd, $sb, 256)
  $wname = $sb.ToString()
  if ($wname.Length -gt 80) { $wname = $wname.Substring(0,80) }
  # THE REFUSAL. This is the whole safety property: type only into a window this browser owns.
  if ($wpid -ne $targetPid) {
    Emit @{ skipped = "foreground window $hwnd (pid $wpid, `"$wname`") is NOT the browser on port $Port - refusing to send $Key into another application" }
    exit 0
  }
  Add-Type -AssemblyName System.Windows.Forms
  # SendKeys' spelling, not xdotool's. Only the keys browse.js actually asks for are mapped; an unmapped
  # name is refused rather than guessed, because a wrong guess is a keystroke into a live browser.
  $map = @{
    'Return' = '{ENTER}'; 'Enter' = '{ENTER}'; 'Escape' = '{ESC}'; 'Tab' = '{TAB}';
    'Down' = '{DOWN}'; 'Up' = '{UP}'; 'ctrl+shift+y' = '^+y'
  }
  if (-not $map.ContainsKey($Key)) { Die "unmapped key '$Key' - add it to the map in this script rather than guessing a spelling" 4 }
  if (-not $Targeted) { [void][BrowseNative.Win]::SetForegroundWindow($hwnd); Start-Sleep -Milliseconds 60 }
  [System.Windows.Forms.SendKeys]::SendWait($map[$Key])
  Emit @{ window = "$hwnd"; windowName = $wname }
  exit 0
}

# ---- UI Automation ----------------------------------------------------------------------------------
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
} catch {
  Die "UI Automation assemblies unavailable ($($_.Exception.Message)) - this needs the .NET Framework UIAutomation assemblies, present on every desktop Windows build" 4
}
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]

$cond = New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty, $targetPid)
$windows = @($AE::RootElement.FindAll($TS::Children, $cond))
if ($windows.Count -eq 0) {
  # Exit 3, never an empty list: "cannot see" must not be reportable as "nothing there".
  $others = @($AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)) |
            ForEach-Object { try { $_.Current.ProcessId } catch {} } | Sort-Object -Unique
  Die ("no UI Automation tree for the browser on CDP port $Port (pid $targetPid); pids with top-level windows visible from here: " +
       $(if ($others) { ($others -join ',') } else { 'none' }) +
       ". An EMPTY list means this process is in a Windows session with no desktop - almost always an SSH login reaching for the interactive session's windows; run this inside the interactive session instead. A NON-EMPTY list without that pid means the browser has no window (started headless?) or died.") 3
}

# ROLE TABLES. Chromium paints all of this in its own UI, so Edge's tree mirrors the Chrome tree upstream
# walks, with Windows control types in place of AT-SPI role names. -Mode dump prints what YOUR build calls
# things; if a prompt is missed, widen these rather than deepening the walk.
$PROMPT_TYPES = @('Window','Pane','List','Menu','ToolBar')
$PROMPT_NESTED_ONLY = @('Window')   # a nested Window is a modal (print preview); a top-level one is the browser
$MAX_DEPTH = 6                      # upstream's cap, and upstream measured that everything sits well inside it

function TypeName($el) { try { return $el.Current.ControlType.ProgrammaticName -replace '^ControlType\.','' } catch { return '?' } }
function NameOf($el)   { try { return $el.Current.Name } catch { return '' } }
function RectOf($el)   { try { $r = $el.Current.BoundingRectangle; return "$($r.X),$($r.Y),$($r.Width),$($r.Height)" } catch { return '' } }

function Kids($el) {
  # Prompts come and go on their own (the download bubble auto-hides), so a node can die mid-walk and its
  # accessor then throws. Skip the casualty instead of blowing up: a crashed walk reaches browse.js as
  # unparseable output rather than as the honest "it went away".
  try { return @($el.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)) } catch { return @() }
}

if ($Mode -eq 'dump') {
  function DumpTree($el, $d) {
    if ($d -gt 8) { return }
    foreach ($c in (Kids $el)) {
      [Console]::Out.WriteLine(('  ' * $d) + (TypeName $c) + '  "' + (NameOf $c) + '"  [' + (RectOf $c) + ']')
      DumpTree $c ($d + 1)
    }
  }
  foreach ($w in $windows) {
    [Console]::Out.WriteLine('WINDOW "' + (NameOf $w) + '"  pid=' + $targetPid)
    DumpTree $w 0
  }
  exit 0
}

# Every named button anywhere under a prompt.
function Buttons($el, $d = 0, $out = $null) {
  if ($null -eq $out) { $out = New-Object System.Collections.ArrayList }
  if ($d -gt 8) { return $out }
  foreach ($c in (Kids $el)) {
    if ((TypeName $c) -eq 'Button' -and (NameOf $c)) { [void]$out.Add($c) }
    [void](Buttons $c ($d + 1) $out)
  }
  return $out
}

# TRAP (d) — THE FOOTER ROW IS NOT AN ACCOUNT AND MUST NEVER BE COLLECTED. The chooser ends with a
# "Manage passwords…" row that is indistinguishable from an account row by control type, and pressing it
# opens the password manager, which RENDERS EVERY SAVED USERNAME on the live profile. It is told apart
# STRUCTURALLY, never by label (labels are localized): a Separator sits between the accounts and the
# footer, so collection stops at the first separator among a node's children.
# TRAP (c) — EACH ROW IS PUBLISHED TWICE, an outer wrapper and an inner child with the SAME name and the
# SAME rectangle, and ONLY THE OUTER ONE ACTIVATES; an invoke on the inner is silently swallowed. So the
# dedupe keeps the SHALLOWEST node for a given name - depth is the only thing that tells the two apart.
function Entries($el, $d = 0, $out = $null) {
  if ($null -eq $out) { $out = [ordered]@{} }
  if ($d -gt 8) { return $out }
  foreach ($c in (Kids $el)) {
    $t = TypeName $c
    if ($t -eq 'Separator') { break }
    $n = NameOf $c
    if ($t -eq 'ListItem' -and $n) {
      if (-not $out.Contains($n)) { $out[$n] = @{ depth = $d; node = $c } }
      elseif ($d -lt $out[$n].depth) { $out[$n] = @{ depth = $d; node = $c } }
    }
    [void](Entries $c ($d + 1) $out)
  }
  return $out
}

function Prompts($el, $d = 0, $found = $null, $seen = $null) {
  if ($null -eq $found) { $found = New-Object System.Collections.ArrayList }
  if ($null -eq $seen)  { $seen  = New-Object System.Collections.Generic.HashSet[string] }
  if ($d -gt $MAX_DEPTH) { return $found }
  foreach ($c in (Kids $el)) {
    $t = TypeName $c
    $isPrompt = ($PROMPT_TYPES -contains $t) -and -not (($PROMPT_NESTED_ONLY -contains $t) -and $d -lt 1)
    if ($isPrompt -and (NameOf $c)) {
      $key = "$t|$(NameOf $c)|$(RectOf $c)"
      if ($seen.Add($key)) { [void]$found.Add($c) }
      continue                       # a prompt's subtree holds its buttons, not more prompts
    }
    [void](Prompts $c ($d + 1) $found $seen)
  }
  return $found
}

# TRAP (e) — A SAVED-CARD ROW'S LABEL IS NEVER ECHOED AND NEVER MATCHED AGAINST. It carries the card
# description; only the last four are ever emitted or compared.
function CardLastFour([string]$name) {
  if ($name -match '(?:•|\*|·|x|X){2,}\s*(\d{4})\b') { return $Matches[1] }
  if ($name -match '\b(?:ending|ends)\s+(?:in\s+)?(\d{4})\b')   { return $Matches[1] }
  return $null
}
function SafeEntry([string]$name) {
  $f = CardLastFour $name
  if ($f) { return "card " + ([char]0x2022 * 4) + $f }
  return $name
}
function Invoke-Node($el) {
  # Invoke is the button/row equivalent of upstream's do_action. Some rows expose SelectionItem instead.
  try   { $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); return $true }
  catch {
    try { $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select(); return $true }
    catch { return $false }
  }
}

# Snapshot role/name/buttons/entries ONCE, so the JSON, the press match and the error message all read the
# SAME stable strings rather than re-reading nodes that may have vanished in between.
$snap = @()
foreach ($w in $windows) {
  foreach ($p in (Prompts $w)) {
    $bs = @(); foreach ($b in (Buttons $p)) { $bs += @{ node = $b; name = (NameOf $b) } }
    $es = @(); $e = Entries $p; foreach ($k in $e.Keys) { $es += @{ node = $e[$k].node; name = $k } }
    $snap += @{ role = (TypeName $p); name = (NameOf $p); buttons = $bs; entries = $es }
  }
}

$listing = @()
foreach ($s in $snap) {
  $item = [ordered]@{ role = $s.role; name = $s.name; buttons = @($s.buttons | ForEach-Object { $_.name }) }
  # `entries` is emitted only where there are some, so a permission bubble still reports exactly
  # {role,name,buttons} and the shape callers have always seen does not change under them.
  if ($s.entries.Count -gt 0) { $item.entries = @($s.entries | ForEach-Object { SafeEntry $_.name }) }
  $listing += $item
}

if (-not $Press -and -not $PressEntry -and -not $PressEntryCard) {
  [Console]::Out.WriteLine((ConvertTo-Json @($listing) -Compress -Depth 8))
  exit 0
}
$n = 0; foreach ($x in @($Press, $PressEntry, $PressEntryCard)) { if ($x) { $n++ } }
if ($n -gt 1) { Die "-Press, -PressEntry and -PressEntryCard are different targets (a button, a saved-password chooser row, a saved-card row) - pass one" 4 }

# Press the saved-CARD row whose LAST FOUR match. Exactly one must match: zero is a plain "not offered",
# and two is a real ambiguity the caller has to resolve, because picking either would be a guess about
# which card to pay with.
if ($PressEntryCard) {
  if ($PressEntryCard -notmatch '^\d{4}$') { Die "-PressEntryCard takes exactly the LAST FOUR digits of the card, e.g. 4242" 4 }
  $hits = @()
  foreach ($s in $snap) { foreach ($en in $s.entries) { if ((CardLastFour $en.name) -eq $PressEntryCard) { $hits += @{ e = $en; s = $s } } } }
  if ($hits.Count -gt 1) { Die "last four $PressEntryCard matches $($hits.Count) saved-card rows in the browser on CDP port $Port - picking either would be a guess about which card to pay with. Remove the ambiguity in edge://settings/payments" 2 }
  if ($hits.Count -eq 0) {
    $offered = @($listing | ForEach-Object { $_.entries } | ForEach-Object { CardLastFour $_ } | Where-Object { $_ } | Sort-Object -Unique)
    Die ("no saved-card row ending $PressEntryCard in any prompt of the browser on CDP port $Port (cards offered: " + $(if ($offered) { ($offered -join ',') } else { 'none - no card popup is showing' }) + ")") 2
  }
  [void](Invoke-Node $hits[0].e.node)   # true even when the browser SWALLOWS it - the caller verifies by effect
  Emit @{ pressedCard = $PressEntryCard; 'in' = $hits[0].s.name; role = $hits[0].s.role }
  exit 0
}

# Press the OUTER chooser row whose accessible name matches EXACTLY. Exact, because browse.js has already
# read this very listing and picked a name out of it; a fuzzy match here would be a second, weaker guess
# layered on a decision that was made with full information.
if ($PressEntry) {
  foreach ($s in $snap) {
    foreach ($en in $s.entries) {
      if (CardLastFour $en.name) { continue }   # a saved CARD has its own door; its label cannot be retyped
      if ($en.name -ceq $PressEntry) {
        [void](Invoke-Node $en.node)
        Emit @{ pressedEntry = $PressEntry; 'in' = $s.name; role = $s.role }
        exit 0
      }
    }
  }
  $cards = @($listing | ForEach-Object { $_.entries } | ForEach-Object { CardLastFour $_ } | Where-Object { $_ } | Sort-Object -Unique)
  $show = ConvertTo-Json @($listing | ForEach-Object { @{ name = $_.name; entries = $_.entries } }) -Compress -Depth 6
  $tail = ''
  if ($cards) { $tail = " - the popup is offering SAVED CARDS, which are picked by last four instead: -PressEntryCard $($cards[0])" }
  Die "no entry named '$PressEntry' in any prompt of the browser on CDP port $Port (showing: $show)$tail" 2
}

foreach ($s in $snap) {
  foreach ($b in $s.buttons) {
    if ($b.name -ceq $Press) {
      [void](Invoke-Node $b.node)
      Emit @{ pressed = $Press; 'in' = $s.name; role = $s.role }
      exit 0
    }
  }
}
$show = ConvertTo-Json @($listing | ForEach-Object { @{ name = $_.name; buttons = $_.buttons } }) -Compress -Depth 6
Die "no button named '$Press' in any prompt of the browser on CDP port $Port (showing: $show)" 2
