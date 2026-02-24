$ErrorActionPreference = "Stop"

param(
  [string]$InstallDir = "",
  [string]$BinDir = "",
  [switch]$Local
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

if ([string]::IsNullOrWhiteSpace($InstallDir)) {
  if ($env:REM_INSTALL_DIR) {
    $InstallDir = $env:REM_INSTALL_DIR
  } else {
    $InstallDir = Join-Path $env:LOCALAPPDATA "Programs\rem"
  }
}

if ([string]::IsNullOrWhiteSpace($BinDir)) {
  if ($env:REM_BIN_DIR) {
    $BinDir = $env:REM_BIN_DIR
  } else {
    $BinDir = Join-Path $InstallDir "bin"
  }
}

if ($Local.IsPresent) {
  $userHome = if ($env:USERPROFILE) { $env:USERPROFILE } else { [Environment]::GetFolderPath("UserProfile") }
  $InstallDir = Join-Path $env:LOCALAPPDATA "Programs\rem"
  $BinDir = Join-Path $userHome ".local\bin"
}

$required = @(
  "rem.exe",
  "rem-api.exe",
  "ui-dist\index.html"
)
foreach ($requiredPath in $required) {
  $candidate = Join-Path $scriptDir $requiredPath
  if (-not (Test-Path $candidate)) {
    throw "Expected package file missing: $candidate"
  }
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

Copy-Item -Path (Join-Path $scriptDir "rem.exe") -Destination (Join-Path $InstallDir "rem.exe") -Force
Copy-Item -Path (Join-Path $scriptDir "rem-api.exe") -Destination (Join-Path $InstallDir "rem-api.exe") -Force

$uiDestination = Join-Path $InstallDir "ui-dist"
if (Test-Path $uiDestination) {
  Remove-Item -Path $uiDestination -Recurse -Force
}
Copy-Item -Path (Join-Path $scriptDir "ui-dist") -Destination $uiDestination -Recurse -Force

$versionPath = Join-Path $scriptDir "VERSION"
if (Test-Path $versionPath) {
  Copy-Item -Path $versionPath -Destination (Join-Path $InstallDir "VERSION") -Force
}

$readmePath = Join-Path $scriptDir "README.md"
if (Test-Path $readmePath) {
  Copy-Item -Path $readmePath -Destination (Join-Path $InstallDir "README.md") -Force
}

$launcherPath = Join-Path $BinDir "rem.cmd"
$launcher = @"
@echo off
set "REM_API_BINARY=$InstallDir\rem-api.exe"
set "REM_UI_DIST=$InstallDir\ui-dist"
if exist "$InstallDir\VERSION" set /p REM_VERSION=<"$InstallDir\VERSION"
"$InstallDir\rem.exe" %*
"@
Set-Content -Path $launcherPath -Value $launcher -Encoding Ascii

Write-Host "Installed rem:"
Write-Host "- install dir: $InstallDir"
Write-Host "- launcher: $launcherPath"
Write-Host ""
Write-Host "Run: $launcherPath app"
