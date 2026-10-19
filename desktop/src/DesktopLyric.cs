using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Globalization;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace WyyDesktopLyric
{
    /// <summary>
    /// 桌面歌词条：原生分层窗口（per-pixel alpha），置顶、无边框、可拖动。
    /// 播放状态由本地服务提供（扩展上报 -> 127.0.0.1:28123），位置在本机按墙钟平滑推进。
    /// </summary>
    internal static class Program
    {
        internal const string WindowTitle = "桌面歌词";

        private static string _logBase = "http://127.0.0.1:28123";

        /// <summary>诊断上报：写文件在这个环境里不靠谱，直接送给本地服务看。</summary>
        internal static void Log(string message)
        {
            try
            {
                using (var wc = new WebClient())
                {
                    wc.Encoding = Encoding.UTF8;
                    wc.Headers[HttpRequestHeader.ContentType] = "application/json";
                    var payload = "{\"tag\":\"app\"," +
                                  "\"msg\":" + Quote(DateTime.Now.ToString("HH:mm:ss.fff") + " " + message) + "}";
                    wc.UploadString(_logBase + "/api/log", "POST", payload);
                }
            }
            catch (Exception) { }
        }

        private static string Quote(string s)
        {
            return new JavaScriptSerializer().Serialize(s ?? "");
        }

        [STAThread]
        private static void Main(string[] args)
        {
            AppDomain.CurrentDomain.UnhandledException += (s, e) =>
                Log("UNHANDLED: " + e.ExceptionObject);

            bool created;
            using (var mutex = new Mutex(true, "WyyDesktopLyric.SingleInstance", out created))
            {
                Log("=== start pid=" + Process.GetCurrentProcess().Id + " created=" + created + " ===");
                if (!created)
                {
                    MessageBox.Show("桌面歌词已经在运行了。", WindowTitle, MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }

                int port = 28123;
                for (int i = 0; i < args.Length - 1; i++)
                {
                    if (args[i] == "--port") int.TryParse(args[i + 1], out port);
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.ThreadException += (s, e) => Log("THREAD EXCEPTION: " + e.Exception);
                try
                {
                    Log("creating form, port=" + port);
                    var form = new LyricForm(port);
                    Log("form created, running loop");
                    Application.Run(form);
                    Log("message loop exited");
                }
                catch (Exception ex)
                {
                    Log("FATAL: " + ex);
                    MessageBox.Show(ex.ToString(), WindowTitle + " 启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
                Log("=== exit ===");
            }
        }
    }

    internal sealed class LyricForm : Form
    {
        // ---------------------------------------------------------------- Win32
        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst, ref POINT pptDst, ref SIZE psize,
            IntPtr hdcSrc, ref POINT pprSrc, int crKey, ref BLENDFUNCTION pblend, int dwFlags);

        [DllImport("user32.dll")]
        private static extern IntPtr GetDC(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

        [DllImport("gdi32.dll")]
        private static extern IntPtr CreateCompatibleDC(IntPtr hdc);

        [DllImport("gdi32.dll")]
        private static extern IntPtr SelectObject(IntPtr hdc, IntPtr hObject);

        [DllImport("gdi32.dll")]
        private static extern bool DeleteObject(IntPtr hObject);

        [DllImport("gdi32.dll")]
        private static extern bool DeleteDC(IntPtr hdc);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

        [DllImport("user32.dll")]
        private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

        [StructLayout(LayoutKind.Sequential)]
        private struct POINT { public int X; public int Y; }

        [StructLayout(LayoutKind.Sequential)]
        private struct SIZE { public int cx; public int cy; }

        [StructLayout(LayoutKind.Sequential, Pack = 1)]
        private struct BLENDFUNCTION
        {
            public byte BlendOp; public byte BlendFlags; public byte SourceConstantAlpha; public byte AlphaFormat;
        }

        private const int ULW_ALPHA = 0x02;
        private const byte AC_SRC_OVER = 0x00;
        private const byte AC_SRC_ALPHA = 0x01;
        private const int WS_EX_LAYERED = 0x00080000;
        private const int WS_EX_TOPMOST = 0x00000008;
        private const int WS_EX_TOOLWINDOW = 0x00000080;
        private const int WS_EX_NOACTIVATE = 0x08000000;
        private const int WM_HOTKEY = 0x0312;
        private const uint MOD_ALT = 0x0001;
        private const uint MOD_CONTROL = 0x0002;
        private const uint MOD_NOREPEAT = 0x4000;
        private const int HOTKEY_TOGGLE = 1;
        private const int HOTKEY_COMPACT = 2;
        private const int HOTKEY_QUIT = 3;

        // ---------------------------------------------------------------- 状态
        private readonly int _port;
        private readonly string _baseUrl;
        private readonly WebClient _http = new WebClient();
        private readonly JavaScriptSerializer _json = new JavaScriptSerializer();
        private readonly System.Windows.Forms.Timer _pollTimer = new System.Windows.Forms.Timer();
        private readonly System.Windows.Forms.Timer _paintTimer = new System.Windows.Forms.Timer();

        private Snapshot _snap = new Snapshot();
        private List<Line> _lines = new List<Line>();
        private double _syncTick;          // 收到快照时的本地时间（Stopwatch 秒）
        private double _baseElapsed;       // 快照里的播放位置
        private readonly Stopwatch _clock = Stopwatch.StartNew();

        private int _activeIndex = -1;
        private string _lastPaintKey = "";
        private bool _dragging;
        private bool _hover;
        private Point _dragOrigin;
        private bool _compact;
        private bool _visible = true;
        private bool _mini;                 // 手动隐藏后留下的"小胶囊"，点它可以恢复
        private static readonly Size MiniSize = new Size(132, 32);
        private bool _idleHidden;          // 长时间没在播放时自动收起
        private DateTime _manualShowUntil = DateTime.MinValue;  // 手动显示后的豁免期
        private const double IDLE_HIDE_SECONDS = 300;   // 5 分钟都没动静才收起，别在用户还没接好时就玩消失
        private const double STALE_FREEZE_SECONDS = 30;
        private int _fontSize = 26;
        private volatile bool _busy;
        private int _logBudget = 6;

        private Rectangle _bounds;
        private int _dragAreaHeight = 26;

        private NotifyIcon _tray;
        private ContextMenuStrip _trayMenu;
        private Icon _trayIcon;

        // 颜色（完全不透明，毕竟要压在别的窗口上读字）
        private static readonly Color BarTop = Color.FromArgb(255, 24, 26, 32);
        private static readonly Color BarBottom = Color.FromArgb(255, 14, 16, 20);
        private static readonly Color BorderColor = Color.FromArgb(52, 255, 255, 255);
        private static readonly Color TextMain = Color.FromArgb(255, 255, 255, 255);
        private static readonly Color TextDim = Color.FromArgb(168, 240, 244, 250);
        private static readonly Color TextFaint = Color.FromArgb(126, 240, 244, 250);
        private static readonly Color AccentA = Color.FromArgb(255, 255, 77, 77);
        private static readonly Color AccentB = Color.FromArgb(255, 255, 122, 122);
        private static readonly Color DotIdle = Color.FromArgb(255, 120, 130, 145);
        private static readonly Color DotPaused = Color.FromArgb(255, 234, 179, 8);

        internal LyricForm(int port)
        {
            _port = port;
            _baseUrl = "http://127.0.0.1:" + port;

            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            Text = Program.WindowTitle;
            TopMost = true;
            MinimumSize = new Size(200, 40);
            BackColor = Color.Black;
            DoubleBuffered = true;

            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);

            _pollTimer.Interval = 300;
            _pollTimer.Tick += (s, e) => Poll();
            _paintTimer.Interval = 100;
            _paintTimer.Tick += (s, e) => Repaint(false);

            Load += (s, e) =>
            {
                try
                {
                    Program.Log("Load: applying ex styles");
                    ApplyExStyles();
                    LayoutWindow();
                    Show();
                    TopMost = true;
                    RegisterHotkeys();
                    InitTray();
                    _pollTimer.Start();
                    _paintTimer.Start();
                    Program.Log("Load: polling once, bounds=" + _bounds);
                    Poll();
                    Program.Log("Load: done");
                }
                catch (Exception ex)
                {
                    Program.Log("Load FAILED: " + ex);
                }
            };
        }

        // ---------------------------------------------------------------- 窗口
        private void ApplyExStyles()
        {
            int ex = WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
            SetWindowLong(Handle, -20, ex);
        }

        [DllImport("user32.dll", EntryPoint = "SetWindowLongPtr")]
        private static extern IntPtr SetWindowLongPtr64(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

        [DllImport("user32.dll", EntryPoint = "SetWindowLong")]
        private static extern int SetWindowLong32(IntPtr hWnd, int nIndex, int dwNewLong);

        private static void SetWindowLong(IntPtr hWnd, int nIndex, int value)
        {
            if (IntPtr.Size == 8) SetWindowLongPtr64(hWnd, nIndex, new IntPtr(value));
            else SetWindowLong32(hWnd, nIndex, value);
        }

        private void RegisterHotkeys()
        {
            RegisterHotKey(Handle, HOTKEY_TOGGLE, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, 0x4C); // Ctrl+Alt+L
            RegisterHotKey(Handle, HOTKEY_COMPACT, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, 0x43); // Ctrl+Alt+C
            RegisterHotKey(Handle, HOTKEY_QUIT, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, 0x51); // Ctrl+Alt+Q
        }

        // ---------------------------------------------------------------- 托盘图标
        /// <summary>
        /// 托盘图标是「隐藏之后还能找回来」的唯一入口：
        /// 窗口缩成 1x1 就看不见也点不到，只能靠托盘或热键。
        /// </summary>
        private void InitTray()
        {
            _trayMenu = new ContextMenuStrip();
            _trayMenu.Opening += (s, e) => RebuildTrayMenu();

            _tray = new NotifyIcon();
            _tray.Icon = BuildTrayIcon();
            _tray.Text = "桌面歌词";
            _tray.Visible = true;
            _tray.ContextMenuStrip = _trayMenu;
            _tray.DoubleClick += (s, e) => ShowFromTray();
            _tray.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) ShowFromTray(); };
        }

        private Icon BuildTrayIcon()
        {
            // 用 32px 画再交给系统缩放，16px 直接画会糊
            using (var bmp = new Bitmap(32, 32))
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.Clear(Color.Transparent);
                    using (var red = new SolidBrush(Color.FromArgb(255, 226, 48, 48)))
                        g.FillEllipse(red, 1, 1, 30, 30);
                    using (var white = new SolidBrush(Color.FromArgb(255, 255, 255, 255)))
                        g.FillEllipse(white, 9, 9, 14, 14);
                    using (var dark = new SolidBrush(Color.FromArgb(255, 26, 28, 34)))
                        g.FillEllipse(dark, 12, 12, 8, 8);
                }
                IntPtr h = bmp.GetHicon();
                _trayIcon = Icon.FromHandle(h);
                return _trayIcon;
            }
        }

        private void RebuildTrayMenu()
        {
            _trayMenu.Items.Clear();
            _trayMenu.Items.Add(_visible ? "隐藏歌词\tCtrl+Alt+L" : "显示歌词\tCtrl+Alt+L", null,
                (s, e) => { if (_visible) ToggleVisible(); else ShowFromTray(); });
            _trayMenu.Items.Add(_compact ? "展开双行\tCtrl+Alt+C" : "切换到单行\tCtrl+Alt+C", null,
                (s, e) => ToggleCompact());

            var sizeMenu = new ToolStripMenuItem("字号");
            foreach (int size in new[] { 20, 23, 26, 30, 34 })
            {
                int captured = size;
                var item = new ToolStripMenuItem(size + " px", null, (s, e) =>
                {
                    _fontSize = captured;
                    LayoutWindow();
                    Repaint(true);
                });
                item.Checked = _fontSize == size;
                sizeMenu.DropDownItems.Add(item);
            }
            _trayMenu.Items.Add(sizeMenu);

            string now = !string.IsNullOrEmpty(_snap.SongName) ? _snap.SongName : "（未在播放）";
            _trayMenu.Items.Add(new ToolStripSeparator());
            _trayMenu.Items.Add(new ToolStripMenuItem(now) { Enabled = false });
            if (!string.IsNullOrEmpty(_snap.Artist))
                _trayMenu.Items.Add(new ToolStripMenuItem(_snap.Artist) { Enabled = false });

            _trayMenu.Items.Add(new ToolStripSeparator());
            _trayMenu.Items.Add("重新取词", null, (s, e) =>
            {
                try { Get("/api/lyrics?force=1"); } catch (Exception) { }
                Poll();
            });
            _trayMenu.Items.Add("退出", null, (s, e) => Close());
        }

        private void ShowFromTray()
        {
            _visible = true;
            _idleHidden = false;
            _manualShowUntil = DateTime.Now.AddMinutes(5);   // 手动显示的，别马上又被"空闲自动隐藏"吃掉
            ApplyExStyles();
            LayoutWindow();
            Show();
            TopMost = true;
            Repaint(true);
        }

        private int TargetHeight()
        {
            return _compact ? 58 : Math.Max(110, _fontSize * 2 + 96);
        }

        private void LayoutWindow()
        {
            var wa = Screen.PrimaryScreen.WorkingArea;
            int w = Math.Min(760, wa.Width - 60);
            if (w < 320) w = wa.Width;
            int h = TargetHeight();

            // 默认位置：屏幕顶部居中（不挡任务栏，也不压住下方的工作区）。
            // 不做位置记忆——上次不小心拖到哪就固定在哪太意外了。
            int x = wa.X + (wa.Width - w) / 2;
            int y = wa.Y + 10;
            _bounds = new Rectangle(x, y, w, h);
            Bounds = _bounds;
            _dragAreaHeight = _compact ? h : 26;
            ClampToScreen();
        }

        /// <summary>把窗口拉回可见区域：换分辨率/拔掉外接屏后不至于跑到屏幕外。</summary>
        private void ClampToScreen()
        {
            var wa = Screen.PrimaryScreen.WorkingArea;
            int w = Math.Min(_bounds.Width, wa.Width);
            int h = Math.Min(_bounds.Height, wa.Height);
            int x = Math.Max(wa.X, Math.Min(_bounds.X, wa.X + wa.Width - w));
            int y = Math.Max(wa.Y, Math.Min(_bounds.Y, wa.Y + wa.Height - h));
            if (x != _bounds.X || y != _bounds.Y || w != _bounds.Width || h != _bounds.Height)
            {
                _bounds = new Rectangle(x, y, w, h);
                _dragAreaHeight = _compact ? h : 26;
            }
        }

        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                cp.ExStyle |= WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW;
                return cp;
            }
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_HOTKEY)
            {
                switch (m.WParam.ToInt32())
                {
                    case HOTKEY_TOGGLE: ToggleVisible(); break;
                    case HOTKEY_COMPACT: ToggleCompact(); break;
                    case HOTKEY_QUIT: Close(); break;
                }
                return;
            }
            base.WndProc(ref m);
        }

        private void ToggleVisible()
        {
            _visible = !_visible;
            if (_visible)
            {
                _mini = false;
                _idleHidden = false;
                ApplyExStyles();
                LayoutWindow();
                Repaint(true);
            }
            else
            {
                // 不缩成 1x1：那样就彻底没有入口了。留一个写着「显示歌词」的小胶囊。
                EnterMiniMode();
            }
        }

        /// <summary>
        /// 缩小成小胶囊，点一下就能恢复。
        ///
        /// 位置策略：贴在屏幕右侧、顶部往下一点，但必须保证**不和其它程序的窗口重叠**。
        /// 之前用「探测到占用就往下挪一格」的写法，遇到大窗口（比如居中的任务管理器）
        /// 会一路挪到莫名其妙的地方，甚至挪出屏幕。现在改成：
        ///   先用右上角，若被占，就贴着屏幕右侧往下找第一个空位；实在找不到就贴在任务栏上方。
        /// </summary>
        private void EnterMiniMode()
        {
            _mini = true;
            var wa = Screen.PrimaryScreen.WorkingArea;
            int w = MiniSize.Width, h = MiniSize.Height;
            int rightX = wa.Right - w - 12;

            // 候选位置：从右上角开始，每隔一个胶囊高度往下探，最多 12 个
            int top = wa.Top + 10;
            int maxY = wa.Bottom - h - 10;
            var chosen = new Rectangle(rightX, top, w, h);

            bool free = IsSpotFree(chosen);
            if (!free)
            {
                for (int y = top; y <= maxY; y += h + 8)
                {
                    var cand = new Rectangle(rightX, y, w, h);
                    if (IsSpotFree(cand)) { chosen = cand; free = true; break; }
                }
            }
            if (!free)
            {
                // 全都占着：退回右上角，至少位置是可预期的
                chosen = new Rectangle(rightX, top, w, h);
            }

            _bounds = chosen;
            _dragAreaHeight = h;
            Repaint(true);
        }

        // ---------------------------------------------------------------- 占用探测

        [DllImport("user32.dll")]
        private static extern IntPtr WindowFromPoint(POINT pt);

        [DllImport("user32.dll")]
        private static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);


        /// <summary>
        /// 这个矩形是否「空」：在矩形里取几个采样点，看底下是不是自己的窗口或桌面。
        /// 只看中心点是不够的——中心点可能落在别的窗口的空隙里，但边缘还是被压住。
        /// </summary>
        private bool IsSpotFree(Rectangle r)
        {
            // 四个角 + 中心，各内缩 4px 避开圆角
            var pts = new[]
            {
                new POINT { X = r.Left + 4,  Y = r.Top + 4 },
                new POINT { X = r.Right - 4, Y = r.Top + 4 },
                new POINT { X = r.Left + 4,  Y = r.Bottom - 4 },
                new POINT { X = r.Right - 4, Y = r.Bottom - 4 },
                new POINT { X = r.Left + r.Width / 2, Y = r.Top + r.Height / 2 },
            };

            foreach (var pt in pts)
            {
                IntPtr h = WindowFromPoint(pt);
                if (h == IntPtr.Zero) continue;
                IntPtr root = GetAncestor(h, 2);   // GA_ROOT
                if (root == IntPtr.Zero) continue;
                if (root == Handle) continue;      // 自己的窗口，不算占

                // 桌面/任务栏不算占（它们本来就是背景）
                var cls = GetClassOf(root);
                if (cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd" || cls == "Shell_SecondaryTrayWnd")
                    continue;

                return false;
            }
            return true;
        }

        private static string GetClassOf(IntPtr h)
        {
            try
            {
                var sb = new System.Text.StringBuilder(128);
                GetClassName(h, sb, sb.Capacity);
                return sb.ToString();
            }
            catch { return ""; }
        }

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);

        /// <summary>画小胶囊：一个可点回来的入口。</summary>
        private void DrawMini(Graphics g, Rectangle rect)
        {
            using (var path = RoundedRect(new Rectangle(0, 0, rect.Width - 1, rect.Height - 1), 9))
            {
                using (var brush = new LinearGradientBrush(rect, BarTop, BarBottom, 90f))
                    g.FillPath(brush, path);
                using (var pen = new Pen(BorderColor, 1f))
                    g.DrawPath(pen, path);
            }
            using (var f = new Font("Microsoft YaHei UI", 10.5f, FontStyle.Regular, GraphicsUnit.Pixel))
            using (var sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
            using (var b = new SolidBrush(TextDim))
            {
                g.DrawString("♪  显示歌词", f, b, new RectangleF(0, 0, rect.Width, rect.Height), sf);
            }
        }

        private void ToggleCompact()
        {
            _compact = !_compact;
            LayoutWindow();
            Repaint(true);
        }

        // ---------------------------------------------------------------- 数据
        private string Get(string path)
        {
            using (var wc = new WebClient())
            {
                wc.Encoding = Encoding.UTF8;
                wc.Headers[HttpRequestHeader.Accept] = "application/json";
                return wc.DownloadString(_baseUrl + path);
            }
        }

        private void Poll()
        {
            if (_busy) return;
            _busy = true;
            ThreadPool.QueueUserWorkItem(_ =>
            {
                try
                {
                    string raw = Get("/api/state");
                    var dict = _json.Deserialize<Dictionary<string, object>>(raw);
                    var snap = Snapshot.From(dict);
                    var lines = Line.FromSnapshot(dict);
                    if (_logBudget-- > 0)
                        Program.Log("poll: status=" + snap.Status + " connected=" + snap.Connected +
                                    " song=" + snap.SongName + " lines=" + lines.Count +
                                    " rawKeys=" + string.Join(",", new List<string>(dict.Keys).ToArray()));
                    BeginInvoke((Action)(() =>
                    {
                        bool recovered = !_backendAlive;
                        _backendAlive = true;
                        _backendDownSince = DateTime.MinValue;
                        _backendRestartTries = 0;
                        _snap = snap;
                        _lines = lines;
                        _baseElapsed = snap.Elapsed;
                        _syncTick = _clock.Elapsed.TotalSeconds;
                        _activeIndex = -1;
                        if (recovered) Program.Log("backend: 已恢复");
                        Repaint(true);
                    }));
                }
                catch (Exception ex)
                {
                    Program.Log("poll FAILED: " + ex.Message);
                    BeginInvoke((Action)(() =>
                    {
                        // 后端连不上：标记出来，让界面明确显示「服务已停止」而不是含糊的「未连接」
                        if (_backendAlive)
                        {
                            _backendAlive = false;
                            _backendDownSince = DateTime.Now;
                            Program.Log("backend: 失联 " + ex.Message);
                        }

                        if (!_snap.Connected)
                        {
                            _snap.Status = "offline";
                            Repaint(true);
                        }

                        TryRestartBackend();
                    }));
                }
                finally { _busy = false; }
            });
        }

        // ---------------------------------------------------------------- 后端自愈
        private bool _backendAlive = true;
        private DateTime _backendDownSince = DateTime.MinValue;
        private int _backendRestartTries;
        private DateTime _lastRestartAttempt = DateTime.MinValue;

        /// <summary>
        /// 后端（server.js）挂了之后尝试拉起来。
        ///
        /// 之前歌词窗只会一直重试 HTTP，后端死了也看不出来——表现就是「前端图标还在，但什么都不显示」。
        /// 现在：
        ///   · 连续失败 10 秒后开始尝试重启
        ///   · 每次重启间隔至少 30 秒，最多试 5 次
        ///   · 优先用系统 node；找不到就放弃，提示用户手动跑 启动.cmd
        /// </summary>
        private void TryRestartBackend()
        {
            if (_backendAlive) return;
            if ((DateTime.Now - _backendDownSince).TotalSeconds < 10) return;
            if (_backendRestartTries >= 5) return;
            if ((DateTime.Now - _lastRestartAttempt).TotalSeconds < 30) return;

            _lastRestartAttempt = DateTime.Now;
            _backendRestartTries++;
            Program.Log("backend: 尝试重启 #" + _backendRestartTries);

            ThreadPool.QueueUserWorkItem(_ =>
            {
                try
                {
                    string exe = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "server.js");
                    if (!File.Exists(exe)) { Program.Log("backend: 找不到 server.js"); return; }

                    string node = FindNode();
                    if (node == null) { Program.Log("backend: 找不到 node.exe"); return; }

                    var psi = new ProcessStartInfo(node, "\"" + exe + "\"")
                    {
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        WorkingDirectory = AppDomain.CurrentDomain.BaseDirectory,
                        RedirectStandardOutput = false,
                        RedirectStandardError = false,
                    };
                    var p = Process.Start(psi);
                    Program.Log("backend: 已拉起 pid=" + (p == null ? 0 : p.Id));
                }
                catch (Exception ex)
                {
                    Program.Log("backend: 重启失败 " + ex.Message);
                }
            });
        }

        /// <summary>找系统中的 node.exe：先看 PATH，再看常见安装位置。</summary>
        private static string FindNode()
        {
            string pathVar = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (var dir in pathVar.Split(';'))
            {
                if (string.IsNullOrWhiteSpace(dir)) continue;
                try
                {
                    string candidate = Path.Combine(dir.Trim(), "node.exe");
                    if (File.Exists(candidate)) return candidate;
                }
                catch (Exception) { }
            }

            foreach (var guess in new[]
            {
                @"C:\Program Files\nodejs\node.exe",
                @"C:\Program Files (x86)\nodejs\node.exe",
            })
            {
                if (File.Exists(guess)) return guess;
            }
            return null;
        }

        private double CurrentElapsed()
        {
            // 没连上或者长时间没上报：位置冻结在最后一次，别让进度条自己往前跑
            if (!_snap.Playing || !_snap.Connected) return _baseElapsed;
            if (_snap.Stale >= 0 && _snap.Stale > STALE_FREEZE_SECONDS) return _baseElapsed;
            double t = _baseElapsed + (_clock.Elapsed.TotalSeconds - _syncTick);
            if (_snap.Duration > 0) t = Math.Min(t, _snap.Duration);
            return Math.Max(0, t);
        }

        // ---------------------------------------------------------------- 绘制
        private void Repaint(bool force)
        {
            if (!_visible && !_mini) return;

            if (_mini)
            {
                var miniRect = new Rectangle(0, 0, _bounds.Width, _bounds.Height);
                using (var bmp = new Bitmap(miniRect.Width, miniRect.Height, System.Drawing.Imaging.PixelFormat.Format32bppArgb))
                {
                    using (var g = Graphics.FromImage(bmp))
                    {
                        g.SmoothingMode = SmoothingMode.AntiAlias;
                        g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
                        DrawMini(g, miniRect);
                    }
                    PushBitmap(bmp, new Point(_bounds.X, _bounds.Y));
                }
                return;
            }

            // 网页版早就不在播了（关了一夜之类）：别把一条满格进度条赖在桌面上
            bool idle = !_snap.Connected && (_snap.Stale < 0 || _snap.Stale > IDLE_HIDE_SECONDS);
            if (idle && DateTime.Now < _manualShowUntil) idle = false;   // 用户刚手动叫出来的，给个豁免
            if (idle)
            {
                if (!_idleHidden)
                {
                    // 不要缩成 1x1——那样既看不见也点不到，只能靠热键或托盘。
                    // 本机系统托盘根本不显示 NotifyIcon 图标，热键又可能被占用，
                    // 所以这里同样缩成「♪ 显示歌词」胶囊，保证用户一定能找回来。
                    _idleHidden = true;
                    EnterMiniMode();
                    Program.Log("idle: 已自动收起为胶囊");
                }
                return;
            }
            if (_idleHidden)
            {
                _idleHidden = false;
                _mini = false;
                force = true;              // 立刻重画回来，别等下一次歌词变化
                LayoutWindow();
                Program.Log("idle: 恢复显示");
            }

            double t = CurrentElapsed();
            int idx = IndexAt(t);
            int second = (int)Math.Floor(t);

            string key = string.Join("|", new[]
            {
                _snap.SongId ?? "", _snap.Status, _snap.SongName ?? "", _snap.Artist ?? "",
                _snap.Playing ? "1" : "0", idx.ToString(), second.ToString(),
                _compact ? "c" : "e", _fontSize.ToString(), _snap.Msg ?? ""
            });
            if (!force && key == _lastPaintKey) return;
            _lastPaintKey = key;

            if (idx != _activeIndex) _activeIndex = idx;

            // 托盘提示同步当前歌名（.NET 限制 63 字符）
            if (_tray != null)
            {
                string tip = string.IsNullOrEmpty(_snap.SongName) ? "桌面歌词" : "桌面歌词 · " + _snap.SongName;
                if (tip.Length > 62) tip = tip.Substring(0, 62);
                if (_tray.Text != tip)
                {
                    try { _tray.Text = tip; } catch (Exception) { }
                }
            }

            var rect = new Rectangle(0, 0, _bounds.Width, _bounds.Height);
            using (var bmp = new Bitmap(rect.Width, rect.Height, System.Drawing.Imaging.PixelFormat.Format32bppArgb))
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
                    g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    Draw(g, rect, t, idx);
                }
                PushBitmap(bmp, new Point(_bounds.X, _bounds.Y));
            }
        }

        private void Draw(Graphics g, Rectangle rect, double t, int idx)
        {
            int radius = _compact ? 10 : 16;
            using (var path = RoundedRect(new Rectangle(rect.X + 1, rect.Y + 1, rect.Width - 2, rect.Height - 2), radius))
            {
                using (var brush = new LinearGradientBrush(new Rectangle(rect.X, rect.Y, rect.Width, rect.Height), BarTop, BarBottom, 90f))
                    g.FillPath(brush, path);
                using (var pen = new Pen(BorderColor, 1f))
                    g.DrawPath(pen, path);
            }

            bool connected = _snap.Connected;
            bool idle = !connected;

            if (!connected)
            {
                DrawDisconnected(g, rect);
                return;
            }

            if (_compact)
            {
                DrawCompact(g, rect, t, idx, idle);
                return;
            }

            // ---- 顶部信息行
            int padX = 20;
            int metaY = 12;
            int dotSize = 7;
            var dotColor = !connected ? DotIdle : (_snap.Playing ? AccentA : DotPaused);
            using (var db = new SolidBrush(dotColor))
                g.FillEllipse(db, padX, metaY + 5, dotSize, dotSize);
            if (_snap.Playing && connected)
            {
                using (var glow = new SolidBrush(Color.FromArgb(70, dotColor)))
                    g.FillEllipse(glow, padX - 3, metaY + 2, dotSize + 6, dotSize + 6);
            }

            using (var fMeta = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Regular, GraphicsUnit.Point))
            using (var fMetaB = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Bold, GraphicsUnit.Point))
            {
                int x = padX + dotSize + 8;
                string song = connected && !string.IsNullOrEmpty(_snap.SongName) ? _snap.SongName : "等待网页版开始播放";
                var songSize = g.MeasureString(song, fMetaB);
                if (x + songSize.Width > rect.Width - 200)
                    song = Clip(g, song, fMetaB, rect.Width - 200 - x);
                using (var sb = new SolidBrush(connected ? TextDim : TextFaint))
                    g.DrawString(song, fMetaB, sb, x, metaY);
                x += (int)g.MeasureString(song, fMetaB).Width + 10;

                if (connected && !string.IsNullOrEmpty(_snap.Artist))
                {
                    string artist = _snap.Artist;
                    if (x + g.MeasureString(artist, fMeta).Width > rect.Width - 190)
                        artist = Clip(g, artist, fMeta, rect.Width - 190 - x);
                    using (var ab = new SolidBrush(TextFaint))
                        g.DrawString(artist, fMeta, ab, x, metaY);
                }

                // 右上角操作提示：只在鼠标悬停时显示，平时保持干净
                if (_hover)
                {
                    using (var hb = new SolidBrush(TextFaint))
                    {
                        string hint = "Ctrl+Alt+L 隐藏  ·  Ctrl+Alt+C " + (_compact ? "展开" : "单行") + "  ·  右键菜单";
                        var hs = g.MeasureString(hint, fMeta);
                        g.DrawString(hint, fMeta, hb, rect.Width - hs.Width - padX, metaY);
                    }
                }
            }

            // ---- 歌词
            int lyricTop = 40;
            int footH = 30;
            var lyricRect = new Rectangle(padX, lyricTop, rect.Width - padX * 2, rect.Height - lyricTop - footH);

            string main, sub, next;
            PickText(t, idx, out main, out sub, out next);
            bool isCredit = idx >= 0 && idx < _lines.Count && _lines[idx].Credit;

            using (var fMain = new Font("Microsoft YaHei UI", isCredit ? Math.Max(14, _fontSize - 7) : _fontSize, isCredit ? FontStyle.Regular : FontStyle.Bold, GraphicsUnit.Pixel))
            using (var fSub = new Font("Microsoft YaHei UI", 12.5f, FontStyle.Regular, GraphicsUnit.Point))
            using (var fNext = new Font("Microsoft YaHei UI", 13.5f, FontStyle.Regular, GraphicsUnit.Point))
            using (var sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center, Trimming = StringTrimming.EllipsisCharacter, FormatFlags = StringFormatFlags.NoWrap })
            {
                bool hasSub = !string.IsNullOrEmpty(sub);
                bool hasNext = !string.IsNullOrEmpty(next);

                int mainH = (int)g.MeasureString(main, fMain).Height;
                int subH = hasSub ? (int)g.MeasureString(sub, fSub).Height : 0;
                int nextH = hasNext ? (int)g.MeasureString(next, fNext).Height + 4 : 0;
                int block = mainH + subH + nextH;
                int top = lyricRect.Y + Math.Max(0, (lyricRect.Height - block) / 2);

                using (var shadow = new SolidBrush(Color.FromArgb(120, 0, 0, 0)))
                    g.DrawString(main, fMain, shadow, new RectangleF(lyricRect.X + 1, top + 2, lyricRect.Width, mainH), sf);
                using (var mb = new SolidBrush(isCredit ? TextDim : (idle ? TextDim : TextMain)))
                    g.DrawString(main, fMain, mb, new RectangleF(lyricRect.X, top, lyricRect.Width, mainH), sf);

                int y = top + mainH;
                if (hasSub)
                {
                    using (var sb2 = new SolidBrush(TextDim))
                        g.DrawString(sub, fSub, sb2, new RectangleF(lyricRect.X, y, lyricRect.Width, subH), sf);
                    y += subH;
                }
                if (hasNext)
                {
                    using (var nb = new SolidBrush(TextFaint))
                        g.DrawString(next, fNext, nb, new RectangleF(lyricRect.X, y + 4, lyricRect.Width, nextH), sf);
                }
            }

            // ---- 底部进度
            int barY = rect.Height - 18;
            int timeW = 92;
            var trackRect = new Rectangle(padX, barY, rect.Width - padX * 2 - timeW - 10, 3);
            using (var tb = new SolidBrush(Color.FromArgb(30, 255, 255, 255)))
                FillRounded(g, trackRect, 2, tb);

            double dur = _snap.Duration;
            double pct = dur > 0 ? Math.Max(0, Math.Min(1, t / dur)) : 0;
            int fillW = (int)(trackRect.Width * pct);
            if (fillW > 1)
            {
                var fillRect = new Rectangle(trackRect.X, trackRect.Y, fillW, trackRect.Height);
                using (var fb = new LinearGradientBrush(new Rectangle(trackRect.X, trackRect.Y, Math.Max(2, trackRect.Width), trackRect.Height), AccentA, AccentB, 0f))
                    FillRounded(g, fillRect, 2, fb);
            }

            using (var fTime = new Font("Consolas", 9.5f, FontStyle.Regular, GraphicsUnit.Point))
            using (var tbm = new SolidBrush(TextFaint))
            {
                string ts = Mmss(t) + " / " + (dur > 0 ? Mmss(dur) : "--:--");
                var size = g.MeasureString(ts, fTime);
                g.DrawString(ts, fTime, tbm, rect.Width - padX - size.Width, barY - size.Height / 2 + 1);
            }
        }

        /// <summary>
        /// 没连上时画这个。要说清楚是哪一层断了：
        ///   · 后端服务（server.js）挂了 —— 这才是真正的故障，必须明确写出来
        ///   · 服务在、但没有任何上报 —— 播放器没在放歌，或浏览器没开
        /// 以前两种情况都只显示「网页版未连接」，导致后端崩了也看不出来。
        /// </summary>
        private void DrawDisconnected(Graphics g, Rectangle rect)
        {
            int padX = 20;
            int metaY = 12;

            // 后端服务本身连不上 = 严重故障
            bool backendDown = !_backendAlive;

            using (var db = new SolidBrush(backendDown ? DotPaused : DotIdle))
                g.FillEllipse(db, padX, metaY + 5, 7, 7);

            using (var fMeta = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Bold, GraphicsUnit.Point))
            using (var fMain = new Font("Microsoft YaHei UI", _compact ? 16f : 19f, FontStyle.Regular, GraphicsUnit.Pixel))
            using (var sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center, Trimming = StringTrimming.EllipsisCharacter, FormatFlags = StringFormatFlags.NoWrap })
            {
                string head = backendDown ? "歌词服务已停止" : "网页版未连接";
                using (var mb = new SolidBrush(backendDown ? DotPaused : TextDim))
                    g.DrawString(head, fMeta, mb, padX + 14, metaY);

                using (var hb = new SolidBrush(Color.FromArgb(110, 240, 244, 250)))
                    g.DrawString(backendDown ? "正在自动重启…" : "歌词窗只显示，不播放", fMeta, hb, rect.Width - 180, metaY);

                string main;
                if (backendDown)
                {
                    // 明确告诉用户"这不是我在放歌的问题"，并给出自救动作
                    main = _backendRestartTries > 0
                        ? "后端已停止，正在重试启动（第 " + _backendRestartTries + " 次）· 也可以双击 启动.cmd"
                        : "后端已停止 · 双击 启动.cmd 重新启动";
                }
                else
                {
                    main = "在 music.163.com 播放歌曲后自动显示歌词";
                }

                using (var tb = new SolidBrush(backendDown ? Color.FromArgb(230, 240, 244, 250) : TextDim))
                    g.DrawString(main, fMain, tb,
                        new RectangleF(padX, 34, rect.Width - padX * 2, rect.Height - 46), sf);
            }
        }

        private void DrawCompact(Graphics g, Rectangle rect, double t, int idx, bool idle)
        {
            string main, sub, next;
            PickText(t, idx, out main, out sub, out next);

            using (var fMain = new Font("Microsoft YaHei UI", Math.Max(15, _fontSize - 4), FontStyle.Bold, GraphicsUnit.Pixel))
            using (var sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center, Trimming = StringTrimming.EllipsisCharacter, FormatFlags = StringFormatFlags.NoWrap })
            using (var mb = new SolidBrush(idle ? TextDim : TextMain))
            {
                g.DrawString(main, fMain, mb, new RectangleF(14, 0, rect.Width - 28, rect.Height), sf);
            }

            double dur = _snap.Duration;
            double pct = dur > 0 ? Math.Max(0, Math.Min(1, t / dur)) : 0;
            var trackRect = new Rectangle(16, rect.Height - 6, rect.Width - 32, 3);
            using (var tb = new SolidBrush(Color.FromArgb(30, 255, 255, 255)))
                FillRounded(g, trackRect, 2, tb);
            int fillW = (int)(trackRect.Width * pct);
            if (fillW > 1)
            {
                using (var fb = new LinearGradientBrush(new Rectangle(trackRect.X, trackRect.Y, Math.Max(2, trackRect.Width), trackRect.Height), AccentA, AccentB, 0f))
                    FillRounded(g, new Rectangle(trackRect.X, trackRect.Y, fillW, trackRect.Height), 2, fb);
            }
        }

        private void PickText(double t, int idx, out string main, out string sub, out string next)
        {
            main = ""; sub = ""; next = "";

            if (_lines.Count == 0)
            {
                switch (_snap.Status)
                {
                    case "offline": main = "歌词服务未连接（先运行 启动.cmd）"; break;
                    case "loading": main = "正在取词…"; break;
                    case "empty": main = string.IsNullOrEmpty(_snap.Msg) ? "这首歌还没有歌词" : _snap.Msg; break;
                    case "error": main = string.IsNullOrEmpty(_snap.Msg) ? "取词失败" : _snap.Msg; break;
                    default:
                        main = _snap.Connected ? "还没有歌词" : "在 music.163.com 播放歌曲后这里会显示歌词";
                        break;
                }
                return;
            }

            Line cur = idx >= 0 && idx < _lines.Count ? _lines[idx] : null;

            // 下一句要跳过版权行，否则开头会显示「作曲 : xxx」这种噪声
            int ni = idx + 1;
            while (ni < _lines.Count && _lines[ni].Credit) ni++;
            Line nxt = ni >= 0 && ni < _lines.Count ? _lines[ni] : null;

            main = cur == null ? (_snap.SongName ?? "") : FirstNonEmpty(cur.Text, cur.Tr, cur.Ro);
            var subs = new List<string>();
            if (cur != null && !string.IsNullOrEmpty(cur.Tr) && cur.Tr != cur.Text) subs.Add(cur.Tr);
            if (cur != null && !string.IsNullOrEmpty(cur.Ro) && cur.Ro != cur.Text && cur.Ro != cur.Tr) subs.Add(cur.Ro);
            sub = string.Join("   ·   ", subs.ToArray());
            next = subs.Count > 0 ? "" : (nxt == null ? "" : FirstNonEmpty(nxt.Text, nxt.Tr, nxt.Ro));
        }

        private static string FirstNonEmpty(params string[] vals)
        {
            foreach (var v in vals) if (!string.IsNullOrEmpty(v)) return v;
            return "";
        }

        private int IndexAt(double t)
        {
            int lo = 0, hi = _lines.Count - 1, ans = -1;
            while (lo <= hi)
            {
                int mid = (lo + hi) / 2;
                if (_lines[mid].T <= t + 0.15) { ans = mid; lo = mid + 1; }
                else hi = mid - 1;
            }
            // 版权行（作词/录音/OP 之类）不抢高亮：它们通常挤在开头或结尾
            while (ans >= 0 && _lines[ans].Credit) ans--;
            return ans;
        }

        private static string Mmss(double sec)
        {
            if (double.IsNaN(sec) || sec < 0) sec = 0;
            int total = (int)Math.Floor(sec);
            return (total / 60) + ":" + (total % 60).ToString("00");
        }

        private static string Clip(Graphics g, string text, Font font, int maxWidth)
        {
            if (maxWidth <= 10) return "";
            if (g.MeasureString(text, font).Width <= maxWidth) return text;
            for (int len = text.Length - 1; len > 0; len--)
            {
                string probe = text.Substring(0, len) + "…";
                if (g.MeasureString(probe, font).Width <= maxWidth) return probe;
            }
            return "";
        }

        private static GraphicsPath RoundedRect(Rectangle r, int radius)
        {
            var path = new GraphicsPath();
            int d = Math.Max(2, radius * 2);
            if (d > r.Width) d = r.Width;
            if (d > r.Height) d = r.Height;
            path.AddArc(r.X, r.Y, d, d, 180, 90);
            path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        private static void FillRounded(Graphics g, Rectangle r, int radius, Brush brush)
        {
            if (r.Width <= 0 || r.Height <= 0) return;
            using (var path = RoundedRect(r, radius))
                g.FillPath(brush, path);
        }

        // ---------------------------------------------------------------- 分层窗口推送
        private void PushBitmap(Bitmap bmp, Point location)
        {
            IntPtr screenDc = GetDC(IntPtr.Zero);
            IntPtr memDc = CreateCompatibleDC(screenDc);
            IntPtr hBitmap = IntPtr.Zero;
            IntPtr oldBitmap = IntPtr.Zero;
            try
            {
                hBitmap = bmp.GetHbitmap(Color.FromArgb(0));
                oldBitmap = SelectObject(memDc, hBitmap);

                var size = new SIZE { cx = bmp.Width, cy = bmp.Height };
                var srcLoc = new POINT { X = 0, Y = 0 };
                var dstLoc = new POINT { X = location.X, Y = location.Y };
                var blend = new BLENDFUNCTION
                {
                    BlendOp = AC_SRC_OVER,
                    BlendFlags = 0,
                    SourceConstantAlpha = 255,
                    AlphaFormat = AC_SRC_ALPHA,
                };

                UpdateLayeredWindow(Handle, screenDc, ref dstLoc, ref size, memDc, ref srcLoc, 0, ref blend, ULW_ALPHA);
            }
            finally
            {
                if (oldBitmap != IntPtr.Zero) SelectObject(memDc, oldBitmap);
                if (hBitmap != IntPtr.Zero) DeleteObject(hBitmap);
                DeleteDC(memDc);
                ReleaseDC(IntPtr.Zero, screenDc);
            }
        }

        // ---------------------------------------------------------------- 鼠标
        protected override void OnMouseEnter(EventArgs e)
        {
            _hover = true;
            Repaint(true);
            base.OnMouseEnter(e);
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            _hover = false;
            Repaint(true);
            base.OnMouseLeave(e);
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left && e.Y <= _dragAreaHeight)
            {
                _dragging = true;
                _dragOrigin = new Point(e.X, e.Y);
                Capture = true;
            }
            base.OnMouseDown(e);
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            if (_dragging)
            {
                var screen = PointToScreen(new Point(e.X, e.Y));
                _bounds.X = screen.X - _dragOrigin.X;
                _bounds.Y = screen.Y - _dragOrigin.Y;
                Repaint(true);
            }
            base.OnMouseMove(e);
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            if (_dragging)
            {
                _dragging = false;
                Capture = false;
                LayoutWindowKeepingX();
            }
            base.OnMouseUp(e);
        }

        private void LayoutWindowKeepingX()
        {
            var wa = Screen.PrimaryScreen.WorkingArea;
            _bounds.Y = Math.Max(wa.Y, Math.Min(_bounds.Y, wa.Y + wa.Height - _bounds.Height));
            _bounds.X = Math.Max(wa.X - _bounds.Width + 80, Math.Min(_bounds.X, wa.X + wa.Width - 80));
            Repaint(true);
        }

        protected override void OnMouseClick(MouseEventArgs e)
        {
            if (_mini)
            {
                if (e.Button == MouseButtons.Right) { ShowMenu(); return; }
                // 点胶囊 = 展开。
                // 注意不能直接调 ToggleVisible：空闲自动收起时 _visible 已经是 true，
                // 再 toggle 一次会变成 false，反而更看不见。这里显式展开并给一个豁免期。
                _mini = false;
                _visible = true;
                _idleHidden = false;
                _manualShowUntil = DateTime.Now.AddMinutes(5);
                ApplyExStyles();
                LayoutWindow();
                Repaint(true);
                return;
            }
            if (e.Button == MouseButtons.Right)
            {
                ShowMenu();
            }
            else if (e.Button == MouseButtons.Left && e.Clicks == 2)
            {
                ToggleCompact();
            }
            base.OnMouseClick(e);
        }

        private void ShowMenu()
        {
            var menu = new ContextMenuStrip();
            menu.Items.Add(_visible ? "隐藏歌词（Ctrl+Alt+L）" : "显示歌词（Ctrl+Alt+L）", null, (s, e) => ToggleVisible());
            menu.Items.Add(_compact ? "展开双行模式（Ctrl+Alt+C）" : "切换单行模式（Ctrl+Alt+C）", null, (s, e) => ToggleCompact());
            menu.Items.Add(new ToolStripSeparator());

            var sizeMenu = new ToolStripMenuItem("字号");
            foreach (int size in new[] { 20, 23, 26, 30, 34 })
            {
                int captured = size;
                var item = new ToolStripMenuItem(size + " px", null, (s, e) => { _fontSize = captured; LayoutWindow(); Repaint(true); });
                item.Checked = _fontSize == size;
                sizeMenu.DropDownItems.Add(item);
            }
            menu.Items.Add(sizeMenu);

            menu.Items.Add("重新取词", null, (s, e) =>
            {
                try { Get("/api/lyrics?force=1"); } catch (Exception) { }
                Poll();
            });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出桌面歌词", null, (s, e) => Close());
            menu.Show(Cursor.Position);
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            _pollTimer.Stop();
            _paintTimer.Stop();
            if (_tray != null)
            {
                _tray.Visible = false;
                _tray.Dispose();
                _tray = null;
            }
            UnregisterHotKey(Handle, HOTKEY_TOGGLE);
            UnregisterHotKey(Handle, HOTKEY_COMPACT);
            UnregisterHotKey(Handle, HOTKEY_QUIT);
            base.OnFormClosed(e);
        }

        // ---------------------------------------------------------------- 数据模型
        internal sealed class Line
        {
            public double T;
            public string Text = "";
            public string Tr = "";
            public string Ro = "";
            public bool Credit;

            internal static List<Line> FromSnapshot(Dictionary<string, object> root)
            {
                var result = new List<Line>();
                object lyricsObj;
                if (!root.TryGetValue("lyrics", out lyricsObj) || lyricsObj == null) return result;
                var lyrics = lyricsObj as Dictionary<string, object>;
                if (lyrics == null) return result;

                object statusObj;
                lyrics.TryGetValue("status", out statusObj);
                if (Convert.ToString(statusObj) != "ok") return result;

                object linesObj;
                if (!lyrics.TryGetValue("lines", out linesObj) || linesObj == null) return result;
                // JavaScriptSerializer 会把数组反序列化成 ArrayList，不能直接当 object[] 用
                var arr = linesObj as System.Collections.IEnumerable;
                if (arr == null) return result;

                foreach (var item in arr)
                {
                    var d = item as Dictionary<string, object>;
                    if (d == null) continue;
                    var line = new Line();
                    object v;
                    if (d.TryGetValue("t", out v) && v != null) line.T = Convert.ToDouble(v, CultureInfo.InvariantCulture);
                    if (d.TryGetValue("text", out v) && v != null) line.Text = Convert.ToString(v);
                    if (d.TryGetValue("tr", out v) && v != null) line.Tr = Convert.ToString(v);
                    if (d.TryGetValue("ro", out v) && v != null) line.Ro = Convert.ToString(v);
                    if (d.TryGetValue("credit", out v) && v != null) line.Credit = Convert.ToBoolean(v);
                    if (!string.IsNullOrEmpty(line.Text) || !string.IsNullOrEmpty(line.Tr) || !string.IsNullOrEmpty(line.Ro))
                        result.Add(line);
                }
                return result;
            }
        }

        internal sealed class Snapshot
        {
            public string SongId = "";
            public string SongName = "";
            public string Artist = "";
            public bool Playing;
            public double Elapsed;
            public double Duration;
            public bool Connected;
            public double Stale = -1;      // 距上次上报的秒数
            public string Status = "";
            public string Msg = "";
            public string Origin = "";

            internal static Snapshot From(Dictionary<string, object> d)
            {
                var s = new Snapshot();
                object v;
                if (d.TryGetValue("songId", out v) && v != null) s.SongId = Convert.ToString(v);
                if (d.TryGetValue("songName", out v) && v != null) s.SongName = Convert.ToString(v);
                if (d.TryGetValue("artist", out v) && v != null) s.Artist = Convert.ToString(v);
                if (d.TryGetValue("playing", out v) && v != null) s.Playing = Convert.ToBoolean(v);
                if (d.TryGetValue("elapsed", out v) && v != null) s.Elapsed = Convert.ToDouble(v, CultureInfo.InvariantCulture);
                if (d.TryGetValue("duration", out v) && v != null) s.Duration = Convert.ToDouble(v, CultureInfo.InvariantCulture);
                if (d.TryGetValue("connected", out v) && v != null) s.Connected = Convert.ToBoolean(v);
                if (d.TryGetValue("stale", out v) && v != null)
                {
                    double ms = Convert.ToDouble(v, CultureInfo.InvariantCulture);
                    s.Stale = ms >= 0 && ms < 1e12 ? ms / 1000.0 : -1;
                }
                if (d.TryGetValue("lyrics", out v) && v != null)
                {
                    var ly = v as Dictionary<string, object>;
                    if (ly != null)
                    {
                        object x;
                        if (ly.TryGetValue("status", out x) && x != null) s.Status = Convert.ToString(x);
                        if (ly.TryGetValue("msg", out x) && x != null) s.Msg = Convert.ToString(x);
                        if (ly.TryGetValue("origin", out x) && x != null) s.Origin = Convert.ToString(x);
                    }
                }
                if (string.IsNullOrEmpty(s.Status)) s.Status = s.Connected ? "waiting" : "offline";
                return s;
            }
        }
    }
}
