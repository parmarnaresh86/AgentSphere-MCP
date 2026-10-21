@echo off
:: Closes every running copy of AgentSphere AI (service and background processes)
title AgentSphere AI - Stop
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\app-control.ps1" -Action stop
