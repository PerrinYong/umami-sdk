[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ArtifactDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot

function Assert-NativeSuccess([string]$Description) {
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE."
    }
}

$artifactRoot = [System.IO.Path]::GetFullPath($ArtifactDirectory)
if (-not (Test-Path -LiteralPath $artifactRoot -PathType Container)) {
    throw "SDK artifact directory does not exist: $artifactRoot"
}

$npmPackage = Get-ChildItem -LiteralPath $artifactRoot -Filter "perrin-yong-umami-sdk-*.tgz" -File |
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
const nodeSdk = await import('@perrin-yong/umami-sdk/node');
const webSdk = await import('@perrin-yong/umami-sdk/web');
if (typeof nodeSdk.createNodeAnalytics !== 'function' || typeof webSdk.createWebAnalytics !== 'function') {
  throw new Error('npm package exports are incomplete');
}
const common = {
  endpoint: 'https://umami.example.test',
  websiteId: '123e4567-e89b-42d3-a456-426614174000',
  hostname: 'consumer.example.test',
  product: 'consumer-product',
  environment: 'staging',
  surface: 'node',
  productVersion: '1.0.0',
  initialConsent: 'granted',
};
const batches = [];
const nodeClient = nodeSdk.createNodeAnalytics({
  ...common,
  userAgent: 'Consumer/1.0 PystoneAnalytics/0.1.1',
  flushIntervalMs: 60000,
  transport: { send: async requests => { batches.push(requests); return { kind: 'success' }; } },
});
if (!nodeClient.track('feature_used', { feature: 'smoke' }).accepted) {
  throw new Error('installed Node package rejected a valid event');
}
await nodeClient.flush();
await nodeClient.close();
if (batches.length !== 1) throw new Error('installed Node package did not send its queue');

const tracked = [];
const webClient = webSdk.createWebAnalytics({
  ...common,
  surface: 'web',
  tracker: {
    track: async (...args) => { tracked.push(args); },
    identify: async () => undefined,
  },
});
if (!webClient.track('feature_used', { feature: 'smoke' }).accepted) {
  throw new Error('installed Web package rejected a valid event');
}
await webClient.flush();
webClient.disable();
if (tracked.length !== 1) throw new Error('installed Web package did not invoke the tracker');
"@
        Assert-NativeSuccess "npm package runtime consumer"

        [System.IO.File]::WriteAllText(
            (Join-Path $npmDirectory "consumer.mts"),
            @"
import { createNodeAnalytics, type AnalyticsTransport } from '@perrin-yong/umami-sdk/node';
import { createWebAnalytics } from '@perrin-yong/umami-sdk/web';

const transport: AnalyticsTransport = { send: async () => ({ kind: 'success' }) };
const common = {
  endpoint: 'https://umami.example.test',
  websiteId: '123e4567-e89b-42d3-a456-426614174000',
  hostname: 'consumer.example.test',
  product: 'consumer-product',
  environment: 'staging',
  productVersion: '1.0.0',
  initialConsent: 'unknown' as const,
};
createNodeAnalytics({ ...common, surface: 'node', userAgent: 'Consumer/1.0', transport }).disable();
createWebAnalytics({ ...common, surface: 'web' }).disable();
"@)
        [System.IO.File]::WriteAllText(
            (Join-Path $npmDirectory "tsconfig.json"),
            '{"compilerOptions":{"target":"ES2022","module":"NodeNext","moduleResolution":"NodeNext","lib":["ES2022","DOM"],"strict":true,"skipLibCheck":false,"noEmit":true},"files":["consumer.mts"]}')
        $typescriptCompiler = Join-Path $repositoryRoot "typescript/node_modules/typescript/bin/tsc"
        node $typescriptCompiler --project (Join-Path $npmDirectory "tsconfig.json")
        Assert-NativeSuccess "npm declaration consumer compilation"
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
await using var client = new AnalyticsClient(new AnalyticsOptions
{
    Endpoint = new Uri("https://umami.example.test"),
    WebsiteId = Guid.Parse("123e4567-e89b-42d3-a456-426614174000"),
    Hostname = "consumer.example.test",
    Product = "consumer-product",
    Environment = "staging",
    Surface = "desktop",
    ProductVersion = "1.0.0",
    UserAgent = "Consumer/1.0 PystoneAnalytics/0.1.1",
});
if (client.Track("product_started").Code != "consent_not_granted")
    throw new InvalidOperationException("NuGet package consent default is unsafe.");
client.Disable();
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
from pystone_analytics import AnalyticsClient, AnalyticsConfig, derive_installation_subject_id
assert len(derive_installation_subject_id('smoke-product', 'installation')) == 43
client = AnalyticsClient(AnalyticsConfig(
    endpoint='https://umami.example.test',
    website_id='123e4567-e89b-42d3-a456-426614174000',
    hostname='consumer.example.test',
    product='consumer-product',
    environment='staging',
    surface='cli',
    product_version='1.0.0',
    user_agent='Consumer/1.0 PystoneAnalytics/0.1.1',
))
assert client.track('product_started').code == 'consent_not_granted'
client.disable()
client.close()
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
