$ErrorActionPreference = "Stop"

param(
  [string]$Version = ""
)

$rootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $rootDir

if ([string]::IsNullOrWhiteSpace($Version)) {
  $Version = (bun run scripts/semver-version.ts).Trim()
}
if ($Version -notmatch "^\d+\.\d+\.\d+$") {
  throw "Version must be semantic (MAJOR.MINOR.PATCH), got: $Version"
}

$archRaw = "$env:PROCESSOR_ARCHITECTURE".ToLowerInvariant()
switch ($archRaw) {
  "amd64" { $archLabel = "x64" }
  "x86_64" { $archLabel = "x64" }
  "arm64" { $archLabel = "arm64" }
  default { throw "Unsupported Windows architecture: $archRaw" }
}

$distRoot = Join-Path $rootDir "dist\windows"
$packageName = "rem-$Version-windows-$archLabel"
$packageDir = Join-Path $distRoot $packageName
$archivePath = Join-Path $distRoot "$packageName.zip"
$checksumPath = "$archivePath.sha256"

if (Test-Path $packageDir) {
  Remove-Item -Path $packageDir -Recurse -Force
}
New-Item -ItemType Directory -Path $packageDir -Force | Out-Null

bun run --cwd apps/ui build

bun build --compile --outfile "$packageDir\rem.exe" apps/cli/src/index.ts
bun build --compile --outfile "$packageDir\rem-api.exe" apps/api/src/index.ts

Copy-Item -Path "apps/ui/dist" -Destination (Join-Path $packageDir "ui-dist") -Recurse -Force
Copy-Item -Path "README.md" -Destination (Join-Path $packageDir "README.md") -Force
Copy-Item -Path "scripts/install-windows.ps1" -Destination (Join-Path $packageDir "install.ps1") -Force
Set-Content -Path (Join-Path $packageDir "VERSION") -Value "$Version" -NoNewline -Encoding Ascii

& (Join-Path $packageDir "rem.exe") --help | Out-Null

$apiLog = Join-Path $packageDir "rem-api-smoke.log"
$apiEnvironment = @{
  REM_API_PORT = "0"
  REM_UI_DIST = (Join-Path $packageDir "ui-dist")
}
$apiProcess = Start-Process -FilePath (Join-Path $packageDir "rem-api.exe") -RedirectStandardOutput $apiLog -RedirectStandardError $apiLog -PassThru -WindowStyle Hidden -Environment $apiEnvironment

Start-Sleep -Seconds 2
if ($apiProcess.HasExited) {
  if (Test-Path $apiLog) {
    Get-Content $apiLog | Write-Error
  }
  throw "rem-api smoke test failed to start"
}

Stop-Process -Id $apiProcess.Id -Force
Start-Sleep -Milliseconds 250
if (Test-Path $apiLog) {
  Remove-Item -Path $apiLog -Force
}

if (Test-Path $archivePath) {
  Remove-Item -Path $archivePath -Force
}
if (Test-Path $checksumPath) {
  Remove-Item -Path $checksumPath -Force
}

Compress-Archive -Path $packageDir -DestinationPath $archivePath -CompressionLevel Optimal

$digest = (Get-FileHash -Algorithm SHA256 -Path $archivePath).Hash.ToLowerInvariant()
$archiveLeaf = Split-Path -Path $archivePath -Leaf
Set-Content -Path $checksumPath -Value "$digest  $archiveLeaf" -Encoding Ascii

Write-Host "Created package:"
Write-Host "- $archivePath"
Write-Host "- $checksumPath"
