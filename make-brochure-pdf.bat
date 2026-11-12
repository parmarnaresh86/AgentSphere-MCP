@echo off
REM Rebuilds public\AgentSphere-Brochure.pdf from http://localhost:3000/brochure.html
REM (the "Download PDF" button on the brochure page serves this file).
REM Run it after adding screenshots to public\assets\brochure\ - the server must be running.
setlocal
set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%BROWSER%" set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%BROWSER%" (
  echo Chrome or Edge not found - open http://localhost:3000/brochure.html and use Print ^> Save as PDF instead.
  exit /b 1
)
"%BROWSER%" --headless=new --disable-gpu --no-pdf-header-footer --virtual-time-budget=8000 --print-to-pdf="%~dp0public\AgentSphere-Brochure.pdf" "http://localhost:3000/brochure.html"
echo Brochure PDF written to public\AgentSphere-Brochure.pdf
endlocal
