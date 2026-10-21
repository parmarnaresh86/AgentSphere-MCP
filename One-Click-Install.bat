@echo off
:: AgentSphere AI - One-Click Installer
:: 1. Fill in .env (created from .env.example on first run)
:: 2. Run this file - it asks for Administrator rights by itself
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0one-click-install.ps1"
