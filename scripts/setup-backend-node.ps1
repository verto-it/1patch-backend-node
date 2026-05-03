param(
  [Parameter(Mandatory = $true)][string]$ManagementUrl,
  [Parameter(Mandatory = $true)][string]$NodeId,
  [Parameter(Mandatory = $true)][string]$NodeEnrollmentToken,
  [Parameter(Mandatory = $true)][string]$NodePublicUrl,
  [Parameter(Mandatory = $true)][string]$DragonflyUrl,
  [Parameter(Mandatory = $false)][string]$CorsAllowedOrigins = "",
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
CORS_ALLOWED_ORIGINS=$CorsAllowedOrigins
# Written automatically by the node after first successful registration.
# Do not set manually.
NODE_DECOMMISSION_TOKEN_HASH=
"@ | Set-Content -Path ".env" -Encoding utf8

Write-Host ""
Write-Host "=== 1Patch Backend Node Setup Complete ===" -ForegroundColor Green
Write-Host ""
Write-Host "Wrote .env" -ForegroundColor Cyan
Write-Host "Node ID:         $NodeId"
Write-Host "Management URL:  $ManagementUrl"
Write-Host "Node public URL: $NodePublicUrl"
Write-Host "DragonflyDB:     $DragonflyUrl"
if ($CorsAllowedOrigins) {
  Write-Host "CORS Origins:    $CorsAllowedOrigins"
}
Write-Host ""
Write-Host "Authentication: mTLS only." -ForegroundColor Cyan
Write-Host "On first start the node will register with management using the enrollment token," -ForegroundColor Cyan
Write-Host "receive a Vault-issued mTLS certificate, and use it for all subsequent calls." -ForegroundColor Cyan
Write-Host "No shared secrets are required." -ForegroundColor Cyan
Write-Host ""

if ($RegisterNow) {
  Write-Host "Registering node with management server..." -ForegroundColor Cyan
  try {
    $body = @{
      nodeId          = $NodeId
      enrollmentToken = $NodeEnrollmentToken
      version         = "0.1.0"
      capacity        = @{ packageCache = "local" }
    } | ConvertTo-Json
    $result = Invoke-RestMethod -Method Post "$($ManagementUrl.TrimEnd('/'))/nodes/register" `
      -ContentType "application/json" `
      -Body $body
    Write-Host "Node registration accepted by management server." -ForegroundColor Green
    if ($result.tls) {
      Write-Host "mTLS certificate received — will be persisted to ./tls/ on first npm start." -ForegroundColor Green
    }
    if ($result.decommissionToken) {
      Write-Host "Per-node decommission token received — will be stored in .env on first npm start." -ForegroundColor Green
    }
  } catch {
    Write-Host "Registration failed — start the backend node and it will retry automatically." -ForegroundColor Yellow
    Write-Host $_.Exception.Message
  }
} else {
  Write-Host "Next: npm install && npm run build && npm start" -ForegroundColor Cyan
  Write-Host "The node will register with management automatically on first start."
}
