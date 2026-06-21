# setup.ps1 - Balfen Admin Portal Auto-Deployment Script
# Run this script in PowerShell to deploy the Cloudflare Worker and configure secrets.

Write-Host "=============================================" -ForegroundColor Yellow
Write-Host "   BALFEN GROUP WORKER DEPLOYMENT HELPER" -ForegroundColor Yellow
Write-Host "=============================================" -ForegroundColor Yellow
Write-Host ""

# Step 1: Login to Cloudflare Wrangler
Write-Host "[1/5] Authenticating with Cloudflare..." -ForegroundColor Cyan
& npx wrangler login
if ($LASTEXITCODE -ne 0) {
    Write-Host "Cloudflare login failed or was cancelled." -ForegroundColor Red
    Exit
}

# Step 2: Prompt for secrets
Write-Host ""
Write-Host "[2/5] Collecting API credentials..." -ForegroundColor Cyan
$supabaseUrl = Read-Host "Enter your Supabase Project URL (e.g., https://xyz.supabase.co)"
$supabaseUrl = $supabaseUrl.Trim()

$supabaseKey = Read-Host "Enter your Supabase Service Role Key (secret)"
$supabaseKey = $supabaseKey.Trim()

$resendKey = Read-Host "Enter your Resend API Key (re_...)"
$resendKey = $resendKey.Trim()

if (-not $supabaseUrl -or -not $supabaseKey -or -not $resendKey) {
    Write-Host "All credentials are required to complete setup." -ForegroundColor Red
    Exit
}

# Step 3: Update wrangler.toml with Supabase URL
Write-Host ""
Write-Host "[3/5] Configuring wrangler.toml..." -ForegroundColor Cyan
$tomlPath = "worker/wrangler.toml"
if (Test-Path $tomlPath) {
    $content = Get-Content $tomlPath
    $updated = $content -replace 'SUPABASE_URL = ".*"', "SUPABASE_URL = `"$supabaseUrl`""
    $updated | Set-Content $tomlPath
    Write-Host "Updated wrangler.toml with Supabase URL." -ForegroundColor Green
} else {
    Write-Host "Could not find worker/wrangler.toml. Make sure you are in the project root." -ForegroundColor Red
    Exit
}

# Step 4: Deploy the Worker
Write-Host ""
Write-Host "[4/5] Deploying Cloudflare Worker..." -ForegroundColor Cyan
Set-Location worker
$deployOutput = & npx wrangler deploy 2>&1 | Out-String
Write-Host $deployOutput

# Extract worker domain/URL from output (look for workers.dev)
$workerUrl = ""
if ($deployOutput -match 'https://[a-zA-Z0-9\-\.]+\.workers\.dev') {
    $workerUrl = $Matches[0]
}

if (-not $workerUrl) {
    # Fallback to asking or warning
    Write-Host "Could not automatically determine the deployed Worker URL from output." -ForegroundColor Yellow
    $workerUrl = Read-Host "Enter the deployed Worker URL printed above (e.g., https://balfen-api.subdomain.workers.dev)"
    $workerUrl = $workerUrl.Trim()
}

if (-not $workerUrl) {
    Write-Host "Deployment failed or Worker URL not resolved." -ForegroundColor Red
    Set-Location ..
    Exit
}

# Step 5: Upload Secrets
Write-Host ""
Write-Host "[5/5] Uploading secure API credentials to Cloudflare..." -ForegroundColor Cyan

# Generate random JWT and Webhook secrets
$jwtSecret = [Guid]::NewGuid().ToString() + [Guid]::NewGuid().ToString()
$webhookSecret = [Guid]::NewGuid().ToString().Replace("-", "")

# Helper function to pipe secret into wrangler secret put
function Set-CloudflareSecret($name, $value) {
    Write-Host "Setting $name..."
    $value | & npx wrangler secret put $name
}

Set-CloudflareSecret "SUPABASE_SERVICE_ROLE_KEY" $supabaseKey
Set-CloudflareSecret "RESEND_API_KEY" $resendKey
Set-CloudflareSecret "JWT_SECRET" $jwtSecret
Set-CloudflareSecret "WEBHOOK_SECRET" $webhookSecret

Set-Location ..

Write-Host ""
Write-Host "=============================================" -ForegroundColor Green
Write-Host "          SETUP COMPLETE!" -ForegroundColor Green
Write-Host "=============================================" -ForegroundColor Green
Write-Host ""
Write-Host "1. Worker API URL: $workerUrl" -ForegroundColor Green
Write-Host "   -> Set this as the 'Cloudflare Worker URL' in the admin.html API Settings."
Write-Host ""
Write-Host "2. Resend Webhook URL: $workerUrl/api/inbound-webhook?secret=$webhookSecret" -ForegroundColor Green
Write-Host "   -> Add this as an Inbound Webhook in the Resend dashboard with event: email.received"
Write-Host ""
Write-Host "=============================================" -ForegroundColor Yellow
