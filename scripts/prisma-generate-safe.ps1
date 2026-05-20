param(
  [int]$DevPort = 3000,
  [switch]$NoRestart
)

$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$NextOutLog = Join-Path $env:TEMP "walletbot-next-$DevPort.out.log"
$NextErrLog = Join-Path $env:TEMP "walletbot-next-$DevPort.err.log"
$WorkerOutLog = Join-Path $env:TEMP "walletbot-worker.out.log"
$WorkerErrLog = Join-Path $env:TEMP "walletbot-worker.err.log"

function Get-WalletbotNodeProcess {
  Get-CimInstance Win32_Process -Filter "name = 'node.exe'" |
    Where-Object {
      $_.CommandLine -like "*$ProjectRoot*" -and
      (
        $_.CommandLine -like "*next*dev*" -or
        $_.CommandLine -like "*next*start-server*" -or
        $_.CommandLine -like "*src/worker/index.ts*"
      ) -and
      $_.CommandLine -notlike "*OpenAI\Codex*"
    }
}

function Stop-WalletbotAppProcesses {
  $targets = @(Get-WalletbotNodeProcess)
  if ($targets.Count -eq 0) {
    Write-Host "No walletbot Next/worker Node processes to stop."
    return
  }

  Write-Host "Stopping walletbot Next/worker Node processes: $($targets.ProcessId -join ', ')"
  foreach ($process in $targets) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2
}

function Start-WalletbotAppProcesses {
  Remove-Item $NextOutLog, $NextErrLog, $WorkerOutLog, $WorkerErrLog -ErrorAction SilentlyContinue

  Write-Host "Starting Next dev server on http://127.0.0.1:$DevPort"
  Start-Process `
    -FilePath "pnpm.cmd" `
    -ArgumentList @("dev", "--hostname", "127.0.0.1", "--port", "$DevPort") `
    -WorkingDirectory $ProjectRoot `
    -RedirectStandardOutput $NextOutLog `
    -RedirectStandardError $NextErrLog `
    -WindowStyle Hidden

  Write-Host "Starting walletbot worker"
  Start-Process `
    -FilePath "pnpm.cmd" `
    -ArgumentList @("worker") `
    -WorkingDirectory $ProjectRoot `
    -RedirectStandardOutput $WorkerOutLog `
    -RedirectStandardError $WorkerErrLog `
    -WindowStyle Hidden

  for ($attempt = 0; $attempt -lt 45; $attempt++) {
    try {
      $response = Invoke-WebRequest -Uri "http://127.0.0.1:$DevPort/api/health" -UseBasicParsing -TimeoutSec 2
      if ($response.StatusCode -eq 200) {
        Write-Host "Next dev server is responding on http://127.0.0.1:$DevPort"
        break
      }
    } catch {
      Start-Sleep -Seconds 1
    }
  }

  Write-Host "Next logs: $NextOutLog / $NextErrLog"
  Write-Host "Worker logs: $WorkerOutLog / $WorkerErrLog"
}

Stop-WalletbotAppProcesses

Write-Host "Running Prisma generate"
& pnpm.cmd exec prisma generate

if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

if ($NoRestart) {
  Write-Host "Skipping app restart because -NoRestart was provided."
} else {
  Start-WalletbotAppProcesses
}
