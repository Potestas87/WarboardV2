import os
import random
import logging
from flask import Flask, render_template, request, session, redirect, url_for, flash
from flask_socketio import SocketIO, emit, join_room, disconnect
from werkzeug.security import generate_password_hash, check_password_hash
import db as database

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
)
log = logging.getLogger('warboard')

app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'warboard-dev-key-change-in-prod')

# ── CORS ──────────────────────────────────────────────────────────────────────
_raw_origins = os.environ.get('CORS_ORIGINS', 'http://localhost:5001')
ALLOWED_ORIGINS = [o.strip() for o in _raw_origins.split(',') if o.strip()]

socketio = SocketIO(app, cors_allowed_origins=ALLOWED_ORIGINS)

# Physical board dimensions in millimetres (72 × 48 inches)
BOARD_W_MM = 72 * 25.4   # 1828.8 mm
BOARD_H_MM = 48 * 25.4   # 1219.2 mm


# ── Auth routes ───────────────────────────────────────────────────────────────

@app.route('/')
def index():
    if 'username' not in session:
        return redirect(url_for('login'))
    return redirect(url_for('lobby'))


@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        username = request.form.get('username', '').strip()[:40]
        if username:
            session['username'] = username
            log.info('User logged in: %s', username)
            return redirect(url_for('lobby'))
        flash('Please enter a display name.')
    return render_template('login.html')


@app.route('/guest_login')
def guest_login():
    """One-click login for local testing — no credentials required."""
    session['username'] = 'Guest'
    log.info('Guest login used')
    return redirect(url_for('lobby'))


@app.route('/logout')
def logout():
    uname = session.get('username', 'unknown')
    session.clear()
    log.info('User logged out: %s', uname)
    return redirect(url_for('login'))


# ── Lobby routes ──────────────────────────────────────────────────────────────

@app.route('/lobby')
def lobby():
    if 'username' not in session:
        return redirect(url_for('login'))
    uname = session['username']
    all_sessions = database.get_sessions()
    sessions = [
        s for s in all_sessions
        if s['player2_name'] is None
        or s['player1_name'] == uname
        or s['player2_name'] == uname
    ]
    return render_template('lobby.html', sessions=sessions, username=uname)


@app.route('/create_session', methods=['POST'])
def create_session_route():
    if 'username' not in session:
        return redirect(url_for('login'))
    name       = request.form.get('name', 'New Game').strip()[:60] or 'New Game'
    lobby_type = request.form.get('lobby_type', 'open')
    password   = request.form.get('password', '').strip() or None
    if lobby_type != 'locked':
        password = None
    pw_hash = generate_password_hash(password) if password else None
    sess_id = database.create_session(name, session['username'], lobby_type, pw_hash)
    log.info('Session created: %s by %s (type=%s)', sess_id, session['username'], lobby_type)
    return redirect(url_for('game', session_id=sess_id))


@app.route('/join_session/<session_id>')
def join_session(session_id):
    if 'username' not in session:
        return redirect(url_for('login'))

    gs = database.get_session(session_id)
    if not gs:
        flash('Session not found.')
        return redirect(url_for('lobby'))

    uname = session['username']
    if gs['player1_name'] == uname or gs['player2_name'] == uname:
        return redirect(url_for('game', session_id=session_id))

    if gs['player2_name'] is not None:
        flash('Session is full (2 players max).')
        return redirect(url_for('lobby'))

    # Block joining games already in active phase
    state = database.get_game_state(session_id)
    if state.get('phase') == 'active':
        flash('That game has already started.')
        return redirect(url_for('lobby'))

    if gs['lobby_type'] == 'locked':
        return redirect(url_for('join_locked', session_id=session_id))

    database.add_player_to_session(session_id, uname)
    log.info('Player %s joined session %s', uname, session_id)
    return redirect(url_for('game', session_id=session_id))


@app.route('/join_locked/<session_id>', methods=['GET', 'POST'])
def join_locked(session_id):
    if 'username' not in session:
        return redirect(url_for('login'))

    gs = database.get_session(session_id)
    if not gs:
        flash('Session not found.')
        return redirect(url_for('lobby'))

    uname = session['username']
    if gs['player1_name'] == uname or gs['player2_name'] == uname:
        return redirect(url_for('game', session_id=session_id))

    if request.method == 'POST':
        entered = request.form.get('password', '').strip()
        stored  = gs.get('password') or ''
        # Support both hashed (new) and plain-text (legacy) passwords
        try:
            pw_ok = check_password_hash(stored, entered)
        except Exception:
            pw_ok = (entered == stored)
        if pw_ok:
            database.add_player_to_session(session_id, uname)
            log.info('Player %s joined locked session %s', uname, session_id)
            return redirect(url_for('game', session_id=session_id))
        flash('Incorrect password.')

    return render_template('join_locked.html', game_session=gs)


# ── Game route ────────────────────────────────────────────────────────────────

@app.route('/game/<session_id>')
def game(session_id):
    if 'username' not in session:
        return redirect(url_for('login'))

    gs = database.get_session(session_id)
    if not gs:
        flash('Session not found.')
        return redirect(url_for('lobby'))

    uname = session['username']
    if gs['player1_name'] != uname and gs['player2_name'] != uname:
        flash('You are not part of this session.')
        return redirect(url_for('lobby'))

    return render_template(
        'game.html',
        game_session=gs,
        username=session['username'],
        board_w_mm=BOARD_W_MM,
        board_h_mm=BOARD_H_MM,
    )


# ── Health check ──────────────────────────────────────────────────────────────

@app.route('/health')
def health():
    return {'status': 'ok'}, 200


# ── SEO: robots.txt & sitemap ──────────────────────────────────────────────────

@app.route('/robots.txt')
def robots_txt():
    host = request.host_url.rstrip('/')
    content = f"""User-agent: *
Allow: /
Disallow: /game/
Disallow: /lobby
Disallow: /admin/

Sitemap: {host}/sitemap.xml
"""
    from flask import Response
    return Response(content, mimetype='text/plain')


@app.route('/sitemap.xml')
def sitemap_xml():
    from flask import Response
    host = request.host_url.rstrip('/')
    content = f"""<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>{host}/login</loc>
    <changefreq>monthly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
"""
    return Response(content, mimetype='application/xml')


# ── SocketIO helpers ──────────────────────────────────────────────────────────

def _get_session_username():
    """Return the authenticated username for the current socket connection."""
    return session.get('username')


def _assert_player_in_session(sid, username):
    """Return the game session if username is a player, else None."""
    if not username:
        return None
    gs = database.get_session(sid)
    if not gs:
        return None
    if gs['player1_name'] != username and gs['player2_name'] != username:
        log.warning('Unauthorised socket action: user=%s session=%s', username, sid)
        return None
    return gs


# ── SocketIO events ───────────────────────────────────────────────────────────

@socketio.on('join')
def on_join(data):
    try:
        sid = data['session_id']
        username = _get_session_username()
        gs = _assert_player_in_session(sid, username)
        if not gs:
            return
        join_room(sid)
        state = database.get_game_state(sid)
        if not state.get('active_turn'):
            if gs['player1_name']:
                state['active_turn'] = gs['player1_name']
                database.save_game_state(sid, state)
        emit('state_sync', state)
        emit('player_joined', {'username': username}, room=sid, include_self=False)
        log.info('Player %s joined room %s', username, sid)
    except Exception:
        log.exception('Error in on_join')


@socketio.on('disconnect')
def on_disconnect():
    try:
        username = _get_session_username()
        log.info('Socket disconnect: user=%s', username)
        # Notify all rooms the player was in (Flask-SocketIO handles room cleanup)
    except Exception:
        log.exception('Error in on_disconnect')


@socketio.on('end_turn')
def on_end_turn(data):
    try:
        sid = data['session_id']
        username = _get_session_username()
        gs = _assert_player_in_session(sid, username)
        if not gs:
            return
        state = database.get_game_state(sid)
        p1 = gs['player1_name']
        p2 = gs['player2_name']
        current = state.get('active_turn')
        if current != username:
            return  # not your turn
        if p2:
            state['active_turn'] = p2 if current == p1 else p1
        database.save_game_state(sid, state)
        emit('turn_changed', {'active_turn': state['active_turn']}, room=sid)
        log.info('Turn ended in session %s, now %s', sid, state['active_turn'])
    except Exception:
        log.exception('Error in on_end_turn')


@socketio.on('add_circles')
def on_add_circles(data):
    try:
        sid         = data['session_id']
        new_circles = data['circles']
        username    = _get_session_username()
        if not _assert_player_in_session(sid, username):
            return
        if not isinstance(new_circles, list) or len(new_circles) > 50:
            return
        # Sanitise each circle
        safe = []
        for c in new_circles:
            if not isinstance(c, dict):
                continue
            safe.append({
                'id':        str(c.get('id', ''))[:36],
                'x_mm':      float(c.get('x_mm', 0)),
                'y_mm':      float(c.get('y_mm', 0)),
                'radius_mm': max(0.5, min(500, float(c.get('radius_mm', 10)))),
                'title':     str(c.get('title', ''))[:30],
                'color':     str(c.get('color', '#ffffff'))[:9],
                'created_by': username,
                **({'hp': max(0, int(c['hp']))} if 'hp' in c else {}),
            })
        state = database.get_game_state(sid)
        state['circles'].extend(safe)
        database.save_game_state(sid, state)
        emit('circles_added', {'circles': safe}, room=sid, include_self=False)
    except Exception:
        log.exception('Error in on_add_circles')


@socketio.on('move_circle')
def on_move_circle(data):
    try:
        sid       = data['session_id']
        circle_id = str(data['circle_id'])[:36]
        x_mm      = max(0, min(BOARD_W_MM, float(data['x_mm'])))
        y_mm      = max(0, min(BOARD_H_MM, float(data['y_mm'])))
        username  = _get_session_username()
        if not _assert_player_in_session(sid, username):
            return
        state = database.get_game_state(sid)
        for c in state['circles']:
            if c['id'] == circle_id:
                c['x_mm'] = x_mm
                c['y_mm'] = y_mm
                break
        database.save_game_state(sid, state)
        emit('circle_moved', {'circle_id': circle_id, 'x_mm': x_mm, 'y_mm': y_mm},
             room=sid, include_self=False)
    except Exception:
        log.exception('Error in on_move_circle')


@socketio.on('delete_circle')
def on_delete_circle(data):
    try:
        sid       = data['session_id']
        circle_id = str(data['circle_id'])[:36]
        username  = _get_session_username()
        if not _assert_player_in_session(sid, username):
            return
        state = database.get_game_state(sid)
        state['circles'] = [c for c in state['circles'] if c['id'] != circle_id]
        database.save_game_state(sid, state)
        emit('circle_deleted', {'circle_id': circle_id}, room=sid)
    except Exception:
        log.exception('Error in on_delete_circle')


@socketio.on('roll_dice')
def on_roll_dice(data):
    try:
        sid      = data.get('session_id', '')
        username = _get_session_username()
        if not _assert_player_in_session(sid, username):
            return
        num_dice = max(1, min(200, int(data.get('num_dice', 1))))
        results  = [random.randint(1, 6) for _ in range(num_dice)]
        counts   = {str(i): results.count(i) for i in range(1, 7)}
        emit('dice_result', {'counts': counts, 'total': sum(results), 'num_dice': num_dice},
             room=sid)
    except Exception:
        log.exception('Error in on_roll_dice')


@socketio.on('update_hp')
def on_update_hp(data):
    try:
        sid       = data['session_id']
        circle_id = str(data['circle_id'])[:36]
        hp        = max(0, int(data['hp']))
        username  = _get_session_username()
        if not _assert_player_in_session(sid, username):
            return
        state = database.get_game_state(sid)
        for c in state['circles']:
            if c['id'] == circle_id:
                c['hp'] = hp
                break
        database.save_game_state(sid, state)
        emit('hp_updated', {'circle_id': circle_id, 'hp': hp},
             room=sid, include_self=False)
    except Exception:
        log.exception('Error in on_update_hp')


@socketio.on('add_squares')
def on_add_squares(data):
    try:
        sid         = data['session_id']
        new_squares = data['squares']
        username    = _get_session_username()
        gs = _assert_player_in_session(sid, username)
        if not gs:
            return
        if not isinstance(new_squares, list) or len(new_squares) > 20:
            return
        state = database.get_game_state(sid)
        if state.get('phase') != 'setup':
            return  # terrain locked after game starts
        safe = []
        for s in new_squares:
            if not isinstance(s, dict):
                continue
            safe.append({
                'id':         str(s.get('id', ''))[:36],
                'x_mm':       float(s.get('x_mm', 0)),
                'y_mm':       float(s.get('y_mm', 0)),
                'width_mm':   max(1, min(1828.8, float(s.get('width_mm', 25.4)))),
                'height_mm':  max(1, min(1219.2, float(s.get('height_mm', 25.4)))),
                'name':       str(s.get('name', ''))[:30],
                'elevation':  int(s.get('elevation', 0)),
                'created_by': username,
            })
        state['squares'].extend(safe)
        database.save_game_state(sid, state)
        emit('squares_added', {'squares': safe}, room=sid, include_self=False)
    except Exception:
        log.exception('Error in on_add_squares')


@socketio.on('move_square')
def on_move_square(data):
    try:
        sid       = data['session_id']
        square_id = str(data['square_id'])[:36]
        x_mm      = max(0, min(BOARD_W_MM, float(data['x_mm'])))
        y_mm      = max(0, min(BOARD_H_MM, float(data['y_mm'])))
        username  = _get_session_username()
        gs = _assert_player_in_session(sid, username)
        if not gs:
            return
        state = database.get_game_state(sid)
        if state.get('phase') != 'setup':
            return
        for s in state.get('squares', []):
            if s['id'] == square_id:
                s['x_mm'] = x_mm
                s['y_mm'] = y_mm
                break
        database.save_game_state(sid, state)
        emit('square_moved', {'square_id': square_id, 'x_mm': x_mm, 'y_mm': y_mm},
             room=sid, include_self=False)
    except Exception:
        log.exception('Error in on_move_square')


@socketio.on('delete_square')
def on_delete_square(data):
    try:
        sid       = data['session_id']
        square_id = str(data['square_id'])[:36]
        username  = _get_session_username()
        gs = _assert_player_in_session(sid, username)
        if not gs:
            return
        state = database.get_game_state(sid)
        if state.get('phase') != 'setup':
            return
        state['squares'] = [s for s in state.get('squares', []) if s['id'] != square_id]
        database.save_game_state(sid, state)
        emit('square_deleted', {'square_id': square_id}, room=sid)
    except Exception:
        log.exception('Error in on_delete_square')


@socketio.on('start_game')
def on_start_game(data):
    try:
        sid      = data['session_id']
        username = _get_session_username()
        gs = _assert_player_in_session(sid, username)
        if not gs:
            return
        if gs['player1_name'] != username:
            return  # only player1 can start
        state = database.get_game_state(sid)
        state['phase'] = 'active'
        database.save_game_state(sid, state)
        emit('game_started', {}, room=sid)
        log.info('Game started in session %s by %s', sid, username)
    except Exception:
        log.exception('Error in on_start_game')


@socketio.on('reset_game')
def on_reset_game(data):
    try:
        sid      = data['session_id']
        username = _get_session_username()
        gs = _assert_player_in_session(sid, username)
        if not gs:
            return
        if gs['player1_name'] != username:
            return  # only player1 can reset
        gs_fresh = database.get_session(sid)
        state = {
            'circles':    [],
            'squares':    [],
            'phase':      'setup',
            'active_turn': gs_fresh['player1_name'] if gs_fresh else None,
        }
        database.save_game_state(sid, state)
        emit('game_reset', state, room=sid)
        log.info('Game reset in session %s by %s', sid, username)
    except Exception:
        log.exception('Error in on_reset_game')


@socketio.on('ping_board')
def on_ping_board(data):
    try:
        sid      = data['session_id']
        username = _get_session_username()
        if not _assert_player_in_session(sid, username):
            return
        x_mm = max(0, min(BOARD_W_MM, float(data['x_mm'])))
        y_mm = max(0, min(BOARD_H_MM, float(data['y_mm'])))
        emit('ping_received', {'x_mm': x_mm, 'y_mm': y_mm}, room=sid, include_self=False)
    except Exception:
        log.exception('Error in on_ping_board')


@socketio.on('chat_message')
def on_chat_message(data):
    try:
        sid      = data['session_id']
        username = _get_session_username()   # authoritative — ignore client-supplied name
        if not _assert_player_in_session(sid, username):
            return
        message = str(data.get('message', '')).strip()[:200]
        if message:
            emit('chat_received', {'username': username, 'message': message}, room=sid)
    except Exception:
        log.exception('Error in on_chat_message')


@socketio.on('save_state')
def on_save_state(data):
    try:
        sid      = data['session_id']
        username = _get_session_username()
        if not _assert_player_in_session(sid, username):
            return
        state = database.get_game_state(sid)
        database.save_game_state(sid, state)
        emit('state_saved', {'message': 'Game saved successfully.'})
        log.info('State saved for session %s by %s', sid, username)
    except Exception:
        log.exception('Error in on_save_state')


# ── Session cleanup ───────────────────────────────────────────────────────────

@app.route('/admin/cleanup', methods=['POST'])
def admin_cleanup():
    """Remove sessions older than 7 days with no activity. Local use only."""
    if not app.debug and os.environ.get('ADMIN_KEY') != request.form.get('key'):
        return {'error': 'forbidden'}, 403
    count = database.cleanup_old_sessions(days=7)
    log.info('Cleaned up %d old sessions', count)
    return {'deleted': count}, 200


if __name__ == '__main__':
    database.init_db()
    port       = int(os.environ.get('PORT', 5001))
    debug_mode = os.environ.get('DEBUG', 'true').lower() == 'true'
    socketio.run(app, debug=debug_mode, port=port,
                 allow_unsafe_werkzeug=debug_mode)  # safe: only enabled when debug=True
