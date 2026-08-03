$directory = (Get-Location).Path

while ($directory) {
    $activationScript = Join-Path $directory ".venv\Scripts\Activate.ps1"

    if (Test-Path -LiteralPath $activationScript) {
        . $activationScript
        Write-Host "Activated Python environment: $directory\.venv"
        return
    }

    $parent = Split-Path -Parent $directory
    if ($parent -eq $directory) {
        break
    }
    $directory = $parent
}

Write-Error "No .venv was found in the current directory or its parents."
