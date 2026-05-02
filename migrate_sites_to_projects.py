#!/usr/bin/env python3
"""One-shot migration: SITES/ → PROJECTS/

For each existing top-level site under SITES/, this script:
  - Creates a new project with status='draft' (invisible to reviewers
    until the owner explicitly flips it to 'ready' via the management
    page)
  - Copies all subjects unchanged into PROJECTS/{project}/{subject}/
  - Augments each subject's manifest.json with the new `project`,
    `contributingSite`, and `anatomicalSite` fields (the latter two
    set to null — the admin will fill them in via re-edit later)
  - Copies all rankings and adds a `project` field to each
  - Copies the rankings + processed archives
  - Merges the audit log

The original SITES/ directory is left untouched — to roll back, just
delete PROJECTS/ and revert the code.

The script is idempotent: re-running skips anything already migrated,
so you can run --apply more than once safely.

Usage:
  python migrate_sites_to_projects.py            # dry run (default)
  python migrate_sites_to_projects.py --apply    # actually copy
"""

import argparse
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path


VIEWER_DIR = Path(__file__).resolve().parent
SITES_DIR = VIEWER_DIR / 'SITES'
PROJECTS_DIR = VIEWER_DIR / 'PROJECTS'
SUPER_USERS_FILE = VIEWER_DIR / '_super_users.json'

# Stats accumulator — populated as we go, printed at the end
STATS = {
    'projects_created': 0,
    'subjects_migrated': 0,
    'manifests_updated': 0,
    'rankings_migrated': 0,
    'rankings_archived': 0,
    'subjects_archived': 0,
    'audit_entries_merged': 0,
    'skipped': 0,
    'errors': 0,
}


def _load_global_super_users():
    """Read the new + legacy super-user keys; return a sorted, deduped list."""
    if not SUPER_USERS_FILE.exists():
        return []
    try:
        with open(SUPER_USERS_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
        out = set()
        for k in ('global', '*'):
            v = data.get(k, [])
            if isinstance(v, list):
                out.update(v)
        return sorted(out)
    except Exception:
        return []


def log(msg, dry_run, level='INFO'):
    prefix = '[DRY] ' if dry_run else ''
    print(f'  {prefix}{level}: {msg}')


# ─────────────────────────────────────────────────────────────────────────
# Per-component migrations
# ─────────────────────────────────────────────────────────────────────────

def migrate_subject(site, subject, project_id, dry_run):
    src = SITES_DIR / site / subject
    dst = PROJECTS_DIR / project_id / subject

    if dst.exists():
        log(f'PROJECTS/{project_id}/{subject}/ exists — skipping', dry_run, 'SKIP')
        STATS['skipped'] += 1
        return

    log(f'Copying SITES/{site}/{subject}/ → PROJECTS/{project_id}/{subject}/', dry_run)
    if not dry_run:
        shutil.copytree(src, dst)
    STATS['subjects_migrated'] += 1

    # Update manifest if present (some subjects may not be processed)
    manifest_path = dst / '_processed' / 'manifest.json'
    src_manifest_path = src / '_processed' / 'manifest.json'
    if not src_manifest_path.exists():
        log(f'No manifest.json for {subject} (unprocessed) — skipping update', dry_run, 'INFO')
        return

    if dry_run:
        log(f'Would add project/contributingSite/anatomicalSite to manifest', dry_run)
        STATS['manifests_updated'] += 1
        return

    try:
        with open(manifest_path, 'r', encoding='utf-8') as f:
            manifest = json.load(f)
        added = []
        if 'project' not in manifest:
            manifest['project'] = project_id
            added.append('project')
        if 'contributingSite' not in manifest:
            manifest['contributingSite'] = None
            added.append('contributingSite')
        if 'anatomicalSite' not in manifest:
            manifest['anatomicalSite'] = None
            added.append('anatomicalSite')
        if added:
            with open(manifest_path, 'w', encoding='utf-8') as f:
                json.dump(manifest, f, indent=2)
            log(f'manifest.json: added {added}', dry_run)
        STATS['manifests_updated'] += 1
    except Exception as e:
        log(f'WARNING: manifest update failed for {subject}: {e}', dry_run, 'WARN')
        STATS['errors'] += 1


def migrate_site_to_project(site_dir, dry_run):
    site = site_dir.name
    project_id = site  # 1:1 rename — site name becomes project ID
    project_path = PROJECTS_DIR / project_id
    config_path = project_path / '_project_config.json'

    log(f'', dry_run)
    log(f'== Site: {site}  →  Project: {project_id} ==', dry_run)

    if config_path.exists():
        log(f'_project_config.json already exists — skipping config creation', dry_run, 'SKIP')
    else:
        log(f'Creating _project_config.json (status=draft, owners from _super_users.json)', dry_run)
        owners = _load_global_super_users() or ['migration_script']
        cfg = {
            'id': project_id,
            'displayName': site,
            'description': f'(Auto-migrated from SITES/{site}/ on '
                           f'{datetime.now(timezone.utc).strftime("%Y-%m-%d")}. '
                           f'Update displayName, description, and contributingSites '
                           f'in the management page.)',
            'owners': owners,
            'contributingSites': [],
            'status': 'draft',
            'createdAt': datetime.now(timezone.utc).isoformat(),
            'createdBy': 'migration_script',
            'readyAt': None,
            'closedAt': None,
        }
        if not dry_run:
            project_path.mkdir(parents=True, exist_ok=True)
            with open(config_path, 'w', encoding='utf-8') as f:
                json.dump(cfg, f, indent=2)
        STATS['projects_created'] += 1

    for subj_dir in sorted(site_dir.iterdir()):
        if not subj_dir.is_dir() or subj_dir.name.startswith('_'):
            continue
        migrate_subject(site, subj_dir.name, project_id, dry_run)


def migrate_rankings(dry_run):
    src_dir = SITES_DIR / '_rankings'
    dst_dir = PROJECTS_DIR / '_rankings'
    if not src_dir.exists():
        log('No SITES/_rankings/ — nothing to migrate', dry_run)
        return

    if not dry_run:
        dst_dir.mkdir(parents=True, exist_ok=True)

    for rfile in sorted(src_dir.glob('*.json')):
        dst_file = dst_dir / rfile.name
        if dst_file.exists():
            log(f'PROJECTS/_rankings/{rfile.name} exists — skipping', dry_run, 'SKIP')
            STATS['skipped'] += 1
            continue
        log(f'Copying ranking {rfile.name} (+ adding project field)', dry_run)
        if not dry_run:
            try:
                with open(rfile, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                if 'project' not in data:
                    data['project'] = data.get('site', '')
                with open(dst_file, 'w', encoding='utf-8') as f:
                    json.dump(data, f, indent=2)
            except Exception as e:
                log(f'WARNING: ranking migration failed for {rfile.name}: {e}', dry_run, 'WARN')
                STATS['errors'] += 1
                continue
        STATS['rankings_migrated'] += 1


def migrate_archives(dry_run):
    # Rankings archive
    src = SITES_DIR / '_rankings' / '_archived'
    dst = PROJECTS_DIR / '_archived' / 'rankings'
    if src.exists():
        if not dry_run:
            dst.mkdir(parents=True, exist_ok=True)
        for f in sorted(src.glob('*.json')):
            df = dst / f.name
            if df.exists():
                STATS['skipped'] += 1
                continue
            log(f'Copying archived ranking {f.name}', dry_run)
            if not dry_run:
                shutil.copy2(f, df)
            STATS['rankings_archived'] += 1
    else:
        log('No SITES/_rankings/_archived/', dry_run)

    # Subjects archive
    src = SITES_DIR / '_processed_archived'
    dst = PROJECTS_DIR / '_archived' / 'subjects'
    if src.exists():
        if not dry_run:
            dst.mkdir(parents=True, exist_ok=True)
        for d in sorted(src.iterdir()):
            if not d.is_dir():
                continue
            dd = dst / d.name
            if dd.exists():
                STATS['skipped'] += 1
                continue
            log(f'Copying archived subject {d.name}', dry_run)
            if not dry_run:
                shutil.copytree(d, dd)
            STATS['subjects_archived'] += 1
    else:
        log('No SITES/_processed_archived/', dry_run)


def migrate_audit_log(dry_run):
    src = SITES_DIR / '_admin_log.json'
    dst = PROJECTS_DIR / '_admin_log.json'
    if not src.exists():
        log('No SITES/_admin_log.json — nothing to merge', dry_run)
        return

    try:
        with open(src, 'r', encoding='utf-8') as f:
            legacy = json.load(f)
        if not isinstance(legacy, list):
            legacy = []
    except Exception:
        legacy = []

    new_log = []
    if dst.exists():
        try:
            with open(dst, 'r', encoding='utf-8') as f:
                new_log = json.load(f)
            if not isinstance(new_log, list):
                new_log = []
        except Exception:
            new_log = []

    # Dedupe by timestamp+action+super_user (timestamp has ms precision so
    # collisions are essentially impossible; this is just safety in case
    # the migration is run multiple times)
    existing_keys = {
        (e.get('timestamp'), e.get('action'), e.get('super_user'), e.get('subject'))
        for e in new_log
    }

    new_count = 0
    for e in legacy:
        key = (e.get('timestamp'), e.get('action'), e.get('super_user'), e.get('subject'))
        if key in existing_keys:
            continue
        if not dry_run:
            new_log.append(e)
            existing_keys.add(key)
        new_count += 1

    log(f'Merging {new_count} legacy entries into PROJECTS/_admin_log.json', dry_run)
    STATS['audit_entries_merged'] += new_count

    if not dry_run and new_count > 0:
        new_log.sort(key=lambda e: e.get('timestamp', ''))
        PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
        with open(dst, 'w', encoding='utf-8') as f:
            json.dump(new_log, f, indent=2)


def write_migration_marker():
    """Append a single audit entry recording the migration itself."""
    log_path = PROJECTS_DIR / '_admin_log.json'
    log_data = []
    if log_path.exists():
        try:
            with open(log_path, 'r', encoding='utf-8') as f:
                log_data = json.load(f)
            if not isinstance(log_data, list):
                log_data = []
        except Exception:
            pass
    log_data.append({
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'action': 'migrate_sites_to_projects',
        'super_user': 'migration_script',
        'note': 'Migrated SITES/ → PROJECTS/. Original SITES/ left intact for rollback.',
        'stats': dict(STATS),
    })
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    with open(log_path, 'w', encoding='utf-8') as f:
        json.dump(log_data, f, indent=2)


# ─────────────────────────────────────────────────────────────────────────
# Driver
# ─────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description='Migrate SITES/ → PROJECTS/ (dry-run by default)')
    parser.add_argument('--apply', action='store_true',
                        help='actually copy files (default: dry-run only)')
    args = parser.parse_args()
    dry_run = not args.apply

    print('=' * 72)
    print('  RT Plan Viewer — SITES/ → PROJECTS/ migration')
    print(f'  Mode:        {"APPLY (writing files)" if args.apply else "DRY RUN (no writes)"}')
    print(f'  Source:      {SITES_DIR}')
    print(f'  Destination: {PROJECTS_DIR}')
    print('=' * 72)

    if not SITES_DIR.exists():
        print(f'\nNothing to migrate — {SITES_DIR} does not exist.')
        return

    # Iterate top-level site directories
    for site_dir in sorted(SITES_DIR.iterdir()):
        if not site_dir.is_dir() or site_dir.name.startswith('_'):
            continue
        migrate_site_to_project(site_dir, dry_run)

    log('', dry_run)
    log('== Rankings ==', dry_run)
    migrate_rankings(dry_run)

    log('', dry_run)
    log('== Archives ==', dry_run)
    migrate_archives(dry_run)

    log('', dry_run)
    log('== Audit log ==', dry_run)
    migrate_audit_log(dry_run)

    print('\n' + '=' * 72)
    print('  Summary')
    print('=' * 72)
    for k, v in STATS.items():
        print(f'  {k:30s} {v}')

    if dry_run:
        print('\n  (DRY RUN — no files were written. Run with --apply to commit.)')
    else:
        write_migration_marker()
        print('\n  Migration complete.')
        print(f'  Original SITES/ directory left intact for rollback.')
        print(f'  To roll back: rm -rf PROJECTS/  (or move it aside)')


if __name__ == '__main__':
    main()
