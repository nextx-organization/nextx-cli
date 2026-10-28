# Installs the nextx CLI on Windows. Usage: irm https://developers.nextx.vn/install.ps1 | iex
$ErrorActionPreference = "Stop"
$Repo = "nextx-organization/nextx-cli"
$Bin = "nextx"
$Version = if ($env:NEXTX_VERSION) { $env:NEXTX_VERSION } else { "latest" }
$Dir = if ($env:NEXTX_INSTALL_DIR) { $env:NEXTX_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "$Bin\bin" }
$Base = if ($Version -eq "latest") { "https://github.com/$Repo/releases/latest/download" } else { "https://github.com/$Repo/releases/download/v$($Version.TrimStart('v'))" }
$Asset = "$Bin-windows-x64.zip"
$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid())
New-Item -ItemType Directory -Path $Tmp | Out-Null
try {
  Write-Host "Downloading $Asset..."
  Invoke-WebRequest "$Base/$Asset" -OutFile (Join-Path $Tmp $Asset) -UseBasicParsing
  Invoke-WebRequest "$Base/SHA256SUMS" -OutFile (Join-Path $Tmp "SHA256SUMS") -UseBasicParsing
  $Expected = (Get-Content (Join-Path $Tmp "SHA256SUMS") | Where-Object { $_ -match " $([regex]::Escape($Asset))$" }) -split " " | Select-Object -First 1
  $Actual = (Get-FileHash (Join-Path $Tmp $Asset) -Algorithm SHA256).Hash.ToLower()
  if (-not $Expected -or $Expected -ne $Actual) { throw "Checksum mismatch for $Asset" }
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  Expand-Archive (Join-Path $Tmp $Asset) -DestinationPath $Dir -Force
  $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (($UserPath -split ";") -notcontains $Dir) { [Environment]::SetEnvironmentVariable("Path", "$UserPath;$Dir", "User"); Write-Host "Added $Dir to your PATH (open a new terminal)." }
  Write-Host "Installed $Bin to $Dir. Next: $Bin login"
} finally { Remove-Item -Recurse -Force $Tmp }
