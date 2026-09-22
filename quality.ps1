$ErrorActionPreference = 'Continue'
$repo = 'C:\Users\dqtru\Documents\Projects\KHOHANG-IDOSI'
Set-Location $repo
$npm = 'C:\Program Files\nodejs\npm.cmd'
& $npm run quality 2>&1 | Tee-Object -FilePath (Join-Path $repo 'quality.log') | Select-Object -Last 60
Write-Output ('EXIT=' + $LASTEXITCODE)
