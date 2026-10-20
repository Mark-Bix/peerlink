@echo off
rem PeerLink setup: downloads the latest setup script and runs it.
powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((Invoke-RestMethod https://raw.githubusercontent.com/Mark-Bix/peerlink/main/install/peerlink.ps1))) %*"
if errorlevel 1 pause
