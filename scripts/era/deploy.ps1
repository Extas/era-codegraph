#requires -Version 7.3
<#
Build and install the Era fork on Windows x64 (Node 24, Cargo/MSVC required).
Run: pwsh scripts/era/deploy.ps1 [-InstallRoot C:\path\to\codegraph]
No viewer build, process termination, or old-lib removal. An existing stamped
lib is never overwritten; remove it only after its users have exited.
CARGO_TARGET_DIR can place/cache Rust build output outside the repository.
#>
param([string]$InstallRoot = "$env:LOCALAPPDATA\codegraph")

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
Set-StrictMode -Version Latest
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
Push-Location $repo
$stage = $null
try {
    if (-not $IsWindows) { throw 'This deployment requires Windows x64.' }
    $node = (Get-Command node.exe -CommandType Application).Source
    $runtime = & $node -p 'process.platform + "/" + process.arch + "/" + process.versions.node.split(".")[0]'
    if ($runtime -ne 'win32/x64/24') { throw "Expected Windows x64 Node 24; found $runtime" }
    if (git status --porcelain --untracked-files=no) { throw 'Commit first: the version stamp names HEAD.' }
    $sha = git rev-parse --short HEAD
    $package = Get-Content package.json -Raw | ConvertFrom-Json
    $version = "$($package.version)-era.$sha"
    $current = Join-Path ([IO.Path]::GetFullPath($InstallRoot)) 'current'
    $libName = "lib-$version"
    $lib = Join-Path $current $libName
    if (Test-Path $lib) { throw "Refusing to overwrite existing lib: $lib" }

    npm ci
    npx tsc
    npm run copy-assets

    $targetDir = if ($env:CARGO_TARGET_DIR) {
        [IO.Path]::GetFullPath($env:CARGO_TARGET_DIR)
    } else { Join-Path $repo 'codegraph-kernel/target' }
    $timer = [Diagnostics.Stopwatch]::StartNew()
    cargo build --manifest-path codegraph-kernel/Cargo.toml --locked --release --target x86_64-pc-windows-msvc --target-dir $targetDir
    $timer.Stop()
    $kernel = Get-Item (Join-Path $targetDir 'x86_64-pc-windows-msvc/release/codegraph_kernel.dll')
    Write-Host ('Kernel build: {0:F2}s; {1} bytes' -f $timer.Elapsed.TotalSeconds, $kernel.Length)

    $stage = Join-Path $current ('.stage-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    Copy-Item dist -Destination $stage -Recurse
    Copy-Item package.json, package-lock.json -Destination $stage
    Push-Location $stage
    try {
        npm ci --omit=dev --ignore-scripts
        Remove-Item package-lock.json
        $package.version = $version
        $package | ConvertTo-Json -Depth 100 | Set-Content package.json -Encoding utf8NoBOM
    } finally { Pop-Location }
    New-Item -ItemType Directory -Path (Join-Path $stage 'kernel') | Out-Null
    Copy-Item $kernel.FullName (Join-Path $stage 'kernel/codegraph-kernel.node')

    $bin = Join-Path $current 'bin'
    New-Item -ItemType Directory -Path $bin -Force | Out-Null
    if (-not (Test-Path (Join-Path $current 'node.exe'))) {
        Copy-Item $node (Join-Path $current 'node.exe')
    }
    Move-Item $stage $lib
    $stage = $null
    $cmd = '@"%~dp0..\node.exe" --liftoff-only --disable-warning=ExperimentalWarning "%~dp0..\' + $libName + '\dist\bin\codegraph.js" %*'
    [IO.File]::WriteAllText((Join-Path $bin 'codegraph.cmd'), $cmd + "`r`n", [Text.UTF8Encoding]::new($false))
    $sh = @'
#!/bin/sh
DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec "$DIR/node.exe" --liftoff-only --disable-warning=ExperimentalWarning "$DIR/__LIB__/dist/bin/codegraph.js" "$@"
'@
    [IO.File]::WriteAllText((Join-Path $bin 'codegraph'), $sh.Replace('__LIB__', $libName).Replace("`r`n", "`n") + "`n", [Text.UTF8Encoding]::new($false))

    Write-Host "Installed: $current"
    Write-Host "Version: $version"
    Write-Host "Kernel: $(Join-Path $lib 'kernel/codegraph-kernel.node') ($($kernel.Length) bytes)"
    Get-ChildItem $current -Directory | Where-Object {
        ($_.Name -eq 'lib' -or $_.Name -like 'lib-*') -and $_.Name -ne $libName
    } | ForEach-Object { Write-Host "Retained; clean only after its processes exit: $($_.FullName)" }
} finally {
    if ($stage -and (Test-Path $stage)) { Remove-Item $stage -Recurse -Force }
    Pop-Location
}
