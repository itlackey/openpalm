# Install the checksum-verified OpenPalm CLI, then install the lean stack.
$PreviousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = 'Stop'

try {
    try {
        [Net.ServicePointManager]::SecurityProtocol =
            [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    } catch {}

    $Version = $env:OP_VERSION
    $CliOnly = $false
    $Passthrough = @()
    for ($Index = 0; $Index -lt $args.Count; $Index++) {
        $Argument = $args[$Index]
        if ($Argument -eq '--version') {
            if ($Index + 1 -ge $args.Count) { throw '--version requires a value' }
            $Version = $args[$Index + 1]
            $Index++
        } elseif ($Argument.StartsWith('--version=')) {
            $Version = $Argument.Substring('--version='.Length)
        } elseif ($Argument -eq '--cli-only') {
            $CliOnly = $true
        } else {
            $Passthrough += $Argument
        }
    }

    if ($Version -and $Version.StartsWith('v')) { $Version = $Version.Substring(1) }
    if (-not $Version) {
        $Response = Invoke-WebRequest -Uri 'https://github.com/itlackey/openpalm/releases/latest' -UseBasicParsing
        $LatestUri = if ($Response.BaseResponse.ResponseUri) {
            $Response.BaseResponse.ResponseUri.AbsoluteUri
        } else {
            $Response.BaseResponse.RequestMessage.RequestUri.AbsoluteUri
        }
        if ($LatestUri -notmatch '/releases/tag/([^/?#]+)') {
            throw 'Could not resolve the latest OpenPalm release'
        }
        $Version = $Matches[1]
        if ($Version.StartsWith('v')) { $Version = $Version.Substring(1) }
    }
    if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$') {
        throw "Invalid release version: $Version"
    }

    $Architecture = if ($env:PROCESSOR_ARCHITEW6432) {
        $env:PROCESSOR_ARCHITEW6432
    } else {
        $env:PROCESSOR_ARCHITECTURE
    }
    if ($Architecture -notmatch '^(AMD64|x64|ARM64|arm64)$') {
        throw "Unsupported Windows architecture: $Architecture"
    }
    $Binary = 'openpalm-cli-windows-x64.exe'

    $InstallDir = if ($env:OP_INSTALL_DIR) {
        $env:OP_INSTALL_DIR
    } else {
        Join-Path $env:LOCALAPPDATA 'openpalm\bin'
    }
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $Destination = Join-Path $InstallDir 'openpalm.exe'
    $Temporary = "$Destination.tmp.$([guid]::NewGuid().ToString('N'))"
    $ChecksumFile = "$Destination.sha256.$([guid]::NewGuid().ToString('N'))"
    $ReleaseUrl = "https://github.com/itlackey/openpalm/releases/download/$Version"

    try {
        Write-Host "Downloading OpenPalm $Version..."
        Invoke-WebRequest -Uri "$ReleaseUrl/$Binary" -OutFile $Temporary -UseBasicParsing
        Invoke-WebRequest -Uri "$ReleaseUrl/checksums-sha256.txt" -OutFile $ChecksumFile -UseBasicParsing
        $ChecksumLine = Get-Content $ChecksumFile |
            Where-Object { $_ -match "\s\*?$([regex]::Escape($Binary))$" } |
            Select-Object -First 1
        if (-not $ChecksumLine) { throw "Release checksums do not contain $Binary" }
        $Expected = ($ChecksumLine -split '\s+')[0]
        if ($Expected -notmatch '^[0-9a-fA-F]{64}$') { throw 'Invalid release checksum' }
        $Actual = (Get-FileHash -Algorithm SHA256 -Path $Temporary).Hash
        if ($Actual -ine $Expected) { throw "Checksum mismatch for $Binary" }
        Move-Item -Force $Temporary $Destination
    } finally {
        Remove-Item -Force $Temporary -ErrorAction SilentlyContinue
        Remove-Item -Force $ChecksumFile -ErrorAction SilentlyContinue
    }

    Write-Host "Installed $Destination" -ForegroundColor Green
    if (($env:PATH -split ';') -notcontains $InstallDir) {
        Write-Host "Add $InstallDir to PATH." -ForegroundColor Yellow
    }
    if (-not $CliOnly) {
        & $Destination install @Passthrough
        if ($LASTEXITCODE -ne 0) {
            throw "openpalm install failed with exit code $LASTEXITCODE"
        }
    }
} finally {
    $ErrorActionPreference = $PreviousErrorActionPreference
}
