[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ArtifactDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-NativeSuccess([string]$Description) {
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE."
    }
}

$artifactRoot = [System.IO.Path]::GetFullPath($ArtifactDirectory)
if (-not (Test-Path -LiteralPath $artifactRoot -PathType Container)) {
    throw "SDK artifact directory does not exist: $artifactRoot"
}

$npmPackage = Get-ChildItem -LiteralPath $artifactRoot -Filter "pystone-analytics-*.tgz" -File |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
$nugetPackage = Get-ChildItem -LiteralPath $artifactRoot -Filter "Pystone.Analytics.*.nupkg" -File |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
$pythonPackage = Get-ChildItem -LiteralPath $artifactRoot -Filter "pystone_analytics-*.whl" -File |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1

if (-not $npmPackage -or -not $nugetPackage -or -not $pythonPackage) {
    throw "Expected npm, NuGet and Python SDK artifacts in $artifactRoot"
}

$temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$smokeRoot = [System.IO.Path]::GetFullPath((Join-Path $temporaryRoot "pystone-sdk-smoke-$([Guid]::NewGuid().ToString('N'))"))
if (-not $smokeRoot.StartsWith($temporaryRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to use a smoke-test directory outside the system temporary directory."
}
New-Item -ItemType Directory -Path $smokeRoot | Out-Null

try {
    $npmDirectory = Join-Path $smokeRoot "npm"
    New-Item -ItemType Directory -Path $npmDirectory | Out-Null
    Push-Location $npmDirectory
    try {
        npm init --yes | Out-Null
        Assert-NativeSuccess "npm init"
        npm install --ignore-scripts --no-audit --no-fund $npmPackage.FullName | Out-Null
        Assert-NativeSuccess "npm package installation"
        node --input-type=module --eval @"
const nodeSdk = await import('@pystone/analytics/node');
const webSdk = await import('@pystone/analytics/web');
if (typeof nodeSdk.createNodeAnalytics !== 'function' || typeof webSdk.createWebAnalytics !== 'function') {
  throw new Error('npm package exports are incomplete');
}
"@
        Assert-NativeSuccess "npm package import"
    } finally {
        Pop-Location
    }

    $nugetVersion = $nugetPackage.BaseName.Substring("Pystone.Analytics.".Length)
    $dotnetDirectory = Join-Path $smokeRoot "dotnet"
    New-Item -ItemType Directory -Path $dotnetDirectory | Out-Null
    Push-Location $dotnetDirectory
    try {
        dotnet new console --force | Out-Null
        Assert-NativeSuccess "dotnet project creation"
        dotnet add package Pystone.Analytics --version $nugetVersion --source $artifactRoot | Out-Null
        Assert-NativeSuccess "NuGet package installation"
        [System.IO.File]::WriteAllText(
            (Join-Path $dotnetDirectory "Program.cs"),
            @"
using Pystone.Analytics;
var subject = AnalyticsIdentity.DeriveInstallationSubjectId("smoke-product", "installation");
if (subject.Length != 43) throw new InvalidOperationException("NuGet package API is unavailable.");
Console.WriteLine("NuGet SDK smoke test passed.");
"@)
        dotnet run --configuration Release
        Assert-NativeSuccess "NuGet consumer compilation"
    } finally {
        Pop-Location
    }

    $pythonDirectory = Join-Path $smokeRoot "python"
    python -m venv $pythonDirectory
    Assert-NativeSuccess "Python virtual environment creation"
    $pythonExecutable = if ($IsWindows) {
        Join-Path $pythonDirectory "Scripts/python.exe"
    } else {
        Join-Path $pythonDirectory "bin/python"
    }
    & $pythonExecutable -m pip install --disable-pip-version-check --no-deps $pythonPackage.FullName | Out-Null
    Assert-NativeSuccess "Python wheel installation"
    & $pythonExecutable -c @"
from pystone_analytics import derive_installation_subject_id
assert len(derive_installation_subject_id('smoke-product', 'installation')) == 43
print('Python SDK smoke test passed.')
"@
    Assert-NativeSuccess "Python wheel import"

    Write-Output "SDK package installation smoke tests passed."
} finally {
    $resolvedSmokeRoot = [System.IO.Path]::GetFullPath($smokeRoot)
    if ($resolvedSmokeRoot.StartsWith($temporaryRoot, [System.StringComparison]::OrdinalIgnoreCase) -and
        (Test-Path -LiteralPath $resolvedSmokeRoot)) {
        Remove-Item -LiteralPath $resolvedSmokeRoot -Recurse -Force
    }
}
