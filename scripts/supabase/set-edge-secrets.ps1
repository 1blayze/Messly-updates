param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectRef,
  [string]$EnvPath = ".env",
  [switch]$IncludeOptional
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-EnvMap {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "Env file not found: $Path"
  }

  $map = @{}
  Get-Content -LiteralPath $Path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) {
      return
    }
    $idx = $line.IndexOf("=")
    if ($idx -lt 1) {
      return
    }
    $key = $line.Substring(0, $idx).Trim()
    $value = $line.Substring($idx + 1).Trim()
    if ($value.Length -gt 0) {
      $map[$key] = $value
    }
  }

  return $map
}

function Resolve-First {
  param(
    [hashtable]$Map,
    [string[]]$Candidates
  )
  foreach ($candidate in $Candidates) {
    if ($Map.ContainsKey($candidate) -and [string]::IsNullOrWhiteSpace($Map[$candidate]) -eq $false) {
      return [string]$Map[$candidate]
    }
  }
  return ""
}

function Get-ProjectRefFromUrl {
  param([string]$Url)
  if ([string]::IsNullOrWhiteSpace($Url)) {
    return ""
  }
  try {
    $uri = [Uri]$Url
    $host = $uri.Host
    if ($host -match "^([a-z0-9]{20})\.supabase\.co$") {
      return $Matches[1]
    }
  } catch {
    return ""
  }
  return ""
}

$envMap = Get-EnvMap -Path $EnvPath

# Required custom secrets for current Edge Functions (SUPABASE_* is managed by platform and cannot be set).
$resolved = [ordered]@{
  ALLOWED_ORIGINS            = Resolve-First $envMap @("ALLOWED_ORIGINS", "CORS_ALLOWED_ORIGINS")
  CORS_ALLOW_CREDENTIALS     = Resolve-First $envMap @("CORS_ALLOW_CREDENTIALS")
  ALLOW_ELECTRON_ORIGIN      = Resolve-First $envMap @("ALLOW_ELECTRON_ORIGIN")
  R2_ENDPOINT                = Resolve-First $envMap @("R2_ENDPOINT")
  R2_BUCKET                  = Resolve-First $envMap @("R2_BUCKET")
  R2_ACCESS_KEY_ID           = Resolve-First $envMap @("R2_ACCESS_KEY_ID")
  R2_SECRET_ACCESS_KEY       = Resolve-First $envMap @("R2_SECRET_ACCESS_KEY")
  R2_REGION                  = Resolve-First $envMap @("R2_REGION")
}

if ([string]::IsNullOrWhiteSpace($resolved.CORS_ALLOW_CREDENTIALS)) {
  $resolved.CORS_ALLOW_CREDENTIALS = "false"
}

if ([string]::IsNullOrWhiteSpace($resolved.ALLOW_ELECTRON_ORIGIN)) {
  $resolved.ALLOW_ELECTRON_ORIGIN = "false"
}

if ([string]::IsNullOrWhiteSpace($resolved.R2_REGION)) {
  $resolved.R2_REGION = "auto"
}

$optional = [ordered]@{
  SPOTIFY_CLIENT_ID          = Resolve-First $envMap @("SPOTIFY_CLIENT_ID", "VITE_SPOTIFY_CLIENT_ID")
  SPOTIFY_CLIENT_SECRET      = Resolve-First $envMap @("SPOTIFY_CLIENT_SECRET", "VITE_SPOTIFY_CLIENT_SECRET")
  SPOTIFY_REDIRECT_URI       = Resolve-First $envMap @("SPOTIFY_REDIRECT_URI", "VITE_SPOTIFY_REDIRECT_URI")
  UPSTASH_REDIS_REST_URL     = Resolve-First $envMap @("UPSTASH_REDIS_REST_URL")
  UPSTASH_REDIS_REST_TOKEN   = Resolve-First $envMap @("UPSTASH_REDIS_REST_TOKEN")
  IPINFO_TOKEN               = Resolve-First $envMap @("IPINFO_TOKEN")
  IPAPI_KEY                  = Resolve-First $envMap @("IPAPI_KEY")
}

$missingRequired = @()
foreach ($entry in $resolved.GetEnumerator()) {
  if ([string]::IsNullOrWhiteSpace([string]$entry.Value)) {
    $missingRequired += $entry.Key
  }
}

if ($missingRequired.Count -gt 0) {
  throw ("Missing required edge secrets in ${EnvPath}: $($missingRequired -join ', ')")
}

$supabaseUrlForSafetyCheck = Resolve-First $envMap @("SUPABASE_URL", "VITE_SUPABASE_URL")
$urlProjectRef = Get-ProjectRefFromUrl -Url $supabaseUrlForSafetyCheck
if (-not [string]::IsNullOrWhiteSpace($urlProjectRef) -and $urlProjectRef -ne $ProjectRef) {
  throw ("Project ref mismatch: SUPABASE_URL points to '$urlProjectRef', but command target is '$ProjectRef'. Aborting for safety.")
}

$lines = New-Object System.Collections.Generic.List[string]
foreach ($entry in $resolved.GetEnumerator()) {
  $lines.Add("$($entry.Key)=$($entry.Value)")
}

if ($IncludeOptional.IsPresent) {
  foreach ($entry in $optional.GetEnumerator()) {
    if (-not [string]::IsNullOrWhiteSpace([string]$entry.Value)) {
      $lines.Add("$($entry.Key)=$($entry.Value)")
    }
  }
}

$tmpFile = [System.IO.Path]::GetTempFileName()
try {
  Set-Content -LiteralPath $tmpFile -Value ($lines -join [Environment]::NewLine) -Encoding ASCII
  Write-Output "Applying $($lines.Count) edge secrets to project $ProjectRef..."
  & npx supabase secrets set --project-ref $ProjectRef --env-file $tmpFile
  if ($LASTEXITCODE -ne 0) {
    throw ("supabase secrets set failed with exit code $LASTEXITCODE")
  }
  Write-Output "Edge secrets applied successfully."
} finally {
  if (Test-Path -LiteralPath $tmpFile) {
    Remove-Item -LiteralPath $tmpFile -Force -ErrorAction SilentlyContinue
  }
}
