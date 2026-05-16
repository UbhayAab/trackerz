$ErrorActionPreference = "Stop"

if (-not $env:GEMINI_API_KEY) {
  throw "Missing GEMINI_API_KEY. Set it in your shell; do not commit it."
}

$body = @{
  contents = @(
    @{
      role = "user"
      parts = @(
        @{ text = "Reply with exactly OK." }
      )
    }
  )
  generationConfig = @{
    temperature = 0
    maxOutputTokens = 4
  }
} | ConvertTo-Json -Depth 10

$response = Invoke-RestMethod `
  -Uri "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent" `
  -Method Post `
  -Headers @{ "x-goog-api-key" = $env:GEMINI_API_KEY; "Content-Type" = "application/json" } `
  -Body $body `
  -TimeoutSec 120

$response.candidates[0].content.parts[0].text
