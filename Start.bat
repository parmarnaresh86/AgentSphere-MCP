@echo off
:: Closes any running copy of AgentSphere AI, then starts a fresh one (LAN enabled)
title AgentSphere AI - Start
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\app-control.ps1" -Action start
