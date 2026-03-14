using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Shapes;
using System.Windows.Threading;
using System.Xml.Linq;

internal interface IInstallerProgressSink
{
  void Report(InstallerProgressState state);
}

internal readonly record struct InstallerProgressState(
  string StatusMessage,
  double? ProgressFraction,
  bool IsIndeterminate
);

internal sealed class InstallerUiHost : IInstallerProgressSink, IDisposable
{
  private readonly ManualResetEventSlim _readyEvent = new(false);
  private readonly Thread _uiThread;
  private Dispatcher? _dispatcher;
  private InstallerWindow? _window;
  private bool _disposed;

  public InstallerUiHost()
  {
    _uiThread = new Thread(RunUiThread)
    {
      IsBackground = true,
      Name = "MesslyInstallerUi",
    };
    _uiThread.SetApartmentState(ApartmentState.STA);
    _uiThread.Start();

    if (!_readyEvent.Wait(TimeSpan.FromSeconds(12)))
    {
      throw new InvalidOperationException("Failed to start installer UI thread.");
    }
  }

  public void Report(InstallerProgressState state)
  {
    var dispatcher = _dispatcher;
    if (dispatcher == null || dispatcher.HasShutdownStarted || dispatcher.HasShutdownFinished)
    {
      return;
    }

    _ = dispatcher.BeginInvoke(() =>
    {
      _window?.ApplyState(state);
    });
  }

  public void ShowFailure(string statusMessage)
  {
    Report(new InstallerProgressState(statusMessage, null, true));
  }

  public void Dispose()
  {
    if (_disposed)
    {
      return;
    }

    var dispatcher = _dispatcher;
    if (dispatcher != null && !dispatcher.HasShutdownStarted && !dispatcher.HasShutdownFinished)
    {
      try
      {
        dispatcher.Invoke(() =>
        {
          _window?.Close();
          _window = null;
        });
        dispatcher.BeginInvokeShutdown(DispatcherPriority.Background);
      }
      catch
      {
      }
    }

    if (_uiThread.IsAlive)
    {
      _uiThread.Join(TimeSpan.FromSeconds(2));
    }
    _readyEvent.Dispose();
    _disposed = true;
  }

  private void RunUiThread()
  {
    _dispatcher = Dispatcher.CurrentDispatcher;
    _window = new InstallerWindow();
    _window.Show();
    _readyEvent.Set();
    Dispatcher.Run();
  }
}

internal sealed class InstallerWindow : Window
{
  private readonly TextBlock _statusText;
  private readonly Border _progressTrack;
  private readonly Border _progressFill;
  private readonly DispatcherTimer _indeterminateTimer;
  private double _indeterminatePhase;

  public InstallerWindow()
  {
    Width = 356;
    Height = 338;
    MinWidth = 356;
    MinHeight = 338;
    MaxWidth = 356;
    MaxHeight = 338;
    WindowStartupLocation = WindowStartupLocation.CenterScreen;
    ResizeMode = ResizeMode.NoResize;
    WindowStyle = WindowStyle.None;
    AllowsTransparency = true;
    Background = Brushes.Transparent;
    Title = "Messly Setup";
    ShowInTaskbar = true;
    Topmost = true;
    PreviewMouseLeftButtonDown += OnPreviewMouseLeftButtonDown;

    var rootBorder = new Border
    {
      CornerRadius = new CornerRadius(6),
      BorderBrush = new SolidColorBrush(Color.FromRgb(48, 53, 60)),
      BorderThickness = new Thickness(1),
      Background = new SolidColorBrush(Color.FromRgb(22, 24, 29)),
      Padding = new Thickness(26, 28, 26, 26),
      ClipToBounds = true,
      SnapsToDevicePixels = true,
    };

    var layout = new StackPanel
    {
      VerticalAlignment = VerticalAlignment.Center,
      HorizontalAlignment = HorizontalAlignment.Center,
      Orientation = Orientation.Vertical,
    };

    layout.Children.Add(CreateLogoElement());
    layout.Children.Add(new TextBlock
    {
      Text = "MESSLY",
      FontSize = 17,
      FontWeight = FontWeights.SemiBold,
      Margin = new Thickness(0, 12, 0, 20),
      Foreground = new SolidColorBrush(Color.FromRgb(228, 231, 235)),
      HorizontalAlignment = HorizontalAlignment.Center,
      TextAlignment = TextAlignment.Center,
    });

    _statusText = new TextBlock
    {
      Text = "Installing Messly",
      FontSize = 14,
      FontWeight = FontWeights.Medium,
      Foreground = new SolidColorBrush(Color.FromRgb(193, 199, 208)),
      HorizontalAlignment = HorizontalAlignment.Center,
      TextAlignment = TextAlignment.Center,
      Margin = new Thickness(0, 0, 0, 16),
      Width = 258,
      TextWrapping = TextWrapping.Wrap,
    };
    layout.Children.Add(_statusText);

    var progressHost = new Grid
    {
      Width = 258,
      Height = 12,
      ClipToBounds = true,
      HorizontalAlignment = HorizontalAlignment.Center,
      VerticalAlignment = VerticalAlignment.Center,
    };

    _progressTrack = new Border
    {
      Width = 258,
      Height = 12,
      CornerRadius = new CornerRadius(6),
      Background = new SolidColorBrush(Color.FromRgb(96, 101, 109)),
      BorderBrush = new SolidColorBrush(Color.FromRgb(112, 117, 125)),
      BorderThickness = new Thickness(1),
    };
    progressHost.Children.Add(_progressTrack);

    _progressFill = new Border
    {
      Width = 0,
      Height = 12,
      CornerRadius = new CornerRadius(6),
      Background = new SolidColorBrush(Color.FromRgb(244, 246, 248)),
      HorizontalAlignment = HorizontalAlignment.Left,
      VerticalAlignment = VerticalAlignment.Center,
    };
    progressHost.Children.Add(_progressFill);
    layout.Children.Add(progressHost);

    _indeterminateTimer = new DispatcherTimer
    {
      Interval = TimeSpan.FromMilliseconds(30),
    };
    _indeterminateTimer.Tick += (_, _) => UpdateIndeterminateFrame();
    Loaded += (_, _) =>
    {
      ApplyRoundedClip(rootBorder);
      _indeterminateTimer.Start();
    };
    Closed += (_, _) => _indeterminateTimer.Stop();
    SizeChanged += (_, _) => ApplyRoundedClip(rootBorder);

    rootBorder.Child = layout;
    Content = rootBorder;
  }

  private static void ApplyRoundedClip(Border rootBorder)
  {
    if (rootBorder.ActualWidth <= 0 || rootBorder.ActualHeight <= 0)
    {
      return;
    }

    var radius = Math.Max(0, rootBorder.CornerRadius.TopLeft);
    rootBorder.Clip = new RectangleGeometry(
      new Rect(0, 0, rootBorder.ActualWidth, rootBorder.ActualHeight),
      radius,
      radius
    );
  }

  public void ApplyState(InstallerProgressState state)
  {
    _statusText.Text = string.IsNullOrWhiteSpace(state.StatusMessage)
      ? "Installing Messly"
      : state.StatusMessage;

    var normalizedProgress = state.ProgressFraction.HasValue
      ? Math.Clamp(state.ProgressFraction.Value, 0, 1)
      : 0;

    if (state.IsIndeterminate)
    {
      if (!_indeterminateTimer.IsEnabled)
      {
        _indeterminateTimer.Start();
      }
      UpdateIndeterminateFrame();
      return;
    }

    if (_indeterminateTimer.IsEnabled)
    {
      _indeterminateTimer.Stop();
    }
    _indeterminatePhase = 0;
    UpdateDeterminateProgress(normalizedProgress);
  }

  private static FrameworkElement CreateLogoElement()
  {
    var svgLogo = TryCreateSvgLogo();
    if (svgLogo != null)
    {
      return svgLogo;
    }

    var image = TryCreatePngLogo();
    if (image != null)
    {
      return image;
    }

    return new TextBlock
    {
      Text = "M",
      Foreground = Brushes.White,
      FontSize = 34,
      FontWeight = FontWeights.SemiBold,
      HorizontalAlignment = HorizontalAlignment.Center,
      VerticalAlignment = VerticalAlignment.Center,
      TextAlignment = TextAlignment.Center,
    };
  }

  private void OnPreviewMouseLeftButtonDown(object sender, MouseButtonEventArgs e)
  {
    if (e.ChangedButton != MouseButton.Left)
    {
      return;
    }

    try
    {
      DragMove();
      e.Handled = true;
    }
    catch
    {
    }
  }

  private double ResolveProgressWidth()
  {
    return _progressTrack.ActualWidth > 0 ? _progressTrack.ActualWidth : _progressTrack.Width;
  }

  private void UpdateDeterminateProgress(double progressFraction)
  {
    var totalWidth = ResolveProgressWidth();
    _progressFill.Margin = new Thickness(0);
    _progressFill.Width = Math.Clamp(progressFraction, 0, 1) * totalWidth;
  }

  private void UpdateIndeterminateFrame()
  {
    var totalWidth = ResolveProgressWidth();
    if (totalWidth <= 0)
    {
      return;
    }

    _indeterminatePhase += 0.03;
    if (_indeterminatePhase > 1.45)
    {
      _indeterminatePhase = 0;
    }

    var indicatorWidth = Math.Max(42, totalWidth * 0.27);
    var left = (_indeterminatePhase * (totalWidth + indicatorWidth)) - indicatorWidth;

    _progressFill.Width = indicatorWidth;
    _progressFill.Margin = new Thickness(left, 0, 0, 0);
  }

  private static FrameworkElement? TryCreatePngLogo()
  {
    try
    {
      var image = new Image
      {
        Width = 70,
        Height = 70,
        Stretch = Stretch.Uniform,
        HorizontalAlignment = HorizontalAlignment.Center,
        VerticalAlignment = VerticalAlignment.Center,
      };
      image.Source = new BitmapImage(new Uri("pack://application:,,,/Assets/messly-logo.png", UriKind.Absolute));
      return image;
    }
    catch
    {
      return null;
    }
  }

  private static FrameworkElement? TryCreateSvgLogo()
  {
    const string logoSvgResource = "pack://application:,,,/Assets/messly.svg";
    try
    {
      var resource = Application.GetResourceStream(new Uri(logoSvgResource, UriKind.Absolute));
      if (resource?.Stream == null)
      {
        return null;
      }

      using var stream = resource.Stream;
      var doc = XDocument.Load(stream, LoadOptions.None);
      var root = doc.Root;
      if (root == null)
      {
        return null;
      }

      var (viewBoxWidth, viewBoxHeight) = ParseSvgViewBox(root);
      var svgNamespace = root.Name.Namespace;
      var canvas = new Canvas
      {
        Width = viewBoxWidth,
        Height = viewBoxHeight,
      };

      foreach (var pathElement in root.Descendants(svgNamespace + "path"))
      {
        var data = pathElement.Attribute("d")?.Value;
        if (string.IsNullOrWhiteSpace(data))
        {
          continue;
        }

        Geometry geometry;
        try
        {
          geometry = Geometry.Parse(data);
        }
        catch
        {
          continue;
        }

        if (geometry is PathGeometry parsedPath)
        {
          var fillRule = pathElement.Attribute("fill-rule")?.Value;
          if (string.Equals(fillRule, "evenodd", StringComparison.OrdinalIgnoreCase))
          {
            parsedPath.FillRule = FillRule.EvenOdd;
          }
        }

        var brush = ParseSvgBrush(pathElement.Attribute("fill")?.Value) ?? Brushes.White;
        canvas.Children.Add(new System.Windows.Shapes.Path
        {
          Data = geometry,
          Fill = brush,
          Stretch = Stretch.None,
        });
      }

      if (canvas.Children.Count == 0)
      {
        return null;
      }

      return new Viewbox
      {
        Width = 84,
        Height = 68,
        Stretch = Stretch.Uniform,
        HorizontalAlignment = HorizontalAlignment.Center,
        VerticalAlignment = VerticalAlignment.Center,
        Child = canvas,
      };
    }
    catch
    {
      return null;
    }
  }

  private static (double Width, double Height) ParseSvgViewBox(XElement root)
  {
    var rawViewBox = root.Attribute("viewBox")?.Value;
    if (!string.IsNullOrWhiteSpace(rawViewBox))
    {
      var parts = rawViewBox
        .Split([' ', ','], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
      if (parts.Length == 4
        && double.TryParse(parts[2], out var width)
        && double.TryParse(parts[3], out var height)
        && width > 0
        && height > 0)
      {
        return (width, height);
      }
    }

    return (200, 160);
  }

  private static Brush? ParseSvgBrush(string? rawFill)
  {
    if (string.IsNullOrWhiteSpace(rawFill))
    {
      return null;
    }

    var normalizedFill = rawFill.Trim();
    if (string.Equals(normalizedFill, "none", StringComparison.OrdinalIgnoreCase))
    {
      return Brushes.Transparent;
    }

    try
    {
      var converter = new BrushConverter();
      if (converter.ConvertFromString(normalizedFill) is Brush convertedBrush)
      {
        return convertedBrush;
      }
    }
    catch
    {
    }

    return null;
  }
}
