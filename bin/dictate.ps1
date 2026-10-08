# Switches Windows' own voice typing, which writes what it hears where the cursor is, in the language of
# the active keyboard, by pressing its Win+H shortcut: a first run starts it, the next one stops it.
#
# With -Language (a tag such as es-MX, one of the keyboards installed in Windows) it also changes the
# keyboard: to that language before it starts listening, and back to the other one after it stops.
#
#   dictate.ps1 [-Language es-MX] [-Probe]     -Probe only prints the keyboards and changes nothing
param([string]$Language = '', [switch]$Probe)

Add-Type -Namespace Win -Name Keys -MemberDefinition @'
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr window, System.IntPtr processId);
[DllImport("user32.dll")] public static extern System.IntPtr GetKeyboardLayout(uint thread);
[DllImport("user32.dll")] public static extern int GetKeyboardLayoutList(int count, System.IntPtr[] list);
[DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr window, uint message, System.IntPtr wParam, System.IntPtr lParam);
'@

$LWIN = 0x5B
$H = 0x48
$KEYUP = 2
$INPUTLANGCHANGEREQUEST = 0x0050

# A keyboard's language is the low word of its handle.
function LanguageOf([IntPtr]$keyboard) { [int]($keyboard.ToInt64() -band 0xFFFF) }

function PressWinH {
  [Win.Keys]::keybd_event($LWIN, 0, 0, [UIntPtr]::Zero)
  [Win.Keys]::keybd_event($H, 0, 0, [UIntPtr]::Zero)
  [Win.Keys]::keybd_event($H, 0, $KEYUP, [UIntPtr]::Zero)
  [Win.Keys]::keybd_event($LWIN, 0, $KEYUP, [UIntPtr]::Zero)
}

# No language asked for: voice typing hears in whatever keyboard is active.
if ($Language -eq '' -and -not $Probe) {
  PressWinH
  exit 0
}

$wanted = 0

if ($Language -ne '') {
  try { $wanted = [System.Globalization.CultureInfo]::GetCultureInfo($Language).LCID } catch { exit 2 }
}

$window = [Win.Keys]::GetForegroundWindow()
$active = [Win.Keys]::GetKeyboardLayout([Win.Keys]::GetWindowThreadProcessId($window, [IntPtr]::Zero))
$keyboards = New-Object IntPtr[] 16
$count = [Win.Keys]::GetKeyboardLayoutList(16, $keyboards)
$keyboards = $keyboards[0..($count - 1)]
$spoken = $keyboards | Where-Object { (LanguageOf $_) -eq $wanted } | Select-Object -First 1
$other = $keyboards | Where-Object { (LanguageOf $_) -ne $wanted } | Select-Object -First 1

if ($Probe) {
  "active {0:X} | spoken {1:X} | other {2:X}" -f $active.ToInt64(), $(if ($spoken) { $spoken.ToInt64() } else { 0 }), $(if ($other) { $other.ToInt64() } else { 0 })
  exit 0
}

# The language is not among the keyboards: voice typing would hear it as another.
if (-not $spoken) { exit 2 }

if ((LanguageOf $active) -eq $wanted) {
  PressWinH

  if ($other) {
    Start-Sleep -Milliseconds 300
    [void][Win.Keys]::PostMessage($window, $INPUTLANGCHANGEREQUEST, [IntPtr]::Zero, $other)
  }
} else {
  [void][Win.Keys]::PostMessage($window, $INPUTLANGCHANGEREQUEST, [IntPtr]::Zero, $spoken)
  Start-Sleep -Milliseconds 400
  PressWinH
}
