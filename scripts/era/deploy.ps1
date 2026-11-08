<#
Build and install the Era fork on Windows x64 (Node and Cargo/MSVC required).
Run: pwsh scripts/era/deploy.ps1 [-InstallRoot C:\path\to\codegraph]
Writes directly to current/lib-era and replaces existing files.
CARGO_TARGET_DIR can place/cache Rust build output outside the repository.
#>
param(
    [string]$InstallRoot = "$env:LOCALAPPDATA\codegraph",
    [string]$NodePath = (Get-Command node.exe -CommandType Application).Source
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
Set-StrictMode -Version Latest
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$previousPath = $env:PATH
Push-Location $repo
try {
    $node = (Get-Item $NodePath).FullName
    & $node -e "const [major,minor]=process.versions.node.split('.').map(Number); if(major<22 || (major===22 && minor<13) || major>=25) { console.error('ERA deployment needs Node >=22.13 and <25; select it with -NodePath.'); process.exit(1); } require('node:sqlite');"
    # npm/npx and their child workers must use the same runtime we bundle.
    # This is process-local and is restored on every exit, not a system PATH edit.
    $env:PATH = "$(Split-Path $node -Parent);$previousPath"
    $package = Get-Content package.json -Raw | ConvertFrom-Json
    $version = "$($package.version)-era"
    $current = Join-Path ([IO.Path]::GetFullPath($InstallRoot)) 'current'
    $lib = Join-Path $current 'lib-era'

    npm ci
    npx tsc
    npm run copy-assets

    $targetDir = if ($env:CARGO_TARGET_DIR) {
        [IO.Path]::GetFullPath($env:CARGO_TARGET_DIR)
    } else { Join-Path $repo 'codegraph-kernel/target' }
    cargo build --manifest-path codegraph-kernel/Cargo.toml --locked --release --target x86_64-pc-windows-msvc --target-dir $targetDir
    $kernel = Join-Path $targetDir 'x86_64-pc-windows-msvc/release/codegraph_kernel.dll'

    New-Item -ItemType Directory -Path $lib -Force | Out-Null
    Copy-Item dist -Destination $lib -Recurse -Force
    Copy-Item package.json, package-lock.json -Destination $lib -Force
    Push-Location $lib
    try {
        npm ci --omit=dev --ignore-scripts
        Remove-Item package-lock.json
        $package.version = $version
        $package | ConvertTo-Json -Depth 100 | Set-Content package.json -Encoding utf8NoBOM
    } finally { Pop-Location }
    New-Item -ItemType Directory -Path (Join-Path $lib 'kernel') -Force | Out-Null
    Copy-Item $kernel (Join-Path $lib 'kernel/codegraph-kernel.node') -Force

    $bin = Join-Path $current 'bin'
    New-Item -ItemType Directory -Path $bin -Force | Out-Null
    Copy-Item $node (Join-Path $current 'node.exe') -Force
    $cmd = '@"%~dp0..\node.exe" --liftoff-only --disable-warning=ExperimentalWarning "%~dp0..\lib-era\dist\bin\codegraph.js" %*'
    [IO.File]::WriteAllText((Join-Path $bin 'codegraph.cmd'), $cmd + "`r`n", [Text.UTF8Encoding]::new($false))
    $sh = @'
#!/bin/sh
DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec "$DIR/node.exe" --liftoff-only --disable-warning=ExperimentalWarning "$DIR/lib-era/dist/bin/codegraph.js" "$@"
'@
    [IO.File]::WriteAllText((Join-Path $bin 'codegraph'), $sh.Replace("`r`n", "`n") + "`n", [Text.UTF8Encoding]::new($false))

    Write-Host "Installed: $current ($version)"
} finally {
    $env:PATH = $previousPath
    Pop-Location
}
