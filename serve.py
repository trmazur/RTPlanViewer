#!/usr/bin/env python3
"""
Local HTTP server for RT Plan Blinded Review Viewer.

Serves the viewer directory and provides endpoints for:
  - GET  /api/sites          — list anatomical sites
  - GET  /api/subjects?site= — list validated subjects for a site
  - GET  /api/config?site=   — get site configuration
  - POST /api/ranking        — save a reviewer ranking
  - GET  /api/ranking?site=&subject=&reviewer= — check existing ranking

Usage:
  python serve.py [port]
  Default port: 8080

Then open http://localhost:8080 in your browser.
"""

import http.server
import json
import os
import sys
import urllib.parse
from pathlib import Path

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080

# Resolve the directory this script lives in
VIEWER_DIR = Path(__file__).resolve().parent
SITES_DIR = VIEWER_DIR / 'SITES'
RANKINGS_DIR = SITES_DIR / '_rankings'


class ViewerHandler(http.server.SimpleHTTPRequestHandler):
    """HTTP handler with API endpoints for the plan viewer."""

    # Per-request socket timeout (seconds). Prevents hung connections from
    # tying up threads indefinitely.
    timeout = 120

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(VIEWER_DIR), **kwargs)

    def end_headers(self):
        # Prevent caching of JSON and binary data files
        path = self.path or ''
        if path.endswith('.json') or '_processed/' in path:
            self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
            self.send_header('Pragma', 'no-cache')
            self.send_header('Expires', '0')
        super().end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        params = urllib.parse.parse_qs(parsed.query)

        if path == '/api/sites':
            self._handle_list_sites()
        elif path == '/api/subjects':
            site = params.get('site', [''])[0]
            self._handle_list_subjects(site)
        elif path == '/api/config':
            site = params.get('site', [''])[0]
            self._handle_get_config(site)
        elif path == '/api/ranking':
            site = params.get('site', [''])[0]
            subject = params.get('subject', [''])[0]
            reviewer = params.get('reviewer', [''])[0]
            self._handle_get_ranking(site, subject, reviewer)
        elif path == '/api/ranking-status':
            site = params.get('site', [''])[0]
            reviewer = params.get('reviewer', [''])[0]
            self._handle_ranking_status(site, reviewer)
        elif path == '/api/subject-exists':
            site = params.get('site', [''])[0]
            subject = params.get('subject', [''])[0]
            self._handle_subject_exists(site, subject)
        else:
            super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == '/api/ranking':
            self._handle_save_ranking()
        elif parsed.path == '/api/config':
            self._handle_save_config()
        elif parsed.path == '/api/upload':
            self._handle_upload()
        elif parsed.path.startswith('/api/upload-binary/'):
            self._handle_upload_binary(parsed.path)
        else:
            self.send_error(404, 'Not found')

    def do_OPTIONS(self):
        """Handle CORS preflight."""
        self.send_response(200)
        self._cors_headers()
        self.end_headers()

    def _cors_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def _json_response(self, data, status=200):
        body = json.dumps(data, indent=2).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self._cors_headers()
        self.end_headers()
        self.wfile.write(body)

    # ── API: List Sites ──────────────────────────────────────────────────

    def _handle_list_sites(self):
        sites = []
        if SITES_DIR.exists():
            for entry in sorted(SITES_DIR.iterdir()):
                if entry.is_dir() and not entry.name.startswith('_'):
                    sites.append(entry.name)
        self._json_response({'sites': sites})

    # ── API: List Subjects ───────────────────────────────────────────────

    def _handle_list_subjects(self, site):
        site_dir = SITES_DIR / site
        subjects = []
        if site_dir.exists():
            for entry in sorted(site_dir.iterdir()):
                if entry.is_dir() and not entry.name.startswith('_'):
                    # Check if subject has processed data
                    processed = entry / '_processed'
                    manifest = processed / 'manifest.json'
                    status = 'processed' if manifest.exists() else 'unprocessed'
                    subjects.append({
                        'name': entry.name,
                        'status': status,
                        'hasManifest': manifest.exists(),
                    })
        self._json_response({'site': site, 'subjects': subjects})

    # ── API: Get/Save Site Config ────────────────────────────────────────

    def _handle_get_config(self, site):
        config_path = SITES_DIR / site / '_site_config.json'
        if config_path.exists():
            with open(config_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            self._json_response(data)
        else:
            self._json_response({'error': 'No config found'}, 404)

    def _handle_save_config(self):
        content_len = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_len)
        data = json.loads(body)

        site = data.get('site', '')
        if not site:
            self._json_response({'error': 'Missing site'}, 400)
            return

        site_dir = SITES_DIR / site
        site_dir.mkdir(parents=True, exist_ok=True)
        config_path = site_dir / '_site_config.json'

        with open(config_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2)

        self._json_response({'status': 'saved', 'path': str(config_path)})

    # ── API: Get/Save Rankings ───────────────────────────────────────────

    def _handle_get_ranking(self, site, subject, reviewer):
        RANKINGS_DIR.mkdir(parents=True, exist_ok=True)
        filename = f'{site}_{subject}_{reviewer}.json'.replace(' ', '_')
        filepath = RANKINGS_DIR / filename

        if filepath.exists():
            with open(filepath, 'r', encoding='utf-8') as f:
                data = json.load(f)
            self._json_response({'exists': True, 'ranking': data})
        else:
            self._json_response({'exists': False})

    def _handle_subject_exists(self, site, subject):
        """Return whether a subject has already been processed (manifest.json present).

        Used by the admin tool to gate re-imports. Re-importing an already-
        processed subject would silently overwrite its files and re-randomize
        the plan-letter identity map, silently corrupting any existing
        rankings that were collected against the previous map. The admin
        tool calls this endpoint up front and refuses to start an export if
        the subject already exists; deletion (and ranking-archival) must go
        through the management page first.

        Response: { "exists": bool, "site": str, "subject": str,
                    "manifestPath": str (only if exists) }
        """
        if not site or not subject:
            self._json_response({'error': 'Missing site or subject'}, 400)
            return
        manifest_path = SITES_DIR / site / subject / '_processed' / 'manifest.json'
        exists = manifest_path.exists()
        resp = {'exists': exists, 'site': site, 'subject': subject}
        if exists:
            resp['manifestPath'] = str(manifest_path.relative_to(VIEWER_DIR))
        self._json_response(resp)

    def _handle_ranking_status(self, site, reviewer):
        """Return per-subject phase completion status for a reviewer at a site.

        Response: { "SUBJ001": { "phase1": true, "phase2": true }, ... }
        phase2 is true if rankings_phase2 is present OR phase2_skipped is true.
        """
        if not site or not reviewer:
            self._json_response({})
            return

        RANKINGS_DIR.mkdir(parents=True, exist_ok=True)
        status = {}

        # Read all ranking files and match by JSON content (avoids filename
        # parsing ambiguity when site/subject/reviewer names contain spaces)
        for filepath in RANKINGS_DIR.glob('*.json'):
            try:
                with open(filepath, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                if data.get('site') != site or data.get('reviewer') != reviewer:
                    continue
                subject = data.get('subject', '')
                if not subject:
                    continue
                has_phase1 = bool(data.get('rankings_phase1'))
                has_phase2 = (
                    bool(data.get('rankings_phase2')) or
                    bool(data.get('phase2_skipped'))
                )
                status[subject] = {'phase1': has_phase1, 'phase2': has_phase2}
            except Exception:
                pass

        self._json_response(status)

    def _handle_save_ranking(self):
        content_len = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_len)
        data = json.loads(body)

        site = data.get('site', '')
        subject = data.get('subject', '')
        reviewer = data.get('reviewer', '')

        if not all([site, subject, reviewer]):
            self._json_response({'error': 'Missing required fields'}, 400)
            return

        RANKINGS_DIR.mkdir(parents=True, exist_ok=True)
        filename = f'{site}_{subject}_{reviewer}.json'.replace(' ', '_')
        filepath = RANKINGS_DIR / filename

        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2)

        self._json_response({'status': 'saved', 'path': str(filepath)})

    # ── API: Upload processed data ───────────────────────────────────────

    def _handle_upload(self):
        """Save pre-processed data files from the admin tool."""
        content_len = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_len)
        data = json.loads(body)

        site = data.get('site', '')
        subject = data.get('subject', '')
        file_name = data.get('fileName', '')
        file_data = data.get('data', '')
        encoding = data.get('encoding', 'text')  # 'text' or 'base64'

        if not all([site, subject, file_name]):
            self._json_response({'error': 'Missing fields'}, 400)
            return

        # Create _processed directory
        processed_dir = SITES_DIR / site / subject / '_processed'
        processed_dir.mkdir(parents=True, exist_ok=True)

        # Re-import guard: refuse to overwrite an existing manifest.json.
        # The manifest is the canonical "subject is processed" marker and is
        # uploaded first by the admin tool, so blocking it blocks the entire
        # re-import. Defense-in-depth — the admin tool already checks via
        # /api/subject-exists before starting, but this server-side guard
        # protects against stale clients, concurrent admins, or anyone
        # bypassing the client check.
        # To re-import a subject, delete it via the management page first
        # (which archives existing rankings with the original identity map).
        if file_name == 'manifest.json':
            target = processed_dir / 'manifest.json'
            if target.exists():
                self._json_response({
                    'error': ('Subject already processed. Delete it via the '
                              'management page first to re-import.'),
                    'site': site,
                    'subject': subject,
                }, 409)
                return

        # Handle subdirectories in fileName (e.g., "plan_A/dose.bin.gz")
        file_path = processed_dir / file_name
        file_path.parent.mkdir(parents=True, exist_ok=True)

        import base64
        if encoding == 'base64':
            binary = base64.b64decode(file_data)
            with open(file_path, 'wb') as f:
                f.write(binary)
        else:
            with open(file_path, 'w', encoding='utf-8') as f:
                f.write(file_data)

        size_kb = file_path.stat().st_size / 1024
        print(f"  Saved: {file_path.relative_to(VIEWER_DIR)} ({size_kb:.1f} KB)")

        self._json_response({
            'status': 'saved',
            'path': str(file_path),
            'size': file_path.stat().st_size,
        })

    # ── API: Upload binary data directly ────────────────────────────────

    def _handle_upload_binary(self, path):
        """Save a raw binary file. Path format: /api/upload-binary/{site}/{subject}/{filepath}"""
        # Parse: /api/upload-binary/CARDIAC/WASHUCARDIAC001/ct_volume.bin.gz
        parts = path.replace('/api/upload-binary/', '').split('/', 2)
        if len(parts) < 3:
            self._json_response({'error': 'Invalid path'}, 400)
            return

        site, subject, file_name = parts[0], parts[1], parts[2]

        content_len = int(self.headers.get('Content-Length', 0))
        print(f"  Receiving binary: {file_name} ({content_len / 1024 / 1024:.1f} MB)")

        # Read in chunks to handle large files
        processed_dir = SITES_DIR / site / subject / '_processed'
        processed_dir.mkdir(parents=True, exist_ok=True)
        file_path = processed_dir / file_name
        file_path.parent.mkdir(parents=True, exist_ok=True)

        bytes_read = 0
        chunk_size = 1024 * 1024  # 1MB chunks
        with open(file_path, 'wb') as f:
            while bytes_read < content_len:
                to_read = min(chunk_size, content_len - bytes_read)
                chunk = self.rfile.read(to_read)
                if not chunk:
                    break
                f.write(chunk)
                bytes_read += len(chunk)

        size_kb = file_path.stat().st_size / 1024
        print(f"  Saved: {file_path.relative_to(VIEWER_DIR)} ({size_kb:.1f} KB)")

        self._json_response({
            'status': 'saved',
            'path': str(file_path),
            'size': file_path.stat().st_size,
        })

    # ── Logging ──────────────────────────────────────────────────────────

    def log_message(self, format, *args):
        # Quieter logging — only show API calls and errors
        path = args[0] if args else ''
        if isinstance(path, str) and ('/api/' in path or '404' in str(args)):
            super().log_message(format, *args)


def main():
    import socket
    hostname = socket.gethostname()
    try:
        local_ip = socket.gethostbyname(hostname)
    except Exception:
        local_ip = '127.0.0.1'

    net_url = f'http://{hostname}:{PORT}'
    ip_url  = f'http://{local_ip}:{PORT}'
    loc_url = f'http://localhost:{PORT}'

    print(f'╔════════════════════════════════════════════════════════╗')
    print(f'║   RT Plan Blinded Review — Server                      ║')
    print(f'║                                                        ║')
    print(f'║   Serving: {str(VIEWER_DIR)[:44]:<44s} ║')
    print(f'║                                                        ║')
    print(f'║   Local:    {loc_url:<44s} ║')
    print(f'║   Network:  {net_url:<44s} ║')
    print(f'║   IP:       {ip_url:<44s} ║')
    print(f'║                                                        ║')
    print(f'║   Share the Network URL with reviewers.                ║')
    print(f'║   Press Ctrl+C to stop.                                ║')
    print(f'╚════════════════════════════════════════════════════════╝')
    print()

    # Use ThreadingHTTPServer so one slow/hung request can't block others.
    # Also set SO_REUSEADDR so restarts don't fail with "address in use".
    class ReusableThreadingHTTPServer(http.server.ThreadingHTTPServer):
        allow_reuse_address = True
        daemon_threads = True  # don't block shutdown on long-running requests

    server = ReusableThreadingHTTPServer(('0.0.0.0', PORT), ViewerHandler)
    # Kill sockets that have been idle too long instead of letting them accumulate
    server.timeout = 300
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nServer stopped.')
        server.server_close()


if __name__ == '__main__':
    main()
