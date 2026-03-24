import sqlite3
import uuid
import json
from datetime import datetime

DB_PATH = 'warboard.db'


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
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


# ── Sessions ──────────────────────────────────────────────────────────────────

def get_sessions():
    conn = get_db()
    rows = conn.execute(
        'SELECT * FROM game_sessions ORDER BY last_saved DESC'
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def create_session(name, player1_name, lobby_type='open', password=None):
    sess_id = str(uuid.uuid4())
    conn = get_db()
    conn.execute(
        'INSERT INTO game_sessions (id, name, player1_name, lobby_type, password) VALUES (?, ?, ?, ?, ?)',
        (sess_id, name, player1_name, lobby_type, password)
    )
    conn.execute(
        'INSERT INTO game_state (session_id, state_json) VALUES (?, ?)',
        (sess_id, json.dumps({'circles': []}))
    )
    conn.commit()
    conn.close()
    return sess_id


def get_session(session_id):
    conn = get_db()
    row = conn.execute(
        'SELECT * FROM game_sessions WHERE id = ?', (session_id,)
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def add_player_to_session(session_id, player2_name):
    conn = get_db()
    conn.execute(
        'UPDATE game_sessions SET player2_name = ? WHERE id = ? AND player2_name IS NULL',
        (player2_name, session_id)
    )
    conn.commit()
    conn.close()


# ── Game state ────────────────────────────────────────────────────────────────

def get_game_state(session_id):
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


def save_game_state(session_id, state):
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
