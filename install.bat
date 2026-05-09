@echo off
echo WastedApe Remote Agent Installer
echo ==================================
echo.
echo Installing required components...
python --version >nul 2>&1
if errorlevel 1 (
    echo Python not found. Please install Python from python.org first.
    pause
    exit /b 1
)
pip install pyautogui python-socketio[client] screeninfo websocket-client pillow --quiet
echo.
echo Installation complete!
echo.
set /p CODE="Enter the session code from your technician: "
python agent.py %CODE%
pause
