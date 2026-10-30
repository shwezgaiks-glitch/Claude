"""A small web server that only listens on this computer and drives the app's page."""

import json
import os
import platform
import shutil
import subprocess
import threading
import traceback
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import ai, mover, planner

STATIC = os.path.join(os.path.dirname(__file__), "static")


class Job:
    """The one task running at a time (scan, sort or undo) and what it has produced."""

    def __init__(self):
        self.lock = threading.Lock()
        self.state = {"busy": False, "step": "", "done": 0, "total": 0, "error": None}
        self.plan = None
        self.summary = None
        self.result = None

    def progress(self, step, done, total):
        with self.lock:
            self.state.update(step=step, done=done, total=total)

    def start(self, work):
        with self.lock:
            if self.state["busy"]:
                return False
            self.state = {"busy": True, "step": "Starting", "done": 0, "total": 0, "error": None}

        def run():
            try:
                work()
            except Exception as e:  # shown on the page instead of a silent failure
                traceback.print_exc()
                with self.lock:
                    self.state["error"] = str(e)
            finally:
                with self.lock:
                    self.state["busy"] = False

        threading.Thread(target=run, daemon=True).start()
        return True


JOB = Job()


def choose_folder():
    """Open the computer's own folder picker. Returns a path, or None if cancelled."""
    system = platform.system()
    try:
        if system == "Darwin":
            out = subprocess.run(
                ["osascript", "-e", 'POSIX path of (choose folder with prompt "Choose the folder to sort")'],
                capture_output=True, text=True)
        elif system == "Windows":
            script = (
                "Add-Type -AssemblyName System.Windows.Forms;"
                "$d = New-Object System.Windows.Forms.FolderBrowserDialog;"
                "$d.Description = 'Choose the folder to sort';"
                "if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }")
            out = subprocess.run(["powershell", "-NoProfile", "-STA", "-Command", script],
                                 capture_output=True, text=True)
        elif shutil.which("zenity"):
            out = subprocess.run(["zenity", "--file-selection", "--directory"], capture_output=True, text=True)
        else:
            return None
    except OSError:
        return None
    return out.stdout.strip() or None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # keep the terminal quiet

    def _send(self, status, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            with open(os.path.join(STATIC, "index.html"), "rb") as f:
                return self._send(200, f.read(), "text/html; charset=utf-8")
        if self.path == "/api/status":
            with JOB.lock:
                return self._send(200, {
                    "job": dict(JOB.state),
                    "summary": JOB.summary,
                    "result": JOB.result,
                    "ai_available": ai.available(),
                    "default_categories": ai.DEFAULT_CATEGORIES,
                })
        self._send(404, {"error": "not found"})

    def do_POST(self):
        # Only accept requests from this app's own page.
        origin = self.headers.get("Origin")
        if origin and origin != f"http://{self.headers.get('Host')}":
            return self._send(403, {"error": "forbidden"})
        try:
            body = self._body()
        except ValueError:
            return self._send(400, {"error": "bad request"})
        route = {
            "/api/browse": self.browse,
            "/api/scan": self.scan,
            "/api/apply": self.apply,
            "/api/runs": self.runs,
            "/api/undo": self.undo,
        }.get(self.path)
        if not route:
            return self._send(404, {"error": "not found"})
        route(body)

    def browse(self, body):
        self._send(200, {"path": choose_folder()})

    def scan(self, body):
        source = os.path.expanduser((body.get("source") or "").strip().strip('"'))
        if not os.path.isdir(source):
            return self._send(400, {"error": "That folder doesn't exist. Check the path and try again."})
        dest = os.path.expanduser((body.get("dest") or "").strip().strip('"')) or planner.default_dest(source)
        classify = None
        if body.get("by_content"):
            if not ai.available():
                return self._send(400, {"error": "Sorting by content needs the AI add-on. See the README."})
            classify = ai.make_classifier(body.get("categories"))

        def work():
            with JOB.lock:
                JOB.plan = JOB.summary = JOB.result = None
            plan = planner.build_plan(source, dest, classify=classify, progress=JOB.progress)
            summary = planner.summarize(plan)
            summary["copy"] = bool(body.get("copy"))
            with JOB.lock:
                JOB.plan, JOB.summary = plan, summary

        self._start(work)

    def apply(self, body):
        with JOB.lock:
            plan, summary = JOB.plan, JOB.summary
        if not plan:
            return self._send(400, {"error": "Scan a folder first."})

        def work():
            result = mover.apply_plan(plan, copy=summary.get("copy"), progress=JOB.progress)
            with JOB.lock:
                JOB.result = dict(result, kind="sort")
                JOB.plan = None  # a plan is used once; scan again for a fresh one

        self._start(work)

    def runs(self, body):
        dest = (body.get("dest") or "").strip().strip('"')
        if not dest and body.get("source"):
            dest = planner.default_dest(body["source"].strip().strip('"'))
        self._send(200, {"runs": mover.list_runs(os.path.expanduser(dest)) if dest else []})

    def undo(self, body):
        log = body.get("log") or ""
        # Only logs this app wrote can be undone.
        if not (log.endswith(".jsonl") and os.sep + planner.STATE_DIR + os.sep in log and os.path.isfile(log)):
            return self._send(400, {"error": "Unknown run."})

        def work():
            result = mover.undo(log, progress=JOB.progress)
            with JOB.lock:
                JOB.result = dict(result, kind="undo")
                JOB.summary = None

        self._start(work)

    def _start(self, work):
        if JOB.start(work):
            self._send(200, {"ok": True})
        else:
            self._send(409, {"error": "Still busy with the last task."})


def serve(port=8765, open_browser=True):
    for p in range(port, port + 20):
        try:
            httpd = ThreadingHTTPServer(("127.0.0.1", p), Handler)
            break
        except OSError:
            continue
    else:
        raise SystemExit("Couldn't find a free port to start on.")
    url = f"http://127.0.0.1:{httpd.server_port}/"
    print(f"Photo Sorter is running at {url}")
    print("Keep this window open while you use it. Close it (or press Ctrl+C) to quit.")
    if open_browser:
        threading.Timer(0.5, webbrowser.open, [url]).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
