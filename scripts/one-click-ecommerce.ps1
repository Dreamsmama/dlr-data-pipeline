param(
    [string]$ShopUrl,
    [switch]$Resume,
    [int]$MaxPages = 1,
    [int]$MaxProducts = 20,
    [int]$MaxImages = 40,
    [int]$WaitMs = 3500,
    [int]$TimeoutMs = 1800000,
    [int]$Port = 9333,
    [string]$ExportPath = "collectors/ecommerce/data/extension/latest.json",
    [string]$CatalogPath = "collectors/ecommerce/data/extension/catalog",
    [switch]$ManualWait,
    [switch]$SkipImages,
    [switch]$SkipImport,
    [switch]$Help
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $projectRoot

function Show-Usage {
    @"
Usage:
  pnpm collect:ecommerce:one-click -- -ShopUrl <https-url> [options]
  pnpm collect:ecommerce:one-click -- -Resume [options]

Options:
  -ShopUrl <url>          HTTPS Taobao/Tmall store or product URL
  -Resume                 Resume the unfinished extension task
  -MaxPages <n>           Listing pages (default: 1)
  -MaxProducts <n>        Products (default: 20)
  -MaxImages <n>          Images per product (default: 40)
  -WaitMs <n>             Page wait interval (default: 3500)
  -TimeoutMs <n>          Collection timeout (default: 1800000)
  -Port <n>               Chrome CDP port (default: 9333)
  -ExportPath <path>      Extension JSON output path
  -CatalogPath <path>     Standard catalog output directory
  -ManualWait             Pause for manual login/security verification
  -SkipImages             Do not download images during import
  -SkipImport             Stop after writing the extension JSON export
  -Help                   Show this help
"@ | Write-Host
}

if ($Help) {
    Show-Usage
    exit 0
}

if (-not $Resume -and [string]::IsNullOrWhiteSpace($ShopUrl)) {
    throw "ShopUrl is required unless -Resume is specified."
}

foreach ($value in @{
    MaxPages = @{ Value = $MaxPages; Minimum = 1; Maximum = 20 }
    MaxProducts = @{ Value = $MaxProducts; Minimum = 1; Maximum = 200 }
    MaxImages = @{ Value = $MaxImages; Minimum = 1; Maximum = 200 }
    WaitMs = @{ Value = $WaitMs; Minimum = 1000; Maximum = 60000 }
    TimeoutMs = @{ Value = $TimeoutMs; Minimum = 10000; Maximum = 86400000 }
    Port = @{ Value = $Port; Minimum = 1; Maximum = 65535 }
}.GetEnumerator()) {
    if ($value.Value.Value -lt $value.Value.Minimum -or $value.Value.Value -gt $value.Value.Maximum) {
        throw "$($value.Key) must be between $($value.Value.Minimum) and $($value.Value.Maximum)."
    }
}

if ($ShopUrl) {
    try {
        $parsedUrl = [Uri]$ShopUrl
    } catch {
        throw "ShopUrl must be a valid HTTPS Taobao or Tmall URL."
    }
    if ($parsedUrl.Scheme -ne "https" -or $parsedUrl.Host -notmatch "(^|\.)((taobao|tmall)\.com)$") {
        throw "ShopUrl must be an HTTPS Taobao or Tmall URL."
    }
}

function Invoke-Step {
    param(
        [string]$Name,
        [string]$Command,
        [string[]]$Arguments
    )

    Write-Host "`n==> $Name"
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Name failed with exit code $LASTEXITCODE."
    }
}

$exportAbsolutePath = if ([IO.Path]::IsPathRooted($ExportPath)) {
    [IO.Path]::GetFullPath($ExportPath)
} else {
    [IO.Path]::GetFullPath((Join-Path $projectRoot $ExportPath))
}
$catalogAbsolutePath = if ([IO.Path]::IsPathRooted($CatalogPath)) {
    [IO.Path]::GetFullPath($CatalogPath)
} else {
    [IO.Path]::GetFullPath((Join-Path $projectRoot $CatalogPath))
}
$exportParent = Split-Path -Parent $exportAbsolutePath
New-Item -ItemType Directory -Force -Path $exportParent | Out-Null

$startArguments = @(
    "--filter", "@dlr/ecommerce-collector", "extension:start",
    "--", "--port", $Port.ToString()
)
Invoke-Step "Start Chrome with the unpacked extension" "pnpm" $startArguments

$runArguments = @(
    "--filter", "@dlr/ecommerce-collector", "extension:run", "--",
    "--cdp-url", "http://127.0.0.1:$Port",
    "--max-pages", $MaxPages.ToString(),
    "--max-products", $MaxProducts.ToString(),
    "--max-images", $MaxImages.ToString(),
    "--wait-ms", $WaitMs.ToString(),
    "--timeout-ms", $TimeoutMs.ToString(),
    "--out", $exportAbsolutePath
)
if ($Resume) {
    $runArguments += "--resume"
} else {
    $runArguments += @("--shop-url", $ShopUrl)
}
if ($ManualWait) {
    $runArguments += "--manual-wait"
}
Invoke-Step "Collect through Playwright and the Chrome extension" "pnpm" $runArguments

if (-not $SkipImport) {
    $importArguments = @(
        "--filter", "@dlr/ecommerce-collector", "extension:import", "--",
        $exportAbsolutePath,
        "--out", $catalogAbsolutePath
    )
    if ($SkipImages) {
        $importArguments += "--skip-images"
    }
    Invoke-Step "Import the export into the standard catalog" "pnpm" $importArguments
}

Write-Host "`nOne-click collection completed."
Write-Host "Export: $exportAbsolutePath"
if (-not $SkipImport) {
    Write-Host "Catalog: $catalogAbsolutePath"
}
