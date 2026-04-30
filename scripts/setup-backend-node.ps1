param(
  [Parameter(Mandatory = $true)][string]$ManagementUrl,
  [Parameter(Mandatory = $true)][string]$NodeId,
  [Parameter(Mandatory = $true)][string]$NodeEnrollmentToken,
  [Parameter(Mandatory = $true)][string]$NodePublicUrl,
  [Parameter(Mandatory = $true)][string]$DragonflyUrl,
  [switch]$RegisterNow
)

$ErrorActionPreference = "Stop"

@"
PORT=4200
NODE_ID=$NodeId
NODE_ENROLLMENT_TOKEN=$NodeEnrollmentToken
NODE_PUBLIC_URL=$NodePublicUrl
MANAGEMENT_URL=$ManagementUrl
TENANT_ID=default
DRAGONFLY_URL=$DragonflyUrl
SIGNING_SECRET=$([Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)))
"@ | Set-Content -Path ".env" -Encoding utf8

Write-Host "Wrote .env"
Write-Host "Run: npm install && npm run build && npm start"
if ($RegisterNow) {
  try {
    Invoke-RestMethod -Method Post "$NodePublicUrl/node/register" | Out-Null
    Write-Host "Node registration requested."
  } catch {
    Write-Host "Could not register node now. Start the backend node and run: Invoke-RestMethod -Method Post $NodePublicUrl/node/register"
  }
} else {
  Write-Host "Then enroll the node: Invoke-RestMethod -Method Post $NodePublicUrl/node/register"
}
