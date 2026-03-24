# Warboard V2

A real-time, browser-based tabletop war game simulator built in Python. Warboard V2 is a ground-up rebuild of an original first project — started as a simple locally-hosted board for two players on the same network, and grown into a full web application ready for cloud deployment, with a lobby system, turn management, terrain, line-of-sight detection, chat, and a security-hardened backend.

> **Intellectual Property** — Warboard V2 is the intellectual property of **Ventrysis**. All rights reserved.

---

## Origin & Evolution

The original Warboard project was a personal learning exercise: render circles on a canvas, move them around, and keep two browser windows in sync. It proved the concept worked but had no structure — one file, no persistence, no sessions, no real game logic.

Warboard V2 started with a single goal: rebuild it properly. Over successive iterations that scope expanded significantly:

| Stage | What was added |
|---|---|
| **V2 foundation** | Flask + SocketIO backend, SQLite persistence, mm-accurate canvas, zoom/pan, circle tokens with HP |
| **Multiplayer structure** | Lobby with open/locked sessions, two-player slot management, guest login |
| **Game phases** | Setup → Active phase transition, terrain placement locked on game start, turn system with End Turn |
| **Tools** | Measure tool with range ring, line-of-sight detection, Ping marker, Undo/Redo |
| **Communication** | Real-time chat panel with unread badge, player joined/left notifications, connection status indicator |
| **Security hardening** | Environment-variable config, password hashing, server-side session validation on every socket event, input sanitisation, structured logging |
| **Web readiness** | SEO meta tags, Open Graph, JSON-LD schema, robots.txt, sitemap.xml, health check endpoint, 48-hour session expiry, Ventrysis IP footer |

---

## What It Does

Warboard V2 gives two players a shared virtual board — a fully scaled 72" × 48" surface — that they can use to play miniature wargames together remotely from any browser. No downloads. No app installs. No subscription.

- **Player 1** creates a session from the lobby (open or password-locked) and places terrain during the Setup phase
- **Player 2** joins the session and both players place their units
- Player 1 clicks **Start Game** — terrain locks and turns begin
- Players alternate turns, moving units, rolling dice, tracking HP, and measuring ranges
- All changes sync in real time via WebSockets; the board state persists in the database between sessions

---

## Features

### Board & Tokens
| Feature | Description |
|---|---|
| Scaled board | 72" × 48" surface (1828 × 1219 mm) with inch grid and ruler markings |
| Circle tokens | Defined by base diameter in mm, rendered accurately to scale |
| HP Tracker | Optional per-unit HP with +/− buttons rendered directly on the token |
| Multi-copy placement | Generate multiple numbered copies of a token in one action (up to 50) |
| Terrain blocks | Rectangular terrain pieces with name and elevation, placed during Setup only |
| Drag to move | Drag any unit to reposition it; constrained to board bounds |
| Delete | Right-click any unit or terrain piece to remove it |
| Zoom & pan | Scroll to zoom toward cursor; drag empty space to pan |

### Game System
| Feature | Description |
|---|---|
| Lobby system | Create open or password-locked sessions; join from the lobby list |
| Two-player slots | Sessions support exactly two named players; full sessions show as unavailable |
| Game phases | Setup phase (terrain editable) transitions to Active phase on Start Game |
| Turn system | Players alternate turns via End Turn; active player highlighted in topbar |
| Undo / Redo | Step back or forward through your own moves during your turn (last 10 moves) |
| Reset game | Player 1 can reset the board and return to Setup at any time |
| 48-hour expiry | Sessions inactive for more than 48 hours are automatically deleted |

### Tools
| Feature | Description |
|---|---|
| Dice roller | Roll 1–200 d6 at once; results show per-face frequency bar chart |
| Measure tool | Enter a range in inches; a dashed ring shows that distance from the selected unit's edge |
| Line-of-sight | Units within range are highlighted green (clear LOS) or red (blocked by terrain) |
| Ping | Click anywhere on the board to fire a pulsing yellow location marker visible to both players |

### Communication
| Feature | Description |
|---|---|
| Real-time chat | In-game chat panel with player-coloured messages and unread badge |
| Join / leave notices | Flash notification when the other player connects or disconnects |
| Connection status | Live ● Online / ● Offline indicator in the topbar |
| Save | Manually save board state at any time; resets the 48-hour expiry timer |

---

## Tech Stack

### Python / Flask
The entire backend runs in Python. Flask was chosen over heavier frameworks (Django, FastAPI) because the application needs a small, well-defined set of HTTP routes — login, lobby, game — with no ORM overhead. Lightweight and easy to iterate on.

### Flask-SocketIO
Adds WebSocket support on top of Flask for full-duplex, real-time communication. All board events (moves, additions, deletions, HP changes, dice rolls, chat, pings) are pushed to connected clients the moment they happen — no polling, no page refreshes.

### SQLite
A zero-setup, file-based database that stores sessions and serialised board state as JSON. Chosen for local-first development; migrating to PostgreSQL for production hosting requires changing one connection string in `db.py`.

### Werkzeug
Used for `generate_password_hash` / `check_password_hash` — lobby passwords are never stored in plain text.

### HTML5 Canvas (JavaScript)
The board is rendered entirely on a `<canvas>` element using the browser's 2D drawing API. This gives precise control over zoom transforms, pan offsets, hit-testing, clip regions, and custom drawing (HP buttons, measure rings, LOS highlights, ping animations) without any external graphics library.

### Socket.IO (JS client)
Browser-side counterpart to Flask-SocketIO. Handles the WebSocket lifecycle, automatic reconnection, and event routing.

---

## Running Locally

**Install dependencies:**
```bash
pip3 install -r requirements.txt
```

**Start the server:**
```bash
python3 app.py
```

Open `http://127.0.0.1:5001` in your browser. To test two-player functionality, open the same URL in a second browser window, log in with a different name, and join the session.

**Environment variables (all optional):**

| Variable | Default | Purpose |
|---|---|---|
| `SECRET_KEY` | `warboard-dev-key-change-in-prod` | Flask session signing key — set a strong random value in production |
| `CORS_ORIGINS` | `http://localhost:5001` | Comma-separated list of allowed WebSocket origins |
| `DEBUG` | `true` | Set to `false` in production |
| `PORT` | `5001` | Port the server listens on |

---

## Project Structure

```
WarboardV2/
├── app.py              # Flask routes and all SocketIO event handlers
├── db.py               # SQLite database layer (sessions, game state, cleanup)
├── requirements.txt    # Python dependencies
├── warboard.db         # SQLite database file (auto-created on first run)
├── static/
│   ├── css/style.css   # Full dark-theme stylesheet
│   └── js/board.js     # Canvas rendering, game logic, socket event handling
└── templates/
    ├── base.html        # Base template with SEO meta tags and footer
    ├── login.html       # Display name login + guest access
    ├── lobby.html       # Session list, create form, About modal
    ├── game.html        # Game UI (topbar, sidebar, canvas, chat)
    └── join_locked.html # Password entry for locked sessions
```

---

## Deployment

Warboard V2 is structured for straightforward cloud deployment. The recommended path is:

1. **Host**: [Railway](https://railway.app) (simple Python deployment, free tier available)
2. **Database**: Migrate `db.py` from SQLite to PostgreSQL by swapping `sqlite3` for `psycopg2` and updating the connection logic
3. **Environment**: Set `SECRET_KEY`, `CORS_ORIGINS`, `DEBUG=false`, and `PORT` as environment variables on the host
4. **Domain**: Point a custom domain at the deployment; update `CORS_ORIGINS` to match

CSRF protection on POST routes is planned before the first public deployment.

---

## Roadmap

- [ ] CSRF protection on POST routes (Flask-WTF)
- [ ] PostgreSQL migration for production hosting
- [ ] Persistent user accounts with password login
- [ ] Session spectator mode (read-only third party view)
- [ ] Custom board backgrounds / map images
- [ ] Additional token shapes (squares, bases with facing indicators)
