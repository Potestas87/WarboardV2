import sqlite3
import uuid
import json
import logging
from datetime import datetime, timedelta

DB_PATH = 'warboard.db'
log = logging.getLogger('warboard.db')


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    try:
        conn = get_db()

        # Migrate from old schema (player1_id integer FK) to new (player1_name text)
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

        # Add lobby_type/password columns to existing DBs that predate step 2
        try:
            conn.execute('SELECT lobby_type FROM game_sessions LIMIT 1')
        except Exception:
            conn.execute("ALTER TABLE game_sessions ADD COLUMN lobby_type TEXT DEFAULT 'open'")
            conn.execute('ALTER TABLE game_sessions ADD COLUMN password TEXT')

        conn.commit()
        conn.close()
        log.info('Database initialised at %s', DB_PATH)
    except Exception:
        log.exception('Failed to initialise database')
        raise


# ── Sessions ──────────────────────────────────────────────────────────────────

def get_sessions():
    try:
        conn = get_db()
        rows = conn.execute(
            'SELECT * FROM game_sessions ORDER BY last_saved DESC'
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]
    except Exception:
        log.exception('get_sessions failed')
        return []


def create_session(name, player1_name, lobby_type='open', password=None):
    try:
        sess_id = str(uuid.uuid4())
        conn = get_db()
        conn.execute(
            'INSERT INTO game_sessions (id, name, player1_name, lobby_type, password) VALUES (?, ?, ?, ?, ?)',
            (sess_id, name, player1_name, lobby_type, password)
        )
        conn.execute(
            'INSERT INTO game_state (session_id, state_json) VALUES (?, ?)',
            (sess_id, json.dumps({'circles': [], 'squares': [], 'phase': 'setup'}))
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
        conn = get_db()
        row = conn.execute(
            'SELECT * FROM game_sessions WHERE id = ?', (session_id,)
        ).fetchone()
        conn.close()
        return dict(row) if row else None
    except Exception:
        log.exception('get_session failed for %s', session_id)
        return None


def add_player_to_session(session_id, player2_name):
    try:
        conn = get_db()
        conn.execute(
            'UPDATE game_sessions SET player2_name = ? WHERE id = ? AND player2_name IS NULL',
            (player2_name, session_id)
        )
        conn.commit()
        conn.close()
    except Exception:
        log.exception('add_player_to_session failed for %s', session_id)


# ── Game state ────────────────────────────────────────────────────────────────

def get_game_state(session_id):
    try:
        conn = get_db()
        row = conn.execute(
            'SELECT state_json FROM game_state WHERE session_id = ?', (session_id,)
        ).fetchone()
        conn.close()
        if row:
            state = json.loads(row['state_json'])
            if 'circles' not in state:
                state['circles'] = []
            if 'squares' not in state:
                state['squares'] = []
            if 'phase' not in state:
                state['phase'] = 'setup'
            return state
        return {'circles': [], 'squares': [], 'phase': 'setup'}
    except Exception:
        log.exception('get_game_state failed for %s', session_id)
        return {'circles': [], 'squares': [], 'phase': 'setup'}


def save_game_state(session_id, state):
    try:
        now = datetime.now().isoformat()
        conn = get_db()
        conn.execute(
            'INSERT OR REPLACE INTO game_state (session_id, state_json, updated_at) VALUES (?, ?, ?)',
            (session_id, json.dumps(state), now)
        )
        conn.execute(
            'UPDATE game_sessions SET last_saved = ? WHERE id = ?',
            (now, session_id)
        )
        conn.commit()
        conn.close()
    except Exception:
        log.exception('save_game_state failed for %s', session_id)


# ── Cleanup ───────────────────────────────────────────────────────────────────

def cleanup_old_sessions(hours=48, days=None):
    """Delete sessions inactive for more than `hours` hours (or `days` days). Returns count deleted."""
    try:
        if days is not None:
            delta = timedelta(days=days)
        else:
            delta = timedelta(hours=hours)
        cutoff = (datetime.now() - delta).isoformat()
        conn = get_db()
        cur = conn.execute(
            'DELETE FROM game_sessions WHERE last_saved < ?', (cutoff,)
        )
        # Clean up orphaned game_state rows (no FK cascade in SQLite by default)
        conn.execute(
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
