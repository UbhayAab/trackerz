# One-shot backend setup using PowerShell's native networking (no Node needed —
# the bundled Codex node is firewalled to GitHub only, which is why
# setup-backend.mjs failed with "fetch failed"). Invoke-RestMethod goes through
# the Windows network stack + your system proxy.
#
# Usage (set the env vars, then run):
#   $env:SUPABASE_ACCESS_TOKEN="sbp_..."   # personal access token (NOT the service key)
#   $env:GEMINI_API_KEY="AIza..."
#   $env:DEEPSEEK_API_KEY="sk-..."         # optional (Gemini reasoning fallback if absent)
#   # For NVIDIA-hosted DeepSeek instead: set NVIDIA_API_KEY + DEEPSEEK_BASE_URL + DEEPSEEK_MODEL
#   powershell -ExecutionPolicy Bypass -File scripts\setup-backend.ps1

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
try { [System.Net.WebRequest]::DefaultWebProxy.Credentials = [System.Net.CredentialCache]::DefaultCredentials } catch {}

$API = "https://api.supabase.com"
$TOKEN = $env:SUPABASE_ACCESS_TOKEN
$REF = if ($env:SUPABASE_PROJECT_REF) { $env:SUPABASE_PROJECT_REF } else { "qmlenovxatoyxxqlvzlo" }
$ROOT = Split-Path $PSScriptRoot -Parent

if (-not $TOKEN) {
  Write-Error "Set SUPABASE_ACCESS_TOKEN to a personal access token (sbp_..., https://supabase.com/dashboard/account/tokens). The sb_secret_ service key does NOT work here."
  exit 1
}
$headers = @{ Authorization = "Bearer $TOKEN"; "Content-Type" = "application/json" }

function Show-ApiError($ctx, $err) {
  $msg = $err.ErrorDetails.Message
  if (-not $msg) { $msg = $err.Exception.Message }
  Write-Host "  ! $ctx -> $msg" -ForegroundColor Yellow
}

function Invoke-Sql($label, $sql) {
  $body = @{ query = $sql } | ConvertTo-Json -Depth 3
  Invoke-RestMethod -Method Post -Uri "$API/v1/projects/$REF/database/query" -Headers $headers -Body $body | Out-Null
  Write-Host "  OK  $label" -ForegroundColor Green
}

Write-Host "Trackerz backend setup -> project $REF`n"

# 0. Verify the project ref exists in this account (settles qmle vs yyoe).
Write-Host "0. Verifying project $REF ..."
$projects = Invoke-RestMethod -Method Get -Uri "$API/v1/projects" -Headers $headers
foreach ($p in $projects) { Write-Host "   - $($p.id)  $($p.name)  [$($p.status)]" }
if (-not ($projects.id -contains $REF)) {
  Write-Error "Project ref '$REF' not in your account. Re-run with `$env:SUPABASE_PROJECT_REF set to one of the ids above (use the SAME one as src/config.js)."
  exit 1
}
Write-Host "  OK  $REF found" -ForegroundColor Green

# 1. Schema + migrations (idempotent).
Write-Host "1. Applying schema + migrations ..."
Invoke-Sql "schema.sql" (Get-Content -Raw "$ROOT\supabase\schema.sql")
Get-ChildItem "$ROOT\supabase\migrations\*.sql" | Sort-Object Name | ForEach-Object {
  Invoke-Sql "migration $($_.Name)" (Get-Content -Raw $_.FullName)
}

# 2. Store API keys / brain config into app_secrets.
Write-Host "2. Storing API keys ..."
$rows = @()
foreach ($name in @("GEMINI_API_KEY","DEEPSEEK_API_KEY","NVIDIA_API_KEY","DEEPSEEK_BASE_URL","DEEPSEEK_MODEL")) {
  $val = [Environment]::GetEnvironmentVariable($name)
  if ($val) { $esc = $val.Replace("'","''"); $rows += "('$name','$esc')" }
}
if ($rows.Count -gt 0) {
  $values = $rows -join ", "
  Invoke-Sql "app_secrets ($($rows.Count))" "insert into public.app_secrets (name,value) values $values on conflict (name) do update set value = excluded.value, updated_at = now();"
} else {
  Write-Host "  -   no keys provided (brain optional; Gemini may already be set)"
}

# 3. Deploy the agent edge function (best-effort over the Management API).
Write-Host "3. Deploying agent edge function ..."
$src = Get-Content -Raw "$ROOT\supabase\functions\agent\index.ts"
$deployed = $false
try {
  $body = @{ slug = "agent"; name = "agent"; verify_jwt = $true; body = $src } | ConvertTo-Json -Depth 3
  Invoke-RestMethod -Method Post -Uri "$API/v1/projects/$REF/functions?slug=agent" -Headers $headers -Body $body | Out-Null
  $deployed = $true
} catch {
  try {
    $body = @{ verify_jwt = $true; body = $src } | ConvertTo-Json -Depth 3
    Invoke-RestMethod -Method Patch -Uri "$API/v1/projects/$REF/functions/agent" -Headers $headers -Body $body | Out-Null
    $deployed = $true
  } catch { Show-ApiError "function deploy" $_ }
}
if ($deployed) {
  Write-Host "  OK  agent function deployed" -ForegroundColor Green
} else {
  Write-Host "  -   Management API would not accept the function bundle (common)." -ForegroundColor Yellow
  Write-Host "      FALLBACK: Studio -> Edge Functions -> agent -> paste supabase/functions/agent/index.ts -> Deploy."
}

Write-Host "`nDone. DB + keys are set$(if($deployed){' and the function is live'}else{'; do the one function paste above'})." -ForegroundColor Cyan
