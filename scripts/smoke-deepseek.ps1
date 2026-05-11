$ErrorActionPreference = "Stop"

if (-not $env:NVIDIA_API_KEY) {
  throw "Missing NVIDIA_API_KEY."
}

$headers = @{
  Authorization = "Bearer $env:NVIDIA_API_KEY"
  "Content-Type" = "application/json"
}

$body = @{
  model = "deepseek-ai/deepseek-v4-pro"
  messages = @(@{ role = "user"; content = "Reply with exactly OK." })
  temperature = 0
  max_tokens = 4
  stream = $false
} | ConvertTo-Json -Depth 10

$response = Invoke-RestMethod `
  -Uri "https://integrate.api.nvidia.com/v1/chat/completions" `
  -Method Post `
  -Headers $headers `
  -Body $body `
  -TimeoutSec 120

$response.choices[0].message.content
