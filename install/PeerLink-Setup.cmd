@echo off
rem PeerLink setup: downloads the latest setup script and runs it.
rem The script is read as UTF-8 bytes: Windows PowerShell 5.1 would otherwise
rem misread the BOM and the accented letters.
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; $bytes = (New-Object Net.WebClient).DownloadData('https://raw.githubusercontent.com/Mark-Bix/peerlink/main/install/peerlink.ps1'); $text = [Text.Encoding]::UTF8.GetString($bytes).TrimStart([char]0xFEFF); & ([scriptblock]::Create($text)) %*"
if errorlevel 1 pause
