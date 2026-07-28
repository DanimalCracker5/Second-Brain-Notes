param(
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"

$port = 4173
$baseUrl = "http://localhost:$port/"
$root = [IO.Path]::GetFullPath($PSScriptRoot)
$listener = [Net.HttpListener]::new()
$listener.Prefixes.Add($baseUrl)

try {
  $listener.Start()
} catch {
  Write-Host "Second Brain may already be running at $baseUrl"
  if (-not $NoBrowser) { Start-Process $baseUrl }
  exit 0
}

Write-Host "Second Brain is running at $baseUrl"
Write-Host "Keep this window open. Press Ctrl+C to stop."
if (-not $NoBrowser) { Start-Process $baseUrl }

$mimeTypes = @{
  ".html" = "text/html; charset=utf-8"
  ".js"   = "text/javascript; charset=utf-8"
  ".css"  = "text/css; charset=utf-8"
  ".json" = "application/json; charset=utf-8"
  ".svg"  = "image/svg+xml"
  ".png"  = "image/png"
  ".ico"  = "image/x-icon"
}

try {
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    try {
      $relativePath = [Uri]::UnescapeDataString($context.Request.Url.AbsolutePath.TrimStart("/"))
      if ([string]::IsNullOrWhiteSpace($relativePath)) { $relativePath = "index.html" }
      $filePath = [IO.Path]::GetFullPath((Join-Path $root $relativePath))
      $insideRoot = $filePath.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)

      if (-not $insideRoot -or -not [IO.File]::Exists($filePath)) {
        $context.Response.StatusCode = 404
      } else {
        $extension = [IO.Path]::GetExtension($filePath).ToLowerInvariant()
        $context.Response.ContentType = if ($mimeTypes.ContainsKey($extension)) { $mimeTypes[$extension] } else { "application/octet-stream" }
        $context.Response.Headers["Cache-Control"] = "no-store"
        $bytes = [IO.File]::ReadAllBytes($filePath)
        $context.Response.ContentLength64 = $bytes.Length
        $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
      }
    } catch {
      $context.Response.StatusCode = 500
    } finally {
      $context.Response.OutputStream.Close()
    }
  }
} finally {
  $listener.Stop()
  $listener.Close()
}
