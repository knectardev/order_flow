@echo off
REM Serve orderflow_dashboard.html from repo root. Use IPv4 bind so
REM http://127.0.0.1:8000/ and http://localhost:8000/ work on Windows
REM (default "python -m http.server 8000" may only listen on [::]).
cd /d "%~dp0"
python -m http.server 8000 --bind 127.0.0.1
