"""
WastedApe Remote Agent
Connects to the WastedApe signaling server and allows remote control.
Run: python agent.py SESSION_CODE
"""

import sys
import json
import time
import threading
import tkinter as tk
from tkinter import messagebox

try:
    import pyautogui
    import socketio
    import screeninfo
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "pyautogui", "python-socketio[client]", "screeninfo", "websocket-client", "pillow"])
    import pyautogui
    import socketio
    import screeninfo

pyautogui.FAILSAFE = False
pyautogui.PAUSE = 0.01

REMOTE_API = "https://wastedape-remote-api.onrender.com"

sio = socketio.Client()
code = sys.argv[1] if len(sys.argv) > 1 else None

def get_screen_size():
    try:
        monitors = screeninfo.get_monitors()
        m = monitors[0]
        return m.width, m.height
    except:
        return pyautogui.size()

screen_w, screen_h = get_screen_size()

@sio.event
def connect():
    print(f"Connected to WastedApe server")
    sio.emit('agent:join', {'code': code})

@sio.event
def disconnect():
    print("Disconnected")

@sio.on('control')
def on_control(data):
    try:
        execute(data)
    except Exception as e:
        print(f"Control error: {e}")

@sio.on('session:ended')
def on_ended(data):
    print("Session ended by host")
    sio.disconnect()
    sys.exit(0)

@sio.on('error')
def on_error(msg):
    print(f"Error: {msg}")

def execute(cmd):
    t = cmd.get('type')
    
    if t == 'mousemove':
        x = int(cmd['x'] * screen_w)
        y = int(cmd['y'] * screen_h)
        pyautogui.moveTo(x, y, duration=0.05)
    
    elif t == 'click':
        x = int(cmd['x'] * screen_w)
        y = int(cmd['y'] * screen_h)
        btn = 'right' if cmd.get('button') == 2 else 'left'
        pyautogui.click(x, y, button=btn)
    
    elif t == 'dblclick':
        x = int(cmd['x'] * screen_w)
        y = int(cmd['y'] * screen_h)
        pyautogui.doubleClick(x, y)
    
    elif t == 'scroll':
        clicks = -int(cmd.get('deltaY', 0) / 100)
        pyautogui.scroll(clicks)
    
    elif t == 'keydown':
        key = cmd.get('key', '')
        ctrl = cmd.get('ctrlKey', False)
        shift = cmd.get('shiftKey', False)
        alt = cmd.get('altKey', False)
        
        # Build hotkey combo
        mods = []
        if ctrl: mods.append('ctrl')
        if shift: mods.append('shift')
        if alt: mods.append('alt')
        
        # Map special keys
        key_map = {
            'Backspace': 'backspace', 'Enter': 'enter', 'Tab': 'tab',
            'Escape': 'esc', 'Delete': 'delete', 'ArrowUp': 'up',
            'ArrowDown': 'down', 'ArrowLeft': 'left', 'ArrowRight': 'right',
            'Home': 'home', 'End': 'end', 'PageUp': 'pageup',
            'PageDown': 'pagedown', 'F1': 'f1', 'F2': 'f2', 'F3': 'f3',
            'F4': 'f4', 'F5': 'f5', 'F11': 'f11', 'F12': 'f12',
            'Control': None, 'Shift': None, 'Alt': None, 'Meta': None,
            ' ': 'space',
        }
        
        mapped = key_map.get(key, key.lower() if len(key) == 1 else None)
        if not mapped:
            return
        
        if mods:
            pyautogui.hotkey(*mods, mapped)
        else:
            pyautogui.press(mapped) if len(mapped) > 1 else pyautogui.typewrite(mapped, interval=0.02)
    
    elif t == 'type':
        pyautogui.typewrite(cmd.get('text', ''), interval=0.03)
    
    elif t == 'screenshot':
        # Take screenshot and send back
        import base64, io
        from PIL import ImageGrab
        img = ImageGrab.grab()
        img = img.resize((1280, 720))
        buf = io.BytesIO()
        img.save(buf, format='JPEG', quality=60)
        b64 = base64.b64encode(buf.getvalue()).decode()
        sio.emit('agent:screenshot', {'code': code, 'data': b64})

def show_tray():
    """Simple system tray notification"""
    root = tk.Tk()
    root.withdraw()
    messagebox.showinfo(
        "WastedApe Remote Agent",
        f"Remote session active\nCode: {code}\n\nYour technician can now control this computer.\nClose this dialog to end the session."
    )
    sio.disconnect()
    sys.exit(0)

def run():
    if not code:
        print("Usage: python agent.py SESSION_CODE")
        sys.exit(1)
    
    print(f"WastedApe Remote Agent")
    print(f"Session code: {code}")
    print(f"Connecting to {REMOTE_API}...")
    
    # Show notification in separate thread
    t = threading.Thread(target=show_tray, daemon=True)
    t.start()
    
    try:
        sio.connect(REMOTE_API, transports=['websocket', 'polling'])
        sio.wait()
    except KeyboardInterrupt:
        print("Disconnected")
    except Exception as e:
        print(f"Connection failed: {e}")

if __name__ == '__main__':
    run()
