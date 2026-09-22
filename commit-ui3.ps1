$ErrorActionPreference = 'Continue'
$repo = 'C:\Users\dqtru\Documents\Projects\KHOHANG-IDOSI'
Set-Location $repo
[IO.Directory]::SetCurrentDirectory($repo)
Remove-Item -Force (Join-Path $repo 'ui3.b64'), (Join-Path $repo 'ui3.patch'), (Join-Path $repo 'apply-ui3.ps1'), (Join-Path $repo 'apply2.ps1'), (Join-Path $repo 'quality.log') -ErrorAction SilentlyContinue
$lines = @(
  'giao dien: gon dashboard, mo nhap kho tong cho HTKD, chuan hoa o chon ngay',
  '',
  '- Dashboard: bo dai nguon "Bao cao giao dich noi bo"; icon dong viec cho doi mau theo muc do,',
  '  so lieu lon hon; nut "Xem viec cho" dung mau chinh va chi rong bang noi dung.',
  '- HTKD: mo route /warehouse-inbound vi backend da cho phep vai tro nay; an o sua VAT cua phieu',
  '  da luu vi PATCH vat van chi danh cho ADMIN.',
  '- Ban hang IDOSI: bo the "Thuc te / quy doi", chi con khoi luong quy doi.',
  '- O chon ngay/thang: click bat ky dau cung mo lich, icon lich mau thuong hieu; ap dung cho ca',
  '  month, week va datetime-local.',
  '- Phan bo: bo cot "Chinh sach" va "Phien ban"; dich ma ly do sang tieng Viet va an ma mac dinh',
  '  ALLOCATED_BY_PRIORITY_ROUND_ROBIN vi trung nghia voi nhan trang thai.',
  '- Nut dang link co vien sang, nen rieng va rong vua noi dung.',
  '',
  'Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>',
  'Claude-Session: https://claude.ai/code/session_018Pc19AMgHND1Sfgz5dawBx'
)
$msg = [string]::Join("`n", $lines)
[IO.File]::WriteAllText((Join-Path $repo 'commitmsg.txt'), $msg, (New-Object Text.UTF8Encoding $false))
git add -A 2>&1 | Out-String | Write-Output
git commit -F commitmsg.txt 2>&1 | Out-String | Write-Output
git checkout main 2>&1 | Out-String | Write-Output
git merge --no-ff feat/dashboard-trim-htkd-inbound -m "Merge branch 'feat/dashboard-trim-htkd-inbound': gon dashboard va mo nhap kho tong cho HTKD" 2>&1 | Out-String | Write-Output
git push origin main 2>&1 | Out-String | Write-Output
Remove-Item -Force (Join-Path $repo 'commitmsg.txt') -ErrorAction SilentlyContinue
Write-Output '---HEAD---'
git rev-parse HEAD 2>&1 | Out-String | Write-Output
git status --porcelain 2>&1 | Out-String | Write-Output
