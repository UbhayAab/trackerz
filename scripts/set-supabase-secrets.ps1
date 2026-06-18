param(
  [string]$ProjectRef = "qmlenovxatoyxxqlvzlo"
)

$ErrorActionPreference = "Stop"

if (-not $env:SUPABASE_ACCESS_TOKEN) {
  throw "Missing SUPABASE_ACCESS_TOKEN. This must be a Supabase personal access token with secrets:write permission."
}

$secrets = @()

if ($env:NVIDIA_API_KEY) {
  $secrets += @{ name = "NVIDIA_API_KEY"; value = $env:NVIDIA_API_KEY }
}

if ($env:GEMINI_API_KEY) {
  $secrets += @{ name = "GEMINI_API_KEY"; value = $env:GEMINI_API_KEY }
}

# The AI "brain" (reasoning -> tool calls) runs on DeepSeek; Gemini handles
# image/voice extraction. Both keys are read by the edge function.
if ($env:DEEPSEEK_API_KEY) {
  $secrets += @{ name = "DEEPSEEK_API_KEY"; value = $env:DEEPSEEK_API_KEY }
}

if ($env:SB_SECRET_KEY) {
  $secrets += @{ name = "SB_SECRET_KEY"; value = $env:SB_SECRET_KEY }
}

if ($secrets.Count -eq 0) {
  throw "No secrets found. Set GEMINI_API_KEY, DEEPSEEK_API_KEY, NVIDIA_API_KEY, or SB_SECRET_KEY in the environment first."
}

$headers = @{
  Authorization = "Bearer $env:SUPABASE_ACCESS_TOKEN"
  "Content-Type" = "application/json"
}

$body = $secrets | ConvertTo-Json -Depth 5
$uri = "https://api.supabase.com/v1/projects/$ProjectRef/secrets"

Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -Body $body | Out-Null
Write-Output "Pushed $($secrets.Count) secret(s) to Supabase project $ProjectRef."
Write-Output "Never commit these keys. They should only live in Supabase secrets or local environment variables."
