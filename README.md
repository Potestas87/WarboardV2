# Warboard V2

A locally-hosted, real-time tabletop simulator built in Python. Warboard V2 is a ground-up rebuild of an original first project, redesigned with a cleaner architecture and a focus on extensibility — starting simple on the front end while keeping the backend capable of growing into a full web application over time.

---

## Goals

- Provide a shared virtual tabletop that two players can use simultaneously from separate browser windows on the same network
- Accurately represent a 72" × 48" physical game board with true-to-scale circle tokens defined in millimetres
- Support real-time synchronisation of all board state between both players — moves, additions, deletions, and HP changes appear instantly for both users
- Persist game state so sessions can be saved and resumed from where they left off
- Include a dice roller that tracks frequency distributions across multiple d6 rolls
- Remain straightforward to run locally (a single `python3 app.py` command) while being structured in a way that makes cloud deployment a natural next step

---

## Tech Stack

### Python
The base language for the entire backend. Python was chosen for its readability, its vast ecosystem of web and utility libraries, and the fact that it keeps the barrier to entry low for future contributors or personal iteration. It also runs identically across macOS, Linux, and Windows without configuration.

### Flask
A lightweight WSGI web framework for Python. Flask was chosen over heavier alternatives (Django, FastAPI) because Warboard V2 needs a small number of straightforward HTTP routes — login, lobby, and game — with no need for a full ORM, admin panel, or API schema layer. Flask stays out of the way and lets the application define only what it actually needs.

### Flask-SocketIO
Adds WebSocket support on top of Flask, enabling full-duplex, real-time communication between the server and connected browser clients. This is what powers the live sync between Player 1 and Player 2 — circle movements, HP changes, dice rolls, and deletions are pushed to both clients the moment they happen without either player having to refresh or poll.

### SQLite
A file-based relational database that requires zero server setup. SQLite was chosen for local-first development because the entire database lives in a single `.db` file alongside the application code. It handles user accounts, game sessions, and serialised board state (circles stored as JSON). When the project moves to a hosted environment, swapping SQLite for PostgreSQL or MySQL is a straightforward change to one connection string.

### Werkzeug
Included as a Flask dependency and used here specifically for its password hashing utilities (`generate_password_hash` / `check_password_hash`). Passwords are never stored in plain text — Werkzeug handles salted hashing automatically.

### HTML5 Canvas (JavaScript)
The board itself is rendered entirely on a `<canvas>` element using the browser's 2D drawing API. This approach was chosen because it gives precise, pixel-level control over how the board, grid, and circle tokens are drawn — including zoom transforms, pan offsets, clip regions for text, and custom hit-testing for interactive elements like HP buttons. No external graphics library is needed.

### Socket.IO (JavaScript client)
The browser-side counterpart to Flask-SocketIO. It handles the WebSocket connection lifecycle, automatic reconnection, and event routing between the canvas logic and the server.

---

## Running Locally

**Install dependencies (first time only):**
```bash
pip3 install -r requirements.txt
```

**Start the server:**
```bash
python3 app.py
```

Open `http://127.0.0.1:5001` in your browser.

To test with two players, open the same URL in a second browser window, register a second account, and join the existing session.

---

## Features

| Feature | Description |
|---|---|
| Two-player live sync | Both players see all board changes in real time via WebSockets |
| Circle tokens | Defined by base diameter in mm, scaled accurately to the 72"×48" board |
| HP Tracker | Optional per-circle HP value with +/− buttons rendered directly on the token |
| Copies | Generate multiple labelled copies of a token in one action |
| Dice roller | Roll any number of d6 and see per-face frequency counts |
| Zoom & pan | Scroll to zoom toward cursor; drag to pan; position and scale always preserved |
| Save state | Board state persists in SQLite; resume any session from the lobby |
| Delete tokens | Right-click any circle to remove it from the board |
| Guest login | One-click access for local testing without registering |
