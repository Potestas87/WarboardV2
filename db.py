import sqlite3
import uuid
import json
from datetime import datetime
from werkzeug.security import generate_password_hash, check_password_hash as _check

DB_PATH = 'warboard.db'


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()
    conn.executescript('''
        CREATE TABLE IF NOT EXISTS users (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS game_sessions (
            id         TEXT PRIMARY KEY,
            name       TEXT NOT NULL,
            player1_id INTEGER REFERENCES users(id),
            player2_id INTEGER REFERENCES users(id),
            created_at TEXT DEFAULT (datetime('now')),
            last_saved TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS game_state (
            session_id TEXT PRIMARY KEY REFERENCES game_sessions(id),
            circles    TEXT NOT NULL DEFAULT '[]',
            updated_at TEXT DEFAULT (datetime('now'))
        );
    ''')
    conn.commit()
    conn.close()


# ── Users ─────────────────────────────────────────────────────────────────────

def get_user(username):
    conn = get_db()
    row = conn.execute('SELECT * FROM users WHERE username = ?', (username,)).fetchone()
    conn.close()
    return dict(row) if row else None


def create_user(username, password):
    if not username or not password:
        return False
    try:
        conn = get_db()
        conn.execute(
            'INSERT INTO users (username, password) VALUES (?, ?)',
            (username, generate_password_hash(password))
        )
        conn.commit()
        conn.close()
        return True
    except sqlite3.IntegrityError:
        return False


def verify_password(hashed, password):
    return _check(hashed, password)


# ── Sessions ──────────────────────────────────────────────────────────────────

def get_sessions():
    conn = get_db()
    rows = conn.execute('''
        SELECT gs.*,
               u1.username AS player1_name,
               u2.username AS player2_name
        FROM game_sessions gs
        LEFT JOIN users u1 ON gs.player1_id = u1.id
        LEFT JOIN users u2 ON gs.player2_id = u2.id
        ORDER BY gs.last_saved DESC
    ''').fetchall()
    conn.close()
    return [dict(r) for r in rows]


def create_session(name, player1_id):
    sess_id = str(uuid.uuid4())
    conn = get_db()
    conn.execute(
        'INSERT INTO game_sessions (id, name, player1_id) VALUES (?, ?, ?)',
        (sess_id, name, player1_id)
    )
    conn.execute(
        'INSERT INTO game_state (session_id, circles) VALUES (?, ?)',
        (sess_id, '[]')
    )
    conn.commit()
    conn.close()
    return sess_id


def get_session(session_id):
    conn = get_db()
    row = conn.execute('''
        SELECT gs.*,
               u1.username AS player1_name,
               u2.username AS player2_name
        FROM game_sessions gs
        LEFT JOIN users u1 ON gs.player1_id = u1.id
        LEFT JOIN users u2 ON gs.player2_id = u2.id
        WHERE gs.id = ?
    ''', (session_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def add_player_to_session(session_id, player_id):
    conn = get_db()
    conn.execute(
        'UPDATE game_sessions SET player2_id = ? WHERE id = ? AND player2_id IS NULL',
        (player_id, session_id)
    )
    conn.commit()
    conn.close()


# ── Game state ────────────────────────────────────────────────────────────────

def get_game_state(session_id):
    conn = get_db()
    row = conn.execute(
        'SELECT circles FROM game_state WHERE session_id = ?', (session_id,)
    ).fetchone()
    conn.close()
    if row:
        return {'circles': json.loads(row['circles'])}
    return {'circles': []}


def save_game_state(session_id, state):
    now = datetime.now().isoformat()
    conn = get_db()
    conn.execute(
        'UPDATE game_state SET circles = ?, updated_at = ? WHERE session_id = ?',
        (json.dumps(state.get('circles', [])), now, session_id)
    )
    conn.execute(
        'UPDATE game_sessions SET last_saved = ? WHERE id = ?',
        (now, session_id)
    )
    conn.commit()
    conn.close()
