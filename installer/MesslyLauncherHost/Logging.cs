using System.IO;
using System.Text;
using static HostConstants;

internal sealed class LineLogger : IDisposable
{
  private readonly StreamWriter _writer;
  private bool _disposed;

  public LineLogger(string logPath)
  {
    Directory.CreateDirectory(Path.GetDirectoryName(logPath) ?? ".");
    _writer = new StreamWriter(
      new FileStream(logPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite),
      Encoding.UTF8
    )
    {
      AutoFlush = true,
    };
  }

  public void Info(string message) => Write("INFO", message);
  public void Warn(string message) => Write("WARN", message);
  public void Error(string message) => Write("ERROR", message);

  private void Write(string level, string message)
  {
    var line = $"{DateTimeOffset.UtcNow:O} {LogPrefix} [{level}] {message}";
    _writer.WriteLine(line);
  }

  public void Dispose()
  {
    if (_disposed)
    {
      return;
    }
    _writer.Dispose();
    _disposed = true;
  }
}
