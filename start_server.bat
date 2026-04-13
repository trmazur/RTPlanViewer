@echo off
echo ============================================
echo   RT Plan Blinded Review - Starting Server
echo ============================================
echo.
echo Starting local web server on port 8080...
echo Open your browser to: http://localhost:8080
echo.
echo Press Ctrl+C to stop the server.
echo.
python "%~dp0serve.py" 8080
pause
