[CmdletBinding()]
param(
    [string]$OutputDirectory = "artifacts/sdk"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-NativeSuccess([string]$Description) {
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE."
    }
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$resolvedOutput = if ([System.IO.Path]::IsPathRooted($OutputDirectory)) {
    [System.IO.Path]::GetFullPath($OutputDirectory)
} else {
    [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot $OutputDirectory))
}
New-Item -ItemType Directory -Force -Path $resolvedOutput | Out-Null

Push-Location $repositoryRoot
try {
    python tools/generate_policy.py --check
    Assert-NativeSuccess "Policy generation check"
    python tests/validate_schema.py
    Assert-NativeSuccess "Schema validation"
    python tests/validate_docs.py
    Assert-NativeSuccess "SDK documentation validation"

    Push-Location typescript
    try {
        npm ci
        Assert-NativeSuccess "npm clean installation"
        npm test
        Assert-NativeSuccess "TypeScript SDK tests"
        npm pack --pack-destination $resolvedOutput
        Assert-NativeSuccess "npm SDK packaging"
    } finally {
        Pop-Location
    }

    $previousRollForward = $env:DOTNET_ROLL_FORWARD
    try {
        $env:DOTNET_ROLL_FORWARD = "Major"
        dotnet run --project dotnet/Pystone.Analytics.Tests/Pystone.Analytics.Tests.csproj -c Release
        Assert-NativeSuccess ".NET SDK tests"
        dotnet pack dotnet/Pystone.Analytics/Pystone.Analytics.csproj -c Release -o $resolvedOutput
        Assert-NativeSuccess "NuGet SDK packaging"
    } finally {
        $env:DOTNET_ROLL_FORWARD = $previousRollForward
    }

    $previousPythonPath = $env:PYTHONPATH
    try {
        $env:PYTHONPATH = (Resolve-Path python/src).Path
        python -m unittest discover -s python/tests -v
        Assert-NativeSuccess "Python SDK tests"
        python -m pip wheel ./python --no-deps --wheel-dir $resolvedOutput
        Assert-NativeSuccess "Python wheel packaging"
    } finally {
        $env:PYTHONPATH = $previousPythonPath
    }

    Get-ChildItem -LiteralPath $resolvedOutput -File |
        Sort-Object Name |
        Get-FileHash -Algorithm SHA256 |
        Select-Object Path, Hash

    & (Join-Path $repositoryRoot "tools/test-sdk-packages.ps1") -ArtifactDirectory $resolvedOutput
} finally {
    Pop-Location
}
