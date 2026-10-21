@echo off
:: Closes the running AgentSphere AI and starts it again (e.g. after editing .env)
title AgentSphere AI - Restart
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\app-control.ps1" -Action restart
