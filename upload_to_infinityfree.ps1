<#
.SYNOPSIS
    Automated InfinityFree FTP Uploader for CALJAN Prediction Intelligence
.DESCRIPTION
    Uploads all project files directly to InfinityFree htdocs/ using FTP.
    Bypasses filemanager.ai web browser timeouts and JSON errors.
#>

param(
    [string]$FtpUser,
    [string]$FtpPass
)

$ErrorActionPreference = "Stop"
$HostName = "ftpupload.net"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  CALJAN -> InfinityFree Automated FTP Uploader           " -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""

if ([string]::IsNullOrWhiteSpace($FtpUser)) {
    $FtpUser = Read-Host "Enter your InfinityFree FTP Username (e.g. if0_38492041)"
}

if ([string]::IsNullOrWhiteSpace($FtpPass)) {
    $securePass = Read-Host "Enter your InfinityFree Account Password" -AsSecureString
    $FtpPass = [System.Net.NetworkCredential]::new("", $securePass).Password
}

$localBase = Join-Path $PSScriptRoot "infinityfree_upload"
if (-not (Test-Path $localBase)) {
    Write-Host "Error: Could not find folder '$localBase'!" -ForegroundColor Red
    exit 1
}

$credentials = New-Object System.Net.NetworkCredential($FtpUser, $FtpPass)

function Create-FtpDirectory {
    param([string]$remoteDir)
    try {
        $uri = "ftp://$HostName/htdocs/$remoteDir"
        $request = [System.Net.FtpWebRequest]::Create($uri)
        $request.Credentials = $credentials
        $request.Method = [System.Net.WebRequestMethods+Ftp]::MakeDirectory
        $request.UseBinary = $true
        $request.KeepAlive = $false
        $response = $request.GetResponse()
        $response.Close()
        Write-Host "  [DIR] Created: htdocs/$remoteDir" -ForegroundColor Yellow
    } catch {
        # Directory already exists or server ignored
    }
}

function Upload-FtpFile {
    param(
        [string]$localPath,
        [string]$remoteRelPath
    )
    $uri = "ftp://$HostName/htdocs/$remoteRelPath"
    Write-Host "  [UPLOADING] $remoteRelPath ... " -NoNewline
    try {
        $request = [System.Net.FtpWebRequest]::Create($uri)
        $request.Credentials = $credentials
        $request.Method = [System.Net.WebRequestMethods+Ftp]::UploadFile
        $request.UseBinary = $true
        $request.KeepAlive = $false

        $fileBytes = [System.IO.File]::ReadAllBytes($localPath)
        $request.ContentLength = $fileBytes.Length

        $stream = $request.GetRequestStream()
        $stream.Write($fileBytes, 0, $fileBytes.Length)
        $stream.Close()

        $response = $request.GetResponse()
        $response.Close()
        Write-Host "OK" -ForegroundColor Green
    } catch {
        Write-Host "FAILED: $($_.Exception.Message)" -ForegroundColor Red
    }
}

Write-Host "`nConnecting to $HostName and uploading files to /htdocs/ ...`n" -ForegroundColor Cyan

# Create subdirectories on remote
Create-FtpDirectory -remoteDir "api"
Create-FtpDirectory -remoteDir "database"

# Upload all files
$files = Get-ChildItem -Path $localBase -Recurse -File -Force
foreach ($file in $files) {
    $rel = $file.FullName.Substring($localBase.Length + 1).Replace("\", "/")
    Upload-FtpFile -localPath $file.FullName -remoteRelPath $rel
}

Write-Host "`n==========================================================" -ForegroundColor Cyan
Write-Host "  Upload to InfinityFree Completed!                       " -ForegroundColor Green
Write-Host "  Your site is live on your InfinityFree domain!          " -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Cyan
