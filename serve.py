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
import re
import shutil
import sys
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080

# Resolve the directory this script lives in
VIEWER_DIR = Path(__file__).resolve().parent
SITES_DIR = VIEWER_DIR / 'SITES'
RANKINGS_DIR = SITES_DIR / '_rankings'
SUPER_USERS_FILE = VIEWER_DIR / '_super_users.json'


# ── Super-user permissions ───────────────────────────────────────────────
# Permission config lives in _super_users.json at the viewer root, structured
# as { "<site>": [reviewer names], "*": [global super-users] }. A reviewer is
# a super-user for a site if they appear in '*' or in that site's array.
# Missing/unreadable file = no one is super (fail safe).

def _load_super_users():
    """Return the super-user permission map, or {} if unreadable."""
    if not SUPER_USERS_FILE.exists():
        return {}
    try:
        with open(SUPER_USERS_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _is_super_user(reviewer, site=None):
    """True if `reviewer` has super-user rights for `site` (or for any site
    if site is None — used when listing across-site data)."""
    if not reviewer:
        return False
    config = _load_super_users()
    # Global super-users always pass
    globals_list = config.get('*', [])
    if isinstance(globals_list, list) and reviewer in globals_list:
        return True
    if site is None:
        # Any site: check membership in any per-site list
        for k, v in config.items():
            if k.startswith('_') or k == '*':
                continue
            if isinstance(v, list) and reviewer in v:
                return True
        return False
    site_list = config.get(site, [])
    return isinstance(site_list, list) and reviewer in site_list


def _accessible_sites(reviewer):
    """Return the set of site names this super-user can access, or None for
    global access (all sites). Empty set = no access."""
    config = _load_super_users()
    globals_list = config.get('*', [])
    if isinstance(globals_list, list) and reviewer in globals_list:
        return None  # all sites
    sites = set()
    for k, v in config.items():
        if k.startswith('_') or k == '*':
            continue
        if isinstance(v, list) and reviewer in v:
            sites.add(k)
    return sites


# ── Delete / archive helpers ─────────────────────────────────────────────
# All destructive admin actions go through these helpers so the
# archive-on-delete + audit-log behavior is consistent.

ADMIN_LOG_FILE = SITES_DIR / '_admin_log.json'
RANKINGS_ARCHIVE_DIR = SITES_DIR / '_rankings' / '_archived'
SUBJECTS_ARCHIVE_DIR = SITES_DIR / '_processed_archived'

# Hard cap on number of items deletable in a single API call. Forces a
# deliberate workflow and protects against accidental "select-all → delete".
DELETE_BULK_CAP = 50

# Per-plan small JSON files we DO archive when a subject is deleted. The
# binary CT/dose volumes are intentionally NOT archived (regenerable from
# DICOM source, and balloon archive size).
PER_PLAN_ARCHIVE_FILES = (
    'clinical_goals.json',
    'plan_params.json',
    'dose_meta.json',
    'dvh.json',
    'structures.json',
)
SUBJECT_ARCHIVE_TOPLEVEL = ('manifest.json', 'ct_meta.json')


def _safe_timestamp_for_filename():
    """ISO-like timestamp with no characters that are invalid in filenames
    (Windows rejects ':' in paths). Sortable lexicographically."""
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H-%M-%SZ')


_FILENAME_SAFE_RE = re.compile(r'[^A-Za-z0-9._-]')

def _safe_filename_chunk(s):
    """Sanitize a string for use as a filename component."""
    return _FILENAME_SAFE_RE.sub('_', str(s))[:80]


def _validate_site_subject(site, subject):
    """Path-traversal guard. Returns (ok, error_message)."""
    if not site or not subject:
        return False, 'Missing site or subject'
    bad = ('/', '\\', '..', '\x00', ':')
    if any(b in site for b in bad):
        return False, f'Invalid site name: {site!r}'
    if any(b in subject for b in bad):
        return False, f'Invalid subject name: {subject!r}'
    return True, None


def _find_ranking_file(site, subject, reviewer):
    """Find a ranking file by JSON content, not filename. Returns Path or None.
    Filenames substitute spaces for underscores, which makes parsing them
    ambiguous when names already contain underscores."""
    if not RANKINGS_DIR.exists():
        return None
    for f in RANKINGS_DIR.glob('*.json'):
        try:
            with open(f, 'r', encoding='utf-8') as fp:
                data = json.load(fp)
            if (data.get('site') == site and
                    data.get('subject') == subject and
                    data.get('reviewer') == reviewer):
                return f
        except Exception:
            continue
    return None


def _archive_ranking(ranking_path, super_user, subject_still_processed):
    """Archive a ranking file with metadata. Returns archive Path."""
    RANKINGS_ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    with open(ranking_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    archived = {
        '_archive_meta': {
            'archived_at': datetime.now(timezone.utc).isoformat(),
            'archived_by': super_user,
            'original_filename': ranking_path.name,
            'subject_still_processed': subject_still_processed,
        },
        'ranking': data,
    }

    site = _safe_filename_chunk(data.get('site', 'unknown'))
    subject = _safe_filename_chunk(data.get('subject', 'unknown'))
    reviewer = _safe_filename_chunk(data.get('reviewer', 'unknown'))
    archive_name = f'{_safe_timestamp_for_filename()}_{site}_{subject}_{reviewer}.json'
    archive_path = RANKINGS_ARCHIVE_DIR / archive_name

    with open(archive_path, 'w', encoding='utf-8') as f:
        json.dump(archived, f, indent=2)
    return archive_path


def _archive_subject(site, subject, super_user):
    """Archive small text files from a subject's _processed/. Returns the
    archive directory Path. Binary CT/dose volumes are NOT copied."""
    src = SITES_DIR / site / subject / '_processed'
    if not src.exists():
        return None

    SUBJECTS_ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    archive_dir = SUBJECTS_ARCHIVE_DIR / (
        f'{_safe_timestamp_for_filename()}_'
        f'{_safe_filename_chunk(site)}_{_safe_filename_chunk(subject)}'
    )
    archive_dir.mkdir(parents=True, exist_ok=True)

    # Top-level small JSON files
    for fname in SUBJECT_ARCHIVE_TOPLEVEL:
        sf = src / fname
        if sf.exists():
            shutil.copy2(sf, archive_dir / fname)

    # Per-plan small files; preserve plan_A/ plan_B/ ... structure
    for plan_dir in src.iterdir():
        if not plan_dir.is_dir() or not plan_dir.name.startswith('plan_'):
            continue
        plan_archive = archive_dir / plan_dir.name
        plan_archive.mkdir(parents=True, exist_ok=True)
        for fname in PER_PLAN_ARCHIVE_FILES:
            sf = plan_dir / fname
            if sf.exists():
                shutil.copy2(sf, plan_archive / fname)

    # Tombstone metadata
    with open(archive_dir / '_delete_meta.json', 'w', encoding='utf-8') as f:
        json.dump({
            'deleted_at': datetime.now(timezone.utc).isoformat(),
            'deleted_by': super_user,
            'site': site,
            'subject': subject,
            'note': ('Binary CT/dose volumes not archived (regenerable from '
                     'DICOM source). Small JSON metadata preserved here for '
                     'audit traceability.'),
        }, f, indent=2)

    return archive_dir


def _append_audit(entry):
    """Append a single entry to the admin audit log (creates if missing)."""
    SITES_DIR.mkdir(parents=True, exist_ok=True)
    log = []
    if ADMIN_LOG_FILE.exists():
        try:
            with open(ADMIN_LOG_FILE, 'r', encoding='utf-8') as f:
                loaded = json.load(f)
            if isinstance(loaded, list):
                log = loaded
        except Exception:
            log = []  # corrupt log — start fresh; corrupt content stays on disk for forensics
    log.append(entry)
    with open(ADMIN_LOG_FILE, 'w', encoding='utf-8') as f:
        json.dump(log, f, indent=2)


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
        elif path == '/api/admin/super-users':
            self._handle_admin_super_users()
        elif path == '/api/admin/subjects':
            reviewer = params.get('reviewer', [''])[0]
            self._handle_admin_list_subjects(reviewer)
        elif path == '/api/admin/rankings':
            reviewer = params.get('reviewer', [''])[0]
            site_filter = params.get('site', [''])[0]
            subject_filter = params.get('subject', [''])[0]
            reviewer_filter = params.get('reviewerFilter', [''])[0]
            self._handle_admin_list_rankings(reviewer, site_filter, subject_filter, reviewer_filter)
        elif path == '/api/admin/audit-log':
            reviewer = params.get('reviewer', [''])[0]
            try:
                limit = int(params.get('limit', ['200'])[0])
            except (ValueError, TypeError):
                limit = 200
            self._handle_admin_audit_log(reviewer, limit)
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
        elif parsed.path == '/api/admin/delete-rankings':
            self._handle_admin_delete_rankings()
        elif parsed.path == '/api/admin/delete-subjects':
            self._handle_admin_delete_subjects()
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

    # ── API: Management page (super-user only) ──────────────────────────

    def _handle_admin_super_users(self):
        """Return the super-user config so the management page can show or
        hide its UI based on the current reviewer. The page itself doesn't
        enforce — every destructive endpoint re-checks server-side."""
        self._json_response(_load_super_users())

    def _handle_admin_list_subjects(self, reviewer):
        """List processed subjects the super-user can see, with metadata.

        Returns one entry per subject directory that has a manifest.json,
        filtered by the reviewer's site permissions. Each entry includes
        plan list, processed-at timestamp, ranking count, and total disk
        size — enough to populate a management table without further calls.
        """
        if not _is_super_user(reviewer):
            self._json_response({'error': 'Not authorized'}, 403)
            return

        accessible = _accessible_sites(reviewer)  # None = global
        subjects = []

        if SITES_DIR.exists():
            for site_dir in sorted(SITES_DIR.iterdir()):
                if not site_dir.is_dir() or site_dir.name.startswith('_'):
                    continue
                site = site_dir.name
                if accessible is not None and site not in accessible:
                    continue
                for subj_dir in sorted(site_dir.iterdir()):
                    if not subj_dir.is_dir() or subj_dir.name.startswith('_'):
                        continue
                    manifest_path = subj_dir / '_processed' / 'manifest.json'
                    if not manifest_path.exists():
                        continue

                    try:
                        with open(manifest_path, 'r', encoding='utf-8') as f:
                            m = json.load(f)
                    except Exception:
                        continue

                    # Plan list — prefer explicit field, fall back to identityMap
                    plans = m.get('plans')
                    if not plans:
                        identity_map = m.get('identityMap') or {}
                        plans = sorted(set(identity_map.values()))
                    if not plans:
                        plans = ['A', 'B', 'C']

                    # Total bytes in _processed/ (recursive)
                    total_size = 0
                    try:
                        for f in (subj_dir / '_processed').rglob('*'):
                            if f.is_file():
                                total_size += f.stat().st_size
                    except Exception:
                        pass

                    subjects.append({
                        'site': site,
                        'subject': subj_dir.name,
                        'plans': plans,
                        'numPlans': len(plans),
                        'processedAt': m.get('validatedAt'),
                        'rankingCount': self._count_rankings_for(site, subj_dir.name),
                        'totalSizeMB': round(total_size / 1024 / 1024, 2),
                    })

        self._json_response({
            'subjects': subjects,
            'accessibleSites': sorted(accessible) if accessible is not None else None,  # None = global
        })

    def _handle_admin_list_rankings(self, reviewer, site_filter, subject_filter, reviewer_filter):
        """List rankings the super-user can see, with optional filters by
        site / subject / reviewer-being-listed.

        Note: `reviewer` is the *requestor* (used for the auth check).
        `reviewer_filter` is the reviewer-name filter applied to the list
        contents. Two different concepts — they happen to use similar names.
        """
        if not _is_super_user(reviewer):
            self._json_response({'error': 'Not authorized'}, 403)
            return

        accessible = _accessible_sites(reviewer)
        rankings = []

        if RANKINGS_DIR.exists():
            # Non-recursive glob — skips _archived/ subdirectory
            for rfile in sorted(RANKINGS_DIR.glob('*.json')):
                try:
                    with open(rfile, 'r', encoding='utf-8') as f:
                        data = json.load(f)
                except Exception:
                    continue

                site = data.get('site', '')
                subject = data.get('subject', '')
                rname = data.get('reviewer', '')

                if accessible is not None and site not in accessible:
                    continue
                if site_filter and site != site_filter:
                    continue
                if subject_filter and subject != subject_filter:
                    continue
                if reviewer_filter and rname != reviewer_filter:
                    continue

                rankings.append({
                    'site': site,
                    'subject': subject,
                    'reviewer': rname,
                    'phase1Complete': bool(data.get('rankings_phase1')),
                    'phase2Complete': (bool(data.get('rankings_phase2')) or
                                       bool(data.get('phase2_skipped'))),
                    'phase2Skipped': bool(data.get('phase2_skipped')),
                    'timestamp': data.get('timestamp'),
                    'timestampPhase2': data.get('timestamp_phase2'),
                    'numPlans': data.get('numPlans'),
                    'filename': rfile.name,
                })

        self._json_response({'rankings': rankings})

    def _handle_admin_audit_log(self, reviewer, limit):
        """Return audit log entries the super-user is allowed to see, newest
        first, capped at `limit` entries (default 200, max 1000).

        Per-site super-users only see entries for their accessible sites;
        global super-users see everything.
        """
        if not _is_super_user(reviewer):
            self._json_response({'error': 'Not authorized'}, 403)
            return

        # Sanitize limit
        if limit < 1:
            limit = 1
        elif limit > 1000:
            limit = 1000

        accessible = _accessible_sites(reviewer)  # None = global
        entries = []
        if ADMIN_LOG_FILE.exists():
            try:
                with open(ADMIN_LOG_FILE, 'r', encoding='utf-8') as f:
                    loaded = json.load(f)
                if isinstance(loaded, list):
                    entries = loaded
            except Exception:
                entries = []

        if accessible is not None:
            entries = [e for e in entries if e.get('site') in accessible]

        # Newest first, then cap
        entries = list(reversed(entries))[:limit]

        self._json_response({
            'entries': entries,
            'returned': len(entries),
            'totalOnDisk': self._audit_total_count(),
        })

    def _audit_total_count(self):
        """Cheap sanity number for the audit log size on disk (informational)."""
        if not ADMIN_LOG_FILE.exists():
            return 0
        try:
            with open(ADMIN_LOG_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
            return len(data) if isinstance(data, list) else 0
        except Exception:
            return 0

    def _handle_admin_delete_rankings(self):
        """Delete one or more ranking files. Each is archived to
        _rankings/_archived/ before removal, with original-filename and
        super-user metadata. Audit log entry written per ranking.

        Body: { "reviewer": "<super-user name>",
                "rankings": [{site, subject, reviewer}, ...] }

        Per-ranking authorization: super-user must have rights for that
        site (not just any site). Mixed-site batches partially succeed —
        per-item errors are returned alongside successes.

        Response: { "deleted": [{site, subject, reviewer, archivePath}],
                    "errors":  [{site, subject, reviewer, error}] }
        """
        try:
            body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
            data = json.loads(body)
        except Exception:
            self._json_response({'error': 'Invalid JSON body'}, 400)
            return

        super_user = data.get('reviewer', '')
        items = data.get('rankings', [])

        if not _is_super_user(super_user):
            self._json_response({'error': 'Not authorized'}, 403)
            return
        if not isinstance(items, list) or not items:
            self._json_response({'error': '`rankings` must be a non-empty array'}, 400)
            return
        if len(items) > DELETE_BULK_CAP:
            self._json_response(
                {'error': f'Bulk-delete cap exceeded (max {DELETE_BULK_CAP} per request)'},
                400)
            return

        deleted, errors = [], []
        for item in items:
            site = item.get('site', '')
            subject = item.get('subject', '')
            rname = item.get('reviewer', '')

            ok, err = _validate_site_subject(site, subject)
            if not ok:
                errors.append({'site': site, 'subject': subject, 'reviewer': rname, 'error': err})
                continue
            if not _is_super_user(super_user, site):
                errors.append({'site': site, 'subject': subject, 'reviewer': rname,
                               'error': 'Not authorized for this site'})
                continue

            ranking_path = _find_ranking_file(site, subject, rname)
            if not ranking_path:
                errors.append({'site': site, 'subject': subject, 'reviewer': rname,
                               'error': 'Ranking file not found'})
                continue

            manifest_path = SITES_DIR / site / subject / '_processed' / 'manifest.json'
            still_processed = manifest_path.exists()

            try:
                archive_path = _archive_ranking(ranking_path, super_user, still_processed)
                ranking_path.unlink()
                rel_archive = str(archive_path.relative_to(VIEWER_DIR))
                deleted.append({
                    'site': site, 'subject': subject, 'reviewer': rname,
                    'archivePath': rel_archive,
                })
                _append_audit({
                    'timestamp': datetime.now(timezone.utc).isoformat(),
                    'super_user': super_user,
                    'action': 'delete_ranking',
                    'site': site, 'subject': subject, 'reviewer': rname,
                    'archive_path': rel_archive,
                    'subject_still_processed': still_processed,
                })
            except Exception as e:
                errors.append({'site': site, 'subject': subject, 'reviewer': rname,
                               'error': f'Delete failed: {e}'})

        self._json_response({'deleted': deleted, 'errors': errors})

    def _handle_admin_delete_subjects(self):
        """Delete one or more processed subjects. Cascades to associated
        rankings (archives them first). Each subject's small JSON metadata
        is archived; binary CT/dose volumes are not (regenerable from
        DICOM source). Only the `_processed/` directory is removed; any
        sibling DICOM source folders under SITES/{site}/{subject}/ are
        left in place so the subject can be re-imported from the same
        source if desired.

        Body: { "reviewer": "<super-user name>",
                "subjects": [{site, subject}, ...],
                "cascade": true }

        Response: { "deleted": [{site, subject, archivePath, cascadedRankings: [...]}],
                    "errors":  [{site, subject, error}] }
        """
        try:
            body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
            data = json.loads(body)
        except Exception:
            self._json_response({'error': 'Invalid JSON body'}, 400)
            return

        super_user = data.get('reviewer', '')
        items = data.get('subjects', [])
        cascade = bool(data.get('cascade', True))

        if not _is_super_user(super_user):
            self._json_response({'error': 'Not authorized'}, 403)
            return
        if not isinstance(items, list) or not items:
            self._json_response({'error': '`subjects` must be a non-empty array'}, 400)
            return
        if len(items) > DELETE_BULK_CAP:
            self._json_response(
                {'error': f'Bulk-delete cap exceeded (max {DELETE_BULK_CAP} per request)'},
                400)
            return

        deleted, errors = [], []
        for item in items:
            site = item.get('site', '')
            subject = item.get('subject', '')

            ok, err = _validate_site_subject(site, subject)
            if not ok:
                errors.append({'site': site, 'subject': subject, 'error': err})
                continue
            if not _is_super_user(super_user, site):
                errors.append({'site': site, 'subject': subject, 'error': 'Not authorized for this site'})
                continue

            processed_dir = SITES_DIR / site / subject / '_processed'
            if not processed_dir.exists():
                errors.append({'site': site, 'subject': subject, 'error': 'Subject not processed'})
                continue

            # 1. Cascade-archive rankings BEFORE archiving the subject (so
            #    the rankings know subject_still_processed=False).
            cascaded = []
            if cascade and RANKINGS_DIR.exists():
                for rfile in list(RANKINGS_DIR.glob('*.json')):
                    try:
                        with open(rfile, 'r', encoding='utf-8') as f:
                            rdata = json.load(f)
                        if rdata.get('site') == site and rdata.get('subject') == subject:
                            arch = _archive_ranking(rfile, super_user,
                                                    subject_still_processed=False)
                            rfile.unlink()
                            cascaded.append({
                                'reviewer': rdata.get('reviewer', ''),
                                'archivePath': str(arch.relative_to(VIEWER_DIR)),
                            })
                    except Exception:
                        # Don't block subject delete on individual ranking errors
                        pass

            # 2. Archive subject metadata
            try:
                archive_dir = _archive_subject(site, subject, super_user)
            except Exception as e:
                errors.append({'site': site, 'subject': subject,
                               'error': f'Archive failed: {e}'})
                continue

            # 3. Remove _processed/ directory tree (DICOM siblings preserved)
            try:
                shutil.rmtree(processed_dir)
            except Exception as e:
                errors.append({'site': site, 'subject': subject,
                               'error': f'Delete failed: {e}'})
                continue

            rel_archive = str(archive_dir.relative_to(VIEWER_DIR)) if archive_dir else None
            deleted.append({
                'site': site,
                'subject': subject,
                'archivePath': rel_archive,
                'cascadedRankings': cascaded,
            })
            _append_audit({
                'timestamp': datetime.now(timezone.utc).isoformat(),
                'super_user': super_user,
                'action': 'delete_subject',
                'site': site,
                'subject': subject,
                'archive_path': rel_archive,
                'cascade': cascade,
                'cascaded_rankings': cascaded,
            })

        self._json_response({'deleted': deleted, 'errors': errors})

    def _count_rankings_for(self, site, subject):
        """Count how many ranking files reference a given (site, subject).
        Reads JSON content rather than parsing filename to handle names
        containing underscores."""
        if not RANKINGS_DIR.exists():
            return 0
        count = 0
        for rfile in RANKINGS_DIR.glob('*.json'):
            try:
                with open(rfile, 'r', encoding='utf-8') as f:
                    d = json.load(f)
                if d.get('site') == site and d.get('subject') == subject:
                    count += 1
            except Exception:
                pass
        return count

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
