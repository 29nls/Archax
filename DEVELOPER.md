# Developer Setup — Run Local Backends

This file explains how to run the two optional local backends used by Mephisto for automation and remote analysis.

Important notes
- Only run these backends on a machine you control. `mephisto-clicker.py` will move your mouse and click; use with caution.
- Default ports used by the extension: `mephisto-clicker.py` -> `8080`, `remote-engine.py` -> `9090`.

Prerequisites
- Python 3.8+ (recommended)
- pip
- On Windows, run commands in an elevated terminal if you encounter permission issues.

1) mephisto-clicker.py (local clicker using pyautogui)

This backend listens on `http://localhost:8080` and performs simulated mouse clicks/drags using `pyautogui`.

Install requirements (recommended inside a virtualenv):

```bash
python -m venv .venv
.venv\Scripts\activate
python -m pip install --upgrade pip
python -m pip install flask pyautogui pillow
```

Run the server:

```bash
python src/scripts/mephisto-clicker.py --port 8080
```

Options:
- `--port` / `-p` : port to run (default 8080)
- `--drag-time` / `-d` : base drag time in ms (default 100)
- `--drag-var` / `-v` : variance for drag time in ms (default 20)

Test the endpoint (sanity):

```bash
curl -X POST http://localhost:8080/performClick -H "Content-Type: application/json" -d '{"x":100,"y":100}'
```

2) remote-engine.py (remote UCI analysis server)

This backend exposes an HTTP API (default `http://localhost:9090`) that wraps a UCI engine (stockfish or other) using `python-chess`.

Install requirements:

```bash
python -m venv .venv
.venv\Scripts\activate
python -m pip install --upgrade pip
python -m pip install flask python-chess
```

You must have a native Stockfish (or another UCI engine) binary available. Example (Windows): download `stockfish.exe` and note its path.

Run the server (example using Stockfish executable):

```bash
python src/scripts/remote-engine.py C:\path\to\stockfish.exe -o Hash:32 -o Threads:4 -p 9090
```

Example requests:

Analyze (JSON POST):

```bash
curl -X POST http://localhost:9090/analyse -H "Content-Type: application/json" -d '{"fen":"startfen","time":1000}'
```

Configure engine (JSON POST):

```bash
curl -X POST http://localhost:9090/configure -H "Content-Type: application/json" -d '{"Hash":32,"Threads":4,"MultiPV":2}'
```

Developer notes
- If `remote` engine mode is selected in the extension settings, `popup.js` will call `http://localhost:9090` for analysis.
- If `python_autoplay_backend` is enabled in settings, the extension will POST click events to `http://localhost:8080/performClick`.
- Ensure firewall rules permit local loopback traffic to these ports.

Browser extension local install
- Open `chrome://extensions` (or `edge://extensions`) and enable Developer Mode.
- Click "Load unpacked" and select the extension repository root (the folder containing `manifest.json`).
- Reload the extension after making code changes.

Safety reminders
- The clicker will move and click the OS cursor. Only enable automation when ready and when the correct browser/tab is focused.
- Do not expose the localhost endpoints to remote networks; run behind local-only interfaces.

If you want, I can also add a small `requirements.txt`, a PowerShell/Batch startup script for Windows, or integrate a safety confirmation endpoint to the clicker server.