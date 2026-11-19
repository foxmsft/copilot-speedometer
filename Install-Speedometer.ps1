$ErrorActionPreference = 'Stop'
$name = 'copilot-speedometer'
$source = Join-Path $PSScriptRoot ".github\extensions\$name"
$copilotHome = if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { Join-Path $HOME '.copilot' }
$extensions = Join-Path $copilotHome 'extensions'
$destination = Join-Path $extensions $name
if (Test-Path -LiteralPath $destination) {
    throw "Installation already exists at '$destination'. Move it out of the extensions folder before reinstalling."
}

$null = [IO.Directory]::CreateDirectory($extensions)
$stage = Join-Path $copilotHome ".$name-$([guid]::NewGuid().ToString('N'))"
$null = [IO.Directory]::CreateDirectory($stage)
try {
    Get-ChildItem -LiteralPath $source -File | Copy-Item -Destination $stage
    [IO.Directory]::Move($stage, $destination)
} finally {
    if (Test-Path -LiteralPath $stage) {
        Get-ChildItem -LiteralPath $stage -File | Remove-Item
        Remove-Item -LiteralPath $stage
    }
}
Write-Output "Installed at '$destination'. Start a new Copilot session or reload extensions in an existing one."
