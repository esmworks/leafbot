# The helper that moves the mouse, types and takes the screen's picture for a bot the person allowed
# to use this Windows computer. Leaf Bot starts it with Windows PowerShell, which every Windows 10 and
# 11 has, so it needs no build of its own. It reads one JSON request per line and writes one JSON
# answer per line, as the macOS helper does. Key codes arrive as Windows virtual-key codes: the app
# turns the bot's key names into them before they reach this.
#
# Coordinates are the main screen's pixels: the process says it is aware of the display's scaling,
# so the screen's size, the picture and the pointer all count the same pixels.

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8

# C# 5, which Windows PowerShell 5.1 compiles: no string interpolation or expression bodies.
$source = @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class LeafComputer {
  [StructLayout(LayoutKind.Sequential)]
  struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)]
  struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)]
  struct INPUT { public uint type; public INPUTUNION u; }
  [StructLayout(LayoutKind.Sequential)]
  struct POINT { public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)]
  struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT pt; }

  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool GetCursorInfo(ref CURSORINFO info);
  [DllImport("user32.dll")] static extern bool DrawIcon(IntPtr hdc, int x, int y, IntPtr icon);

  const uint INPUT_MOUSE = 0;
  const uint INPUT_KEYBOARD = 1;
  const uint KEYEVENTF_EXTENDEDKEY = 0x1;
  const uint KEYEVENTF_KEYUP = 0x2;
  const uint KEYEVENTF_UNICODE = 0x4;
  const uint MOUSEEVENTF_LEFTDOWN = 0x2;
  const uint MOUSEEVENTF_LEFTUP = 0x4;
  const uint MOUSEEVENTF_RIGHTDOWN = 0x8;
  const uint MOUSEEVENTF_RIGHTUP = 0x10;
  const uint MOUSEEVENTF_MIDDLEDOWN = 0x20;
  const uint MOUSEEVENTF_MIDDLEUP = 0x40;
  const uint MOUSEEVENTF_WHEEL = 0x800;
  const uint MOUSEEVENTF_HWHEEL = 0x1000;
  const int WHEEL_DELTA = 120;

  // Keys Windows tells apart from their twins on the number pad by the extended flag.
  static readonly ushort[] Extended = { 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0x5B, 0x5C };

  public static void Init() { SetProcessDPIAware(); }
  public static int Width() { return GetSystemMetrics(0); }
  public static int Height() { return GetSystemMetrics(1); }

  // SendInput puts nothing through when the window in front runs as administrator, or on the
  // sign-in and UAC screens; it says so by sending fewer events than it was given.
  static void Send(INPUT[] inputs) {
    uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    if (sent != inputs.Length) throw new InvalidOperationException("blocked");
  }

  static INPUT Mouse(uint flags, int data) {
    INPUT i = new INPUT();
    i.type = INPUT_MOUSE;
    i.u.mi.dwFlags = flags;
    i.u.mi.mouseData = unchecked((uint)data);
    return i;
  }

  static INPUT Key(ushort vk, ushort scan, uint flags) {
    INPUT i = new INPUT();
    i.type = INPUT_KEYBOARD;
    i.u.ki.wVk = vk;
    i.u.ki.wScan = scan;
    if (Array.IndexOf(Extended, vk) >= 0) flags |= KEYEVENTF_EXTENDEDKEY;
    i.u.ki.dwFlags = flags;
    return i;
  }

  static void Buttons(string button, out uint down, out uint up) {
    if (button == "right") { down = MOUSEEVENTF_RIGHTDOWN; up = MOUSEEVENTF_RIGHTUP; }
    else if (button == "middle") { down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP; }
    else { down = MOUSEEVENTF_LEFTDOWN; up = MOUSEEVENTF_LEFTUP; }
  }

  public static void Move(int x, int y) { SetCursorPos(x, y); }

  public static void Click(int x, int y, string button, int count) {
    uint down, up;
    Buttons(button, out down, out up);
    SetCursorPos(x, y);
    Thread.Sleep(30);
    for (int n = 0; n < count; n++) {
      Send(new INPUT[] { Mouse(down, 0), Mouse(up, 0) });
      Thread.Sleep(40);
    }
  }

  public static void Drag(int fromX, int fromY, int toX, int toY) {
    SetCursorPos(fromX, fromY);
    Thread.Sleep(30);
    Send(new INPUT[] { Mouse(MOUSEEVENTF_LEFTDOWN, 0) });
    // In steps, so the app under the pointer sees it move rather than jump.
    for (int s = 1; s <= 20; s++) {
      SetCursorPos(fromX + (toX - fromX) * s / 20, fromY + (toY - fromY) * s / 20);
      Thread.Sleep(10);
    }
    Send(new INPUT[] { Mouse(MOUSEEVENTF_LEFTUP, 0) });
  }

  // dy > 0 scrolls up and dx > 0 left, as the bot's tools count them.
  public static void Scroll(int x, int y, int dx, int dy) {
    SetCursorPos(x, y);
    Thread.Sleep(30);
    if (dy != 0) Send(new INPUT[] { Mouse(MOUSEEVENTF_WHEEL, dy * WHEEL_DELTA) });
    if (dx != 0) Send(new INPUT[] { Mouse(MOUSEEVENTF_HWHEEL, -dx * WHEEL_DELTA) });
  }

  public static void Press(int vk, int[] modifiers) {
    int n = modifiers.Length;
    INPUT[] inputs = new INPUT[n * 2 + 2];
    for (int i = 0; i < n; i++) inputs[i] = Key((ushort)modifiers[i], 0, 0);
    inputs[n] = Key((ushort)vk, 0, 0);
    inputs[n + 1] = Key((ushort)vk, 0, KEYEVENTF_KEYUP);
    for (int i = 0; i < n; i++) inputs[n + 2 + i] = Key((ushort)modifiers[n - 1 - i], 0, KEYEVENTF_KEYUP);
    Send(inputs);
  }

  // Types text as characters, whatever the keyboard layout: a line break presses Enter.
  public static void Type(string text) {
    string[] lines = text.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
    for (int l = 0; l < lines.Length; l++) {
      string line = lines[l];
      for (int c = 0; c < line.Length; c++) {
        ushort unit = line[c];
        Send(new INPUT[] { Key(0, unit, KEYEVENTF_UNICODE), Key(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP) });
        if (c % 16 == 15) Thread.Sleep(8);
      }
      if (l < lines.Length - 1) Press(0x0D, new int[0]);
    }
  }

  // The main screen, with the pointer drawn in, scaled to the size asked and encoded as JPEG.
  public static string Shot(int width, int height, long quality) {
    int w = Width();
    int h = Height();
    using (Bitmap full = new Bitmap(w, h, PixelFormat.Format24bppRgb)) {
      using (Graphics g = Graphics.FromImage(full)) {
        g.CopyFromScreen(0, 0, 0, 0, new Size(w, h));
        CURSORINFO info = new CURSORINFO();
        info.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
        if (GetCursorInfo(ref info) && info.flags == 1) {
          IntPtr hdc = g.GetHdc();
          try { DrawIcon(hdc, info.pt.x, info.pt.y, info.hCursor); } finally { g.ReleaseHdc(hdc); }
        }
      }
      using (Bitmap small = new Bitmap(width, height, PixelFormat.Format24bppRgb)) {
        using (Graphics s = Graphics.FromImage(small)) {
          s.InterpolationMode = InterpolationMode.HighQualityBicubic;
          s.DrawImage(full, 0, 0, width, height);
        }
        ImageCodecInfo jpeg = null;
        foreach (ImageCodecInfo codec in ImageCodecInfo.GetImageEncoders()) {
          if (codec.MimeType == "image/jpeg") jpeg = codec;
        }
        EncoderParameters options = new EncoderParameters(1);
        options.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
        using (MemoryStream m = new MemoryStream()) {
          small.Save(m, jpeg, options);
          return Convert.ToBase64String(m.ToArray());
        }
      }
    }
  }
}
'@

Add-Type -TypeDefinition $source -ReferencedAssemblies System.Drawing
[LeafComputer]::Init()

function Send-Answer($answer) {
  [Console]::Out.WriteLine(($answer | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

function Get-Status {
  # Windows asks for no permission to see the screen or to send input.
  @{ accessibility = $true; screen = $true; width = [LeafComputer]::Width(); height = [LeafComputer]::Height(); os = 'windows' }
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $id = $null
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    $out = @{}
    switch ([string]$req.op) {
      'status' { $out = Get-Status }
      'request' { $out = Get-Status }
      'move' { [LeafComputer]::Move([int]$req.x, [int]$req.y) }
      'click' {
        $count = 1
        if ($null -ne $req.count) { $count = [int]$req.count }
        [LeafComputer]::Click([int]$req.x, [int]$req.y, [string]$req.button, $count)
      }
      'drag' { [LeafComputer]::Drag([int]$req.fromX, [int]$req.fromY, [int]$req.toX, [int]$req.toY) }
      'scroll' { [LeafComputer]::Scroll([int]$req.x, [int]$req.y, [int]$req.dx, [int]$req.dy) }
      'type' {
        if ($req.text -isnot [string]) { throw 'badRequest' }
        [LeafComputer]::Type([string]$req.text)
      }
      'key' {
        $modifiers = [int[]]@()
        if ($null -ne $req.modifiers) { $modifiers = [int[]]@($req.modifiers) }
        [LeafComputer]::Press([int]$req.vk, $modifiers)
      }
      'shot' { $out = @{ data = [LeafComputer]::Shot([int]$req.width, [int]$req.height, [long]$req.quality) } }
      default { throw 'badRequest' }
    }
    $out.id = $id
    $out.ok = $true
    Send-Answer $out
  } catch {
    # A method's own error arrives wrapped by PowerShell; the innermost one says what happened.
    $e = $_.Exception
    while ($null -ne $e.InnerException) { $e = $e.InnerException }
    $code = 'failed'
    if ($e.Message -eq 'blocked' -or $e.Message -eq 'badRequest') { $code = $e.Message }
    Send-Answer @{ id = $id; ok = $false; error = $code }
  }
}
