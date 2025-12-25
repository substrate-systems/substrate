#!/usr/bin/env pwsh
# Next.js dev server startup script with lock cleanup and process management
# Prevents stale .next/dev/lock errors and port hopping on Windows

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$LockFile = Join-Path $RepoRoot ".next\dev\lock"
$DevDir = Join-Path $RepoRoot ".next\dev"
$Port = 3000

Write-Host "🔧 Starting Next.js dev server..." -ForegroundColor Cyan

# Step 1: Find and kill any Next.js dev processes for THIS repo
Write-Host "🔍 Checking for existing Next.js dev processes..." -ForegroundColor Yellow

$RepoRootEscaped = [regex]::Escape($RepoRoot)
$NextDevProcesses = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
    $cmdLine = $_.CommandLine
    if ($cmdLine -match $RepoRootEscaped -and $cmdLine -match "next.*dev") {
        return $true
    }
    return $false
}

if ($NextDevProcesses) {
    Write-Host "⚠️  Found existing Next.js dev process(es) for this repo:" -ForegroundColor Yellow
    foreach ($proc in $NextDevProcesses) {
        Write-Host "   Killing PID $($proc.ProcessId): $($proc.CommandLine)" -ForegroundColor Gray
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 500
    Write-Host "✅ Cleaned up stale processes" -ForegroundColor Green
} else {
    Write-Host "✅ No stale processes found" -ForegroundColor Green
}

# Step 2: Remove stale lock file
if (Test-Path $LockFile) {
    Write-Host "⚠️  Found stale lock file, removing: .next\dev\lock" -ForegroundColor Yellow
    Remove-Item $LockFile -Force -ErrorAction SilentlyContinue
    Write-Host "✅ Removed stale lock file" -ForegroundColor Green
} else {
    Write-Host "✅ No stale lock file found" -ForegroundColor Green
}

# Step 3: Check if port 3000 is occupied by something else
$PortInUse = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($PortInUse) {
    $ProcessId = $PortInUse.OwningProcess
    $Process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    
    if ($Process) {
        $ProcessPath = $Process.Path
        $ProcessName = $Process.Name
        
        # Check if it's a node process in our repo (shouldn't happen after step 1, but defensive)
        if ($ProcessName -eq "node" -and $ProcessPath -match $RepoRootEscaped) {
            Write-Host "⚠️  Port $Port occupied by stale node process (PID $ProcessId), killing..." -ForegroundColor Yellow
            Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 500
            Write-Host "✅ Freed port $Port" -ForegroundColor Green
        } else {
            Write-Host "❌ ERROR: Port $Port is already in use by: $ProcessName (PID $ProcessId)" -ForegroundColor Red
            Write-Host "   Please free port $Port and try again." -ForegroundColor Red
            exit 1
        }
    }
}

# Step 4: Start Next.js dev server
Write-Host "🚀 Starting Next.js on port $Port..." -ForegroundColor Cyan
Write-Host ""

Set-Location $RepoRoot
& npm run dev:next -- --port $Port
