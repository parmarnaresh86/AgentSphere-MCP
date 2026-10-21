@echo off
:: Builds releases\AgentSphere-Setup-<version>.exe - one setup file for customer servers
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-setup.ps1"
pause
