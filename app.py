import os
import random
from flask import Flask, render_template, request, session, redirect, url_for, flash
from flask_socketio import SocketIO, emit, join_room
import db as database

app = Flask(__name__)
app.config['SECRET_KEY'] = 'warboard-v2-secret-key-change-in-prod'
socketio = SocketIO(app, cors_allowed_origins='*')

# Physical board dimensions in millimetres (72 × 48 inches)
BOARD_W_MM = 72 * 25.4   # 1828.8 mm
BOARD_H_MM = 48 * 25.4   # 1219.2 mm


# ── Auth routes ───────────────────────────────────────────────────────────────

@app.route('/')
def index():
    if 'user_id' not in session:
        return redirect(url_for('login'))
    return redirect(url_for('lobby'))


@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        action   = request.form.get('action')
        username = request.form.get('username', '').strip()
        password = request.form.get('password', '').strip()

        if action == 'register':
            if database.create_user(username, password):
                user = database.get_user(username)
                session['user_id']  = user['id']
                session['username'] = user['username']
                return redirect(url_for('lobby'))
            flash('Username already taken.')

        elif action == 'login':
            user = database.get_user(username)
            if user and database.verify_password(user['password'], password):
                session['user_id']  = user['id']
                session['username'] = user['username']
                return redirect(url_for('lobby'))
            flash('Invalid username or password.')

    return render_template('login.html')


@app.route('/guest_login')
def guest_login():
    """One-click login for local testing — no credentials required."""
    username = 'Guest'
    if not database.get_user(username):
        database.create_user(username, 'guest')
    user = database.get_user(username)
    session['user_id']  = user['id']
    session['username'] = user['username']
    return redirect(url_for('lobby'))


@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('login'))


# ── Lobby routes ──────────────────────────────────────────────────────────────

@app.route('/lobby')
def lobby():
    if 'user_id' not in session:
        return redirect(url_for('login'))
    sessions = database.get_sessions()
    return render_template('lobby.html', sessions=sessions, username=session['username'])


@app.route('/create_session', methods=['POST'])
def create_session_route():
    if 'user_id' not in session:
        return redirect(url_for('login'))
    name    = request.form.get('name', 'New Game').strip() or 'New Game'
    sess_id = database.create_session(name, session['user_id'])
    return redirect(url_for('game', session_id=sess_id))


@app.route('/join_session/<session_id>')
def join_session(session_id):
    if 'user_id' not in session:
        return redirect(url_for('login'))

    gs = database.get_session(session_id)
    if not gs:
        flash('Session not found.')
        return redirect(url_for('lobby'))

    uid = session['user_id']
    # Already in session
    if gs['player1_id'] == uid or gs['player2_id'] == uid:
        return redirect(url_for('game', session_id=session_id))

    # Join as player 2 if slot is open
    if gs['player2_id'] is None:
        database.add_player_to_session(session_id, uid)
        return redirect(url_for('game', session_id=session_id))

    flash('Session is full (2 players max).')
    return redirect(url_for('lobby'))


# ── Game route ────────────────────────────────────────────────────────────────

@app.route('/game/<session_id>')
def game(session_id):
    if 'user_id' not in session:
        return redirect(url_for('login'))

    gs = database.get_session(session_id)
    if not gs:
        flash('Session not found.')
        return redirect(url_for('lobby'))

    uid = session['user_id']
    if gs['player1_id'] != uid and gs['player2_id'] != uid:
        flash('You are not part of this session.')
        return redirect(url_for('lobby'))

    return render_template(
        'game.html',
        game_session=gs,
        username=session['username'],
        board_w_mm=BOARD_W_MM,
        board_h_mm=BOARD_H_MM,
    )


# ── SocketIO events ───────────────────────────────────────────────────────────

@socketio.on('join')
def on_join(data):
    sid = data['session_id']
    join_room(sid)
    state = database.get_game_state(sid)
    # Initialise active_turn to player1 on first join
    if not state.get('active_turn'):
        gs = database.get_session(sid)
        if gs and gs['player1_name']:
            state['active_turn'] = gs['player1_name']
            database.save_game_state(sid, state)
    emit('state_sync', state)


@socketio.on('end_turn')
def on_end_turn(data):
    sid = data['session_id']
    state = database.get_game_state(sid)
    gs    = database.get_session(sid)
    if not gs:
        return
    p1 = gs['player1_name']
    p2 = gs['player2_name']
    # Toggle between the two players; if p2 doesn't exist yet, stay on p1
    current = state.get('active_turn')
    if p2:
        state['active_turn'] = p2 if current == p1 else p1
    database.save_game_state(sid, state)
    emit('turn_changed', {'active_turn': state['active_turn']}, room=sid)


@socketio.on('add_circles')
def on_add_circles(data):
    sid        = data['session_id']
    new_circles = data['circles']

    state = database.get_game_state(sid)
    state['circles'].extend(new_circles)
    database.save_game_state(sid, state)

    emit('circles_added', {'circles': new_circles}, room=sid, include_self=False)


@socketio.on('move_circle')
def on_move_circle(data):
    sid       = data['session_id']
    circle_id = data['circle_id']
    x_mm      = data['x_mm']
    y_mm      = data['y_mm']

    state = database.get_game_state(sid)
    for c in state['circles']:
        if c['id'] == circle_id:
            c['x_mm'] = x_mm
            c['y_mm'] = y_mm
            break
    database.save_game_state(sid, state)

    emit('circle_moved',
         {'circle_id': circle_id, 'x_mm': x_mm, 'y_mm': y_mm},
         room=sid, include_self=False)


@socketio.on('delete_circle')
def on_delete_circle(data):
    sid       = data['session_id']
    circle_id = data['circle_id']

    state = database.get_game_state(sid)
    state['circles'] = [c for c in state['circles'] if c['id'] != circle_id]
    database.save_game_state(sid, state)

    emit('circle_deleted', {'circle_id': circle_id}, room=sid)


@socketio.on('roll_dice')
def on_roll_dice(data):
    sid      = data.get('session_id', '')
    num_dice = max(1, min(200, int(data.get('num_dice', 1))))
    results  = [random.randint(1, 6) for _ in range(num_dice)]
    counts   = {str(i): results.count(i) for i in range(1, 7)}
    emit('dice_result',
         {'counts': counts, 'total': sum(results), 'num_dice': num_dice},
         room=sid)


@socketio.on('update_hp')
def on_update_hp(data):
    sid       = data['session_id']
    circle_id = data['circle_id']
    hp        = max(0, int(data['hp']))

    state = database.get_game_state(sid)
    for c in state['circles']:
        if c['id'] == circle_id:
            c['hp'] = hp
            break
    database.save_game_state(sid, state)

    emit('hp_updated', {'circle_id': circle_id, 'hp': hp},
         room=sid, include_self=False)


@socketio.on('save_state')
def on_save_state(data):
    sid   = data['session_id']
    state = database.get_game_state(sid)
    database.save_game_state(sid, state)
    emit('state_saved', {'message': 'Game saved successfully.'})


if __name__ == '__main__':
    database.init_db()
    port = int(os.environ.get('PORT', 5001))
    socketio.run(app, debug=True, port=port, allow_unsafe_werkzeug=True)
