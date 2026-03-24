import os
import uuid
import json
import logging
from datetime import datetime, timedelta

log = logging.getLogger('warboard.db')

# ── Database backend detection ─────────────────────────────────────────────────
# Railway (and most PaaS providers) injects DATABASE_URL automatically.
# If it is present we use PostgreSQL; otherwise we fall back to local SQLite.

_DATABASE_URL = os.environ.get('DATABASE_URL', '')

# Normalize Railway's legacy postgres:// scheme to the psycopg2-compatible form
if _DATABASE_URL.startswith('postgres://'):
    _DATABASE_URL = _DATABASE_URL.replace('postgres://', 'postgresql://', 1)

_USE_PG = bool(_DATABASE_URL)

if _USE_PG:
    import psycopg2
    import psycopg2.extras
    _PH = '%s'   # PostgreSQL placeholder
    log.info('Database backend: PostgreSQL')
else:
    import sqlite3
    _PH = '?'    # SQLite placeholder
    _DB_PATH = os.environ.get('DB_PATH', 'warboard.db')
    log.info('Database backend: SQLite at %s', _DB_PATH)


# ── Connection factory ─────────────────────────────────────────────────────────

def _get_conn():
    if _USE_PG:
        return psycopg2.connect(_DATABASE_URL)
    conn = sqlite3.connect(_DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


# ── Query helpers (abstract away SQLite vs psycopg2 cursor differences) ────────

def _execute(conn, sql, params=()):
    """Execute a DML/DDL statement; returns the cursor."""
    if _USE_PG:
        cur = conn.cursor()
        cur.execute(sql, params)
        return cur
    return conn.execute(sql, params)


def _fetchall(conn, sql, params=()):
    """Execute SELECT; return list of plain dicts."""
    if _USE_PG:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(sql, params)
        return [dict(r) for r in cur.fetchall()]
    return [dict(r) for r in conn.execute(sql, params).fetchall()]


def _fetchone(conn, sql, params=()):
    """Execute SELECT; return single dict or None."""
    if _USE_PG:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(sql, params)
        row = cur.fetchone()
        return dict(row) if row else None
    row = conn.execute(sql, params).fetchone()
    return dict(row) if row else None


# ── Schema initialisation ──────────────────────────────────────────────────────

def init_db():
    try:
        conn = _get_conn()
        if _USE_PG:
            _init_pg(conn)
        else:
            _init_sqlite(conn)
        conn.commit()
        conn.close()
        log.info('Database initialised')
    except Exception:
        log.exception('Failed to initialise database')
        raise


def _init_sqlite(conn):
    # Migrate from old schema (player1_id integer FK) → new (player1_name text)
    try:
        conn.execute('SELECT player1_name FROM game_sessions LIMIT 1')
    except Exception:
        conn.executescript('''
            DROP TABLE IF EXISTS game_state;
            DROP TABLE IF EXISTS game_sessions;
            DROP TABLE IF EXISTS users;
        ''')

    conn.executescript('''
        CREATE TABLE IF NOT EXISTS game_sessions (
            id           TEXT PRIMARY KEY,
            name         TEXT NOT NULL,
            player1_name TEXT,
            player2_name TEXT,
            lobby_type   TEXT DEFAULT 'open',
            password     TEXT,
            created_at   TEXT DEFAULT (datetime('now')),
            last_saved   TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS game_state (
            session_id TEXT PRIMARY KEY REFERENCES game_sessions(id),
            state_json TEXT NOT NULL DEFAULT '{}',
            updated_at TEXT DEFAULT (datetime('now'))
        );
    ''')

    # Add lobby_type / password columns to DBs created before the lobby system
    try:
        conn.execute('SELECT lobby_type FROM game_sessions LIMIT 1')
    except Exception:
        conn.execute("ALTER TABLE game_sessions ADD COLUMN lobby_type TEXT DEFAULT 'open'")
        conn.execute('ALTER TABLE game_sessions ADD COLUMN password TEXT')


def _init_pg(conn):
    cur = conn.cursor()
    cur.execute('''
        CREATE TABLE IF NOT EXISTS game_sessions (
            id           TEXT PRIMARY KEY,
            name         TEXT NOT NULL,
            player1_name TEXT,
            player2_name TEXT,
            lobby_type   TEXT DEFAULT 'open',
            password     TEXT,
            created_at   TEXT DEFAULT NOW()::TEXT,
            last_saved   TEXT DEFAULT NOW()::TEXT
        )
    ''')
    cur.execute('''
        CREATE TABLE IF NOT EXISTS game_state (
            session_id TEXT PRIMARY KEY REFERENCES game_sessions(id),
            state_json TEXT NOT NULL DEFAULT '{}',
            updated_at TEXT DEFAULT NOW()::TEXT
        )
    ''')
    # Add columns that may be missing from older schemas (PostgreSQL supports IF NOT EXISTS)
    cur.execute("ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS lobby_type TEXT DEFAULT 'open'")
    cur.execute('ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS password TEXT')


# ── Sessions ───────────────────────────────────────────────────────────────────

def get_sessions():
    try:
        conn = _get_conn()
        rows = _fetchall(conn, 'SELECT * FROM game_sessions ORDER BY last_saved DESC')
        conn.close()
        return rows
    except Exception:
        log.exception('get_sessions failed')
        return []


def create_session(name, player1_name, lobby_type='open', password=None):
    try:
        sess_id = str(uuid.uuid4())
        now = datetime.now().isoformat()
        conn = _get_conn()
        _execute(conn,
            f'INSERT INTO game_sessions (id, name, player1_name, lobby_type, password, created_at, last_saved) '
            f'VALUES ({_PH},{_PH},{_PH},{_PH},{_PH},{_PH},{_PH})',
            (sess_id, name, player1_name, lobby_type, password, now, now)
        )
        _execute(conn,
            f'INSERT INTO game_state (session_id, state_json, updated_at) VALUES ({_PH},{_PH},{_PH})',
            (sess_id, json.dumps({'circles': [], 'squares': [], 'phase': 'setup'}), now)
        )
        conn.commit()
        conn.close()
        log.info('Created session %s for player %s', sess_id, player1_name)
        return sess_id
    except Exception:
        log.exception('create_session failed')
        raise


def get_session(session_id):
    try:
        conn = _get_conn()
        row = _fetchone(conn, f'SELECT * FROM game_sessions WHERE id = {_PH}', (session_id,))
        conn.close()
        return row
    except Exception:
        log.exception('get_session failed for %s', session_id)
        return None


def add_player_to_session(session_id, player2_name):
    try:
        conn = _get_conn()
        _execute(conn,
            f'UPDATE game_sessions SET player2_name = {_PH} WHERE id = {_PH} AND player2_name IS NULL',
            (player2_name, session_id)
        )
        conn.commit()
        conn.close()
    except Exception:
        log.exception('add_player_to_session failed for %s', session_id)


# ── Game state ─────────────────────────────────────────────────────────────────

def get_game_state(session_id):
    try:
        conn = _get_conn()
        row = _fetchone(conn,
            f'SELECT state_json FROM game_state WHERE session_id = {_PH}',
            (session_id,)
        )
        conn.close()
        if row:
            state = json.loads(row['state_json'])
            state.setdefault('circles', [])
            state.setdefault('squares', [])
            state.setdefault('phase', 'setup')
            return state
        return {'circles': [], 'squares': [], 'phase': 'setup'}
    except Exception:
        log.exception('get_game_state failed for %s', session_id)
        return {'circles': [], 'squares': [], 'phase': 'setup'}


def save_game_state(session_id, state):
    try:
        now = datetime.now().isoformat()
        conn = _get_conn()
        if _USE_PG:
            _execute(conn,
                'INSERT INTO game_state (session_id, state_json, updated_at) VALUES (%s, %s, %s) '
                'ON CONFLICT (session_id) DO UPDATE SET '
                'state_json = EXCLUDED.state_json, updated_at = EXCLUDED.updated_at',
                (session_id, json.dumps(state), now)
            )
        else:
            _execute(conn,
                'INSERT OR REPLACE INTO game_state (session_id, state_json, updated_at) VALUES (?, ?, ?)',
                (session_id, json.dumps(state), now)
            )
        _execute(conn,
            f'UPDATE game_sessions SET last_saved = {_PH} WHERE id = {_PH}',
            (now, session_id)
        )
        conn.commit()
        conn.close()
    except Exception:
        log.exception('save_game_state failed for %s', session_id)


# ── Cleanup ────────────────────────────────────────────────────────────────────

def cleanup_old_sessions(hours=48, days=None):
    """Delete sessions inactive for more than `hours` hours (or `days` days).
    Returns the number of sessions deleted."""
    try:
        delta  = timedelta(days=days) if days is not None else timedelta(hours=hours)
        cutoff = (datetime.now() - delta).isoformat()
        conn   = _get_conn()
        cur    = _execute(conn,
            f'DELETE FROM game_sessions WHERE last_saved < {_PH}', (cutoff,))
        # Remove orphaned game_state rows (SQLite has no FK cascade by default)
        _execute(conn,
            'DELETE FROM game_state WHERE session_id NOT IN (SELECT id FROM game_sessions)'
        )
        count = cur.rowcount
        conn.commit()
        conn.close()
        if count:
            log.info('Cleaned up %d sessions inactive for more than %s', count, delta)
        return count
    except Exception:
        log.exception('cleanup_old_sessions failed')
        return 0
