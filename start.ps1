# AlphaDesk — Start both backend and frontend in one shot
# Usage: Right-click → Run with PowerShell, or: pwsh -File start.ps1

$root = $PSScriptRoot

Write-Host "Starting AlphaDesk backend (port 8000)..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root'; python -m uvicorn research:app --host 0.0.0.0 --port 8000 --reload"

Start-Sleep -Seconds 2

Write-Host "Starting AlphaDesk frontend (port 5173)..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\app'; npm run dev"

Write-Host ""
Write-Host "AlphaDesk running:" -ForegroundColor Green
Write-Host "  Frontend → http://localhost:5173" -ForegroundColor White
Write-Host "  Backend  → http://localhost:8000" -ForegroundColor White
