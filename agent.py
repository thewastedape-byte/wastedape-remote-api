"""
WastedApe Remote Agent v2
Full OS control + screenshot streaming + shell execution
Run: python agent.py SESSION_CODE
Or double-click and enter code in the popup.
"""

import sys
import json
import time
import threading
import subprocess
import base64
import io
import tkinter as tk
from tkinter import simpledialog, messagebox

REMOTE_API = "https://wastedape-remote-api.onrender.com"
SCREENSHOT_INTERVAL = 2.0  # seconds between screenshots

# Auto-install dependencies
def install_deps():
    required = ['pyautogui', 'python-socketio[client]', 'pillow', 'websocket-client', 'screeninfo']
    try:
        import pyautogui, socketio, PIL, screeninfo
    except ImportError:
        print("Installing dependencies...")
        subprocess.check_call([sys.executable, "-m", "pip", "install"] + required, 
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

install_deps()

import pyautogui
import socketio as sio_module
from PIL import ImageGrab

pyautogui.FAILSAFE = False
pyautogui.PAUSE = 0.01

sio = sio_module.Client(reconnection=True, reconnection_attempts=10, reconnection_delay=2)
code = None
running = True
screen_w, screen_h = pyautogui.size()

def take_screenshot():
    try:
        img = ImageGrab.grab()
        # Resize to 1280x720 for bandwidth
        img = img.resize((1280, 720))
        buf = io.BytesIO()
        img.save(buf, format='JPEG', quality=50)
        return base64.b64encode(buf.getvalue()).decode()
    except Exception as e:
        print(f"Screenshot error: {e}")
        return None

def screenshot_loop():
    while running:
        if sio.connected and code:
            data = take_screenshot()
            if data:
                sio.emit('agent:screenshot', {'code': code, 'data': data})
        time.sleep(SCREENSHOT_INTERVAL)

def execute(cmd):
    t = cmd.get('type')
    try:
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

        elif t == 'rightclick':
            x = int(cmd['x'] * screen_w)
            y = int(cmd['y'] * screen_h)
            pyautogui.rightClick(x, y)

        elif t == 'scroll':
            clicks = -int(cmd.get('deltaY', 0) / 100)
            pyautogui.scroll(clicks)

        elif t == 'keydown':
            key = cmd.get('key', '')
            ctrl = cmd.get('ctrlKey', False)
            shift = cmd.get('shiftKey', False)
            alt = cmd.get('altKey', False)
            win = cmd.get('metaKey', False)

            key_map = {
                'Backspace': 'backspace', 'Enter': 'enter', 'Tab': 'tab',
                'Escape': 'esc', 'Delete': 'delete', 'ArrowUp': 'up',
                'ArrowDown': 'down', 'ArrowLeft': 'left', 'ArrowRight': 'right',
                'Home': 'home', 'End': 'end', 'PageUp': 'pageup',
                'PageDown': 'pagedown', ' ': 'space',
                'F1':'f1','F2':'f2','F3':'f3','F4':'f4','F5':'f5',
                'F6':'f6','F7':'f7','F8':'f8','F9':'f9','F10':'f10',
                'F11':'f11','F12':'f12',
                'Control': None, 'Shift': None, 'Alt': None, 'Meta': None,
            }
            mapped = key_map.get(key, key.lower() if len(key) == 1 else None)
            if not mapped:
                return

            mods = []
            if ctrl: mods.append('ctrl')
            if shift: mods.append('shift')
            if alt: mods.append('alt')
            if win: mods.append('win')

            if mods:
                pyautogui.hotkey(*mods, mapped)
            elif len(mapped) == 1:
                pyautogui.typewrite(mapped, interval=0.02)
            else:
                pyautogui.press(mapped)

        elif t == 'type':
            # Type a full string
            text = cmd.get('text', '')
            pyautogui.typewrite(text, interval=0.03)

        elif t == 'hotkey':
            # e.g. {'type':'hotkey','keys':['ctrl','c']}
            pyautogui.hotkey(*cmd.get('keys', []))

        elif t == 'screenshot':
            data = take_screenshot()
            if data:
                sio.emit('agent:screenshot', {'code': code, 'data': data})

    except Exception as e:
        print(f"Execute error ({t}): {e}")

def run_shell(command, request_id):
    """Run shell command and send result back"""
    try:
        result = subprocess.run(
            command, shell=True, capture_output=True, text=True, timeout=30
        )
        sio.emit('shell:result', {
            'requestId': request_id,
            'output': result.stdout + result.stderr,
            'exitCode': result.returncode,
            'error': None
        })
    except subprocess.TimeoutExpired:
        sio.emit('shell:result', {'requestId': request_id, 'output': '', 'error': 'Timeout', 'exitCode': -1})
    except Exception as e:
        sio.emit('shell:result', {'requestId': request_id, 'output': '', 'error': str(e), 'exitCode': -1})

@sio.event
def connect():
    print(f"Connected to WastedApe server")
    sio.emit('agent:join', {'code': code})

@sio.event
def disconnect():
    print("Disconnected from server")

@sio.on('agent:connected')
def on_agent_connected(data):
    print(f"Agent registered for session {data.get('code')}")
    # Start screenshot loop
    t = threading.Thread(target=screenshot_loop, daemon=True)
    t.start()

@sio.on('control')
def on_control(data):
    threading.Thread(target=execute, args=(data,), daemon=True).start()

@sio.on('shell')
def on_shell(data):
    cmd = data.get('command', '')
    req_id = data.get('requestId', '')
    print(f"Shell command: {cmd}")
    threading.Thread(target=run_shell, args=(cmd, req_id), daemon=True).start()

@sio.on('session:ended')
def on_ended(data=None):
    print("Session ended by host")
    global running
    running = False
    sio.disconnect()
    sys.exit(0)

def get_code_from_user():
    root = tk.Tk()
    root.withdraw()
    c = simpledialog.askstring(
        "WastedApe Remote Agent",
        "Enter the session code from your technician:",
        parent=root
    )
    root.destroy()
    return c

def show_status_window(session_code):
    root = tk.Tk()
    root.title("WastedApe Remote Agent")
    root.geometry("400x200")
    root.configure(bg='#1a1a1a')
    root.resizable(False, False)

    tk.Label(root, text="WastedApe Remote Agent", font=('Arial', 14, 'bold'),
             bg='#1a1a1a', fg='#C8922A').pack(pady=(20,5))
    tk.Label(root, text=f"Session Code: {session_code}", font=('Arial', 12),
             bg='#1a1a1a', fg='white').pack(pady=5)
    tk.Label(root, text="Your technician now has remote access.\nClose this window to end the session.",
             font=('Arial', 10), bg='#1a1a1a', fg='#aaa', justify='center').pack(pady=10)

    def on_close():
        global running
        running = False
        try: sio.disconnect()
        except: pass
        root.destroy()
        sys.exit(0)

    tk.Button(root, text="End Session", command=on_close,
              bg='#8b1a1a', fg='white', font=('Arial', 10), relief='flat',
              padx=20, pady=8).pack(pady=10)

    root.protocol("WM_DELETE_WINDOW", on_close)
    root.mainloop()

def main():
    global code

    if len(sys.argv) > 1:
        code = sys.argv[1]
    else:
        code = get_code_from_user()

    if not code:
        print("No code provided")
        sys.exit(1)

    code = code.strip()
    print(f"WastedApe Remote Agent - Session: {code}")

    # Connect in background thread
    def connect_thread():
        try:
            sio.connect(REMOTE_API, transports=['websocket', 'polling'])
            sio.wait()
        except Exception as e:
            print(f"Connection error: {e}")

    t = threading.Thread(target=connect_thread, daemon=True)
    t.start()

    # Show GUI (blocks until window closed)
    show_status_window(code)

if __name__ == '__main__':
    main()
