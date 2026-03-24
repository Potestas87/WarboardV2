'use strict';

// ── Constants (injected from game.html) ───────────────────────────────────────
// SESSION_ID, USERNAME, BOARD_W_MM, BOARD_H_MM, PLAYER1_NAME, PLAYER2_NAME

// ── Board state ───────────────────────────────────────────────────────────────
let circles   = [];
let squares   = [];
let gamePhase = 'setup';   // 'setup' | 'active'
let zoom      = 1.0;
let panX      = 0;
let panY      = 0;
let baseScale = 1;

let selectedColor = '#e94560';

// ── Turn & history ────────────────────────────────────────────────────────────
let activeTurn  = null;    // username of the player whose turn it is
let moveHistory = [];      // [{circle_id, from_x, from_y, to_x, to_y}] max 10
let redoStack   = [];      // same shape; cleared on every new move

// ── Interaction state ─────────────────────────────────────────────────────────
let dragCircle   = null;
let dragOffX     = 0;
let dragOffY     = 0;
let dragStartX   = 0;      // circle position at the moment of mousedown
let dragStartY   = 0;

let dragSquare      = null;
let dragSquareOffX  = 0;
let dragSquareOffY  = 0;
let isPanning    = false;
let panStartX    = 0;
let panStartY    = 0;
let panStartPanX = 0;
let panStartPanY = 0;

// ── Measure tool ──────────────────────────────────────────────────────────────
let selectedCircle = null;
let measureOriginX = 0;
let measureOriginY = 0;

let ctxMenuCircle = null;
let ctxMenuSquare = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const canvas        = document.getElementById('board-canvas');
const ctx           = canvas.getContext('2d');
const zoomLabel     = document.getElementById('zoom-label');
const ctxMenu       = document.getElementById('ctx-menu');
const ctxDelete     = document.getElementById('ctx-delete');
const saveStatus    = document.getElementById('save-status');
const btnUndo       = document.getElementById('btn-undo');
const btnRedo       = document.getElementById('btn-redo');
const btnEndTurn    = document.getElementById('btn-end-turn');
const turnIndicator = document.getElementById('turn-indicator');

// ── Socket.IO ─────────────────────────────────────────────────────────────────
const socket = io();

socket.on('connect', () => {
  socket.emit('join', { session_id: SESSION_ID });
});

socket.on('state_sync', (state) => {
  circles    = state.circles || [];
  squares    = state.squares || [];
  gamePhase  = state.phase   || 'setup';
  activeTurn = state.active_turn || null;
  updateTurnUI();
  updatePhaseUI();
  render();
});

socket.on('circles_added', (data) => {
  circles.push(...data.circles);
  render();
});

socket.on('circle_moved', (data) => {
  const c = circles.find(c => c.id === data.circle_id);
  if (c) { c.x_mm = data.x_mm; c.y_mm = data.y_mm; }
  render();
});

socket.on('circle_deleted', (data) => {
  circles = circles.filter(c => c.id !== data.circle_id);
  render();
});

socket.on('hp_updated', (data) => {
  const c = circles.find(c => c.id === data.circle_id);
  if (c !== undefined) c.hp = data.hp;
  render();
});

socket.on('turn_changed', (data) => {
  activeTurn  = data.active_turn;
  moveHistory = [];
  redoStack   = [];
  updateTurnUI();
  render();
});

socket.on('squares_added', (data) => {
  squares.push(...data.squares);
  render();
});

socket.on('square_moved', (data) => {
  const s = squares.find(s => s.id === data.square_id);
  if (s) { s.x_mm = data.x_mm; s.y_mm = data.y_mm; }
  render();
});

socket.on('square_deleted', (data) => {
  squares = squares.filter(s => s.id !== data.square_id);
  render();
});

socket.on('game_started', () => {
  gamePhase = 'active';
  updatePhaseUI();
  render();
});

socket.on('dice_result', showDiceResults);

socket.on('state_saved', (data) => {
  saveStatus.textContent = data.message;
  setTimeout(() => { saveStatus.textContent = ''; }, 3000);
});

// ── Turn UI ───────────────────────────────────────────────────────────────────
function isMyTurn() { return activeTurn === USERNAME; }

function updateTurnUI() {
  // Player tag active highlight
  const p1Tag = document.getElementById('tag-p1');
  const p2Tag = document.getElementById('tag-p2');
  p1Tag.classList.toggle('active-turn', activeTurn === PLAYER1_NAME);
  p2Tag.classList.toggle('active-turn', activeTurn === PLAYER2_NAME);

  // Turn indicator text
  if (!activeTurn) {
    turnIndicator.textContent = '';
  } else if (isMyTurn()) {
    turnIndicator.textContent = 'Your Turn';
    turnIndicator.className   = 'turn-indicator my-turn';
  } else {
    turnIndicator.textContent = `${activeTurn}'s Turn`;
    turnIndicator.className   = 'turn-indicator their-turn';
  }

  // End Turn button — only enabled on your turn and only when player2 exists
  btnEndTurn.disabled = !isMyTurn() || !PLAYER2_NAME;

  updateUndoRedoButtons();
}

// ── Phase UI ──────────────────────────────────────────────────────────────────
function updatePhaseUI() {
  const isSetup = gamePhase === 'setup';

  // Terrain panel — only visible in setup
  const terrainPanel = document.getElementById('terrain-panel');
  if (terrainPanel) terrainPanel.classList.toggle('hidden', !isSetup);

  // Start Game button — only player1 can see it, only in setup
  const btnStart = document.getElementById('btn-start-game');
  if (btnStart) btnStart.classList.toggle('hidden', !isSetup || USERNAME !== PLAYER1_NAME);

  // Phase badge
  const badge = document.getElementById('phase-indicator');
  if (badge) {
    badge.textContent = isSetup ? 'Setup' : 'Active';
    badge.className   = isSetup ? 'phase-indicator setup' : 'phase-indicator active';
  }
}

// ── Undo / Redo ───────────────────────────────────────────────────────────────
// TODO: remove Guest bypass before production
function canUndo() { return (isMyTurn() || USERNAME === 'Guest') && moveHistory.length > 0; }
function canRedo() { return (isMyTurn() || USERNAME === 'Guest') && redoStack.length > 0; }

function updateUndoRedoButtons() {
  btnUndo.disabled = !canUndo();
  btnRedo.disabled = !canRedo();
}

function recordMove(circle_id, from_x, from_y, to_x, to_y) {
  moveHistory.push({ circle_id, from_x, from_y, to_x, to_y });
  if (moveHistory.length > 10) moveHistory.shift();
  redoStack = [];   // new move always clears redo
  updateUndoRedoButtons();
}

function applyMove(circle_id, x_mm, y_mm) {
  const c = circles.find(c => c.id === circle_id);
  if (!c) return;
  c.x_mm = x_mm;
  c.y_mm = y_mm;
  socket.emit('move_circle', { session_id: SESSION_ID, circle_id, x_mm, y_mm });
  render();
}

btnUndo.addEventListener('click', () => {
  if (!canUndo()) return;
  const move = moveHistory.pop();
  redoStack.push(move);
  applyMove(move.circle_id, move.from_x, move.from_y);
  updateUndoRedoButtons();
});

btnRedo.addEventListener('click', () => {
  if (!canRedo()) return;
  const move = redoStack.pop();
  moveHistory.push(move);
  applyMove(move.circle_id, move.to_x, move.to_y);
  updateUndoRedoButtons();
});

btnEndTurn.addEventListener('click', () => {
  if (!isMyTurn()) return;
  socket.emit('end_turn', { session_id: SESSION_ID });
});

// ── Canvas resize & init ──────────────────────────────────────────────────────
function resizeCanvas() {
  const container = canvas.parentElement;
  canvas.width    = container.clientWidth;
  canvas.height   = container.clientHeight;
  recalcBaseScale();
  render();
}

function recalcBaseScale() {
  baseScale = Math.min(canvas.width / BOARD_W_MM, canvas.height / BOARD_H_MM);
}

function initPan() {
  panX = (canvas.width  - BOARD_W_MM * baseScale * zoom) / 2;
  panY = (canvas.height - BOARD_H_MM * baseScale * zoom) / 2;
}

// ── Coordinate helpers ────────────────────────────────────────────────────────
function totalScale() { return baseScale * zoom; }

function canvasToMm(px, py) {
  const s = totalScale();
  return { x: (px - panX) / s, y: (py - panY) / s };
}

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.save();
  ctx.translate(panX, panY);
  ctx.scale(totalScale(), totalScale());

  drawBoard();
  squares.forEach(drawSquare);
  drawMeasureRing();
  drawLosHighlights();
  circles.forEach(drawCircle);

  ctx.restore();
}

function drawBoard() {
  ctx.fillStyle = '#1a2e22';
  ctx.fillRect(0, 0, BOARD_W_MM, BOARD_H_MM);

  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 0.25;
  for (let x = 0; x <= BOARD_W_MM; x += 25.4) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, BOARD_H_MM); ctx.stroke();
  }
  for (let y = 0; y <= BOARD_H_MM; y += 25.4) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(BOARD_W_MM, y); ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = 0.5;
  for (let x = 0; x <= BOARD_W_MM; x += 152.4) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, BOARD_H_MM); ctx.stroke();
  }
  for (let y = 0; y <= BOARD_H_MM; y += 152.4) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(BOARD_W_MM, y); ctx.stroke();
  }

  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.font = '6px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 6; i < 72; i += 6) ctx.fillText(i + '"', i * 25.4, 2);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (let i = 6; i < 48; i += 6) ctx.fillText(i + '"', 2, i * 25.4);

  ctx.strokeStyle = '#3a7a55';
  ctx.lineWidth = 2;
  ctx.strokeRect(0, 0, BOARD_W_MM, BOARD_H_MM);
}

function drawCircle(c) {
  const { x_mm, y_mm, radius_mm, title, color } = c;
  const hasHP = c.hp !== undefined;

  ctx.save();
  ctx.translate(x_mm, y_mm);

  ctx.beginPath();
  ctx.arc(0, 0, radius_mm, 0, Math.PI * 2);
  ctx.fillStyle = color + '55';
  ctx.fill();

  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(radius_mm * 0.04, 0.5);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(0, 0, radius_mm * 0.9, 0, Math.PI * 2);
  ctx.clip();

  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  if (hasHP) {
    const titleSize = Math.max(radius_mm * 0.22, 2.5);
    ctx.font = `${titleSize}px monospace`;
    ctx.fillText(title, 0, -radius_mm * 0.28, radius_mm * 1.7);

    const hpSize = Math.max(radius_mm * 0.32, 3.5);
    ctx.font = `bold ${hpSize}px monospace`;
    ctx.fillText(String(c.hp), 0, radius_mm * 0.12);

    const btnR  = radius_mm * 0.17;
    const btnY  = radius_mm * 0.60;
    const btnX  = radius_mm * 0.33;
    const btnFS = Math.max(btnR * 1.5, 2);

    ctx.beginPath();
    ctx.arc(-btnX, btnY, btnR, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(radius_mm * 0.025, 0.25); ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${btnFS}px monospace`;
    ctx.fillText('−', -btnX, btnY);

    ctx.beginPath();
    ctx.arc(btnX, btnY, btnR, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(radius_mm * 0.025, 0.25); ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.fillText('+', btnX, btnY);
  } else {
    const fontSize = Math.max(radius_mm * 0.28, 3);
    ctx.font = `${fontSize}px monospace`;
    ctx.fillText(title, 0, 0, radius_mm * 1.7);
  }

  ctx.restore();
}

function drawSquare(s) {
  const { x_mm, y_mm, width_mm, height_mm, name, elevation } = s;
  const hw = width_mm / 2, hh = height_mm / 2;
  const minSide = Math.min(width_mm, height_mm);

  ctx.save();
  ctx.translate(x_mm, y_mm);

  // Fill
  ctx.fillStyle = 'rgba(90, 65, 40, 0.60)';
  ctx.fillRect(-hw, -hh, width_mm, height_mm);

  // Outer border
  ctx.strokeStyle = '#c8a070';
  ctx.lineWidth = Math.max(minSide * 0.018, 0.5);
  ctx.strokeRect(-hw, -hh, width_mm, height_mm);

  // Inner inset line
  const m = Math.max(minSide * 0.045, 1);
  ctx.strokeStyle = 'rgba(200, 160, 112, 0.35)';
  ctx.lineWidth = Math.max(minSide * 0.009, 0.3);
  ctx.strokeRect(-hw + m, -hh + m, width_mm - m * 2, height_mm - m * 2);

  // Text
  ctx.fillStyle = '#ffe8c0';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const hasElev = elevation !== undefined && elevation !== null && elevation !== '';
  if (hasElev) {
    const nameSize = Math.max(minSide * 0.16, 3);
    ctx.font = `${nameSize}px monospace`;
    ctx.fillText(name, 0, -hh * 0.30, width_mm * 0.88);

    const elvSize = Math.max(minSide * 0.26, 4);
    ctx.font = `bold ${elvSize}px monospace`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(String(elevation), 0, hh * 0.28);
  } else {
    const nameSize = Math.max(minSide * 0.18, 3);
    ctx.font = `${nameSize}px monospace`;
    ctx.fillText(name, 0, 0, width_mm * 0.88);
  }

  ctx.restore();
}

// ── Line-of-sight helpers ─────────────────────────────────────────────────────

// Returns true if segment (x1,y1)→(x2,y2) crosses segment (x3,y3)→(x4,y4)
function segmentsIntersect(x1, y1, x2, y2, x3, y3, x4, y4) {
  const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(denom) < 1e-10) return false;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

// Returns true if segment (x1,y1)→(x2,y2) intersects axis-aligned rect
// (rx, ry) is top-left corner, rw/rh are dimensions
function segmentIntersectsRect(x1, y1, x2, y2, rx, ry, rw, rh) {
  const inRect = (px, py) => px >= rx && px <= rx + rw && py >= ry && py <= ry + rh;
  if (inRect(x1, y1) || inRect(x2, y2)) return true;
  const l = rx, r = rx + rw, t = ry, b = ry + rh;
  return segmentsIntersect(x1, y1, x2, y2, l, t, l, b) ||
         segmentsIntersect(x1, y1, x2, y2, r, t, r, b) ||
         segmentsIntersect(x1, y1, x2, y2, l, t, r, t) ||
         segmentsIntersect(x1, y1, x2, y2, l, b, r, b);
}

// Draws green/red highlight rings around circles that fall within the measure
// ring of the selected circle. Green = clear line of sight; red = blocked by terrain.
function drawLosHighlights() {
  if (!selectedCircle) return;
  const measureIn = getMeasureInches();
  if (measureIn <= 0) return;

  const measureRadius = measureIn * 25.4 + selectedCircle.radius_mm;   // measure ring radius in mm
  const sx = measureOriginX, sy = measureOriginY;

  for (const c of circles) {
    if (c.id === selectedCircle.id) continue;

    const dx   = c.x_mm - sx, dy = c.y_mm - sy;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // Only highlight circles whose area overlaps the measure ring area
    if (dist > measureRadius + c.radius_mm) continue;

    // Check if any terrain square blocks the direct line between centers
    const blocked = squares.some(s =>
      segmentIntersectsRect(
        sx, sy, c.x_mm, c.y_mm,
        s.x_mm - s.width_mm  / 2,
        s.y_mm - s.height_mm / 2,
        s.width_mm,
        s.height_mm
      )
    );

    ctx.save();
    ctx.translate(c.x_mm, c.y_mm);
    ctx.beginPath();
    ctx.arc(0, 0, c.radius_mm + Math.max(c.radius_mm * 0.14, 1.5), 0, Math.PI * 2);
    ctx.strokeStyle = blocked ? 'rgba(233, 69, 96, 0.90)' : 'rgba(76, 175, 80, 0.90)';
    ctx.lineWidth   = Math.max(c.radius_mm * 0.09, 1);
    ctx.stroke();
    ctx.restore();
  }
}

// ── Measure ring ──────────────────────────────────────────────────────────────
function getMeasureInches() {
  return parseFloat(document.getElementById('measure-input').value) || 0;
}

function drawMeasureRing() {
  if (!selectedCircle) return;
  const inches = getMeasureInches();
  if (inches <= 0) return;

  const radius_mm = inches * 25.4 + selectedCircle.radius_mm;

  ctx.save();
  ctx.translate(measureOriginX, measureOriginY);

  ctx.beginPath();
  ctx.arc(0, 0, radius_mm, 0, Math.PI * 2);
  ctx.fillStyle = selectedCircle.color + '20';
  ctx.fill();

  ctx.strokeStyle = selectedCircle.color + 'aa';
  ctx.lineWidth   = Math.max(radius_mm * 0.008, 0.4);
  ctx.setLineDash([radius_mm * 0.025, radius_mm * 0.015]);
  ctx.stroke();
  ctx.setLineDash([]);

  const labelSize = Math.max(radius_mm * 0.04, 3);
  ctx.font         = `${labelSize}px monospace`;
  ctx.fillStyle    = selectedCircle.color + 'cc';
  ctx.textAlign    = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${inches}"`, radius_mm + labelSize * 0.3, 0);

  ctx.restore();
}

// ── Zoom ──────────────────────────────────────────────────────────────────────
function zoomAt(px, py, factor) {
  const mm = canvasToMm(px, py);
  zoom = Math.max(0.15, Math.min(12, zoom * factor));
  const s = totalScale();
  panX = px - mm.x * s;
  panY = py - mm.y * s;
  zoomLabel.textContent = Math.round(zoom * 100) + '%';
  render();
}

// ── Hit tests ─────────────────────────────────────────────────────────────────
function circleAt(mm_x, mm_y) {
  for (let i = circles.length - 1; i >= 0; i--) {
    const c = circles[i];
    const dx = mm_x - c.x_mm, dy = mm_y - c.y_mm;
    if (dx * dx + dy * dy <= c.radius_mm * c.radius_mm) return c;
  }
  return null;
}

function hpButtonAt(mm_x, mm_y) {
  for (let i = circles.length - 1; i >= 0; i--) {
    const c = circles[i];
    if (c.hp === undefined) continue;
    const r = c.radius_mm, btnR = r * 0.17, btnY = r * 0.60, btnX = r * 0.33;
    const dx = mm_x - c.x_mm, dy = mm_y - c.y_mm;
    if ((dx + btnX) ** 2 + (dy - btnY) ** 2 <= btnR ** 2) return { circle: c, action: 'minus' };
    if ((dx - btnX) ** 2 + (dy - btnY) ** 2 <= btnR ** 2) return { circle: c, action: 'plus' };
  }
  return null;
}

function squareAt(mm_x, mm_y) {
  for (let i = squares.length - 1; i >= 0; i--) {
    const s = squares[i];
    if (mm_x >= s.x_mm - s.width_mm / 2 && mm_x <= s.x_mm + s.width_mm / 2 &&
        mm_y >= s.y_mm - s.height_mm / 2 && mm_y <= s.y_mm + s.height_mm / 2) {
      return s;
    }
  }
  return null;
}

// ── Mouse events ──────────────────────────────────────────────────────────────
canvas.addEventListener('mousedown', (e) => {
  if (e.button === 2) return;
  hideCtxMenu();

  const rect = canvas.getBoundingClientRect();
  const mm   = canvasToMm(e.clientX - rect.left, e.clientY - rect.top);

  // HP buttons take priority
  const btn = hpButtonAt(mm.x, mm.y);
  if (btn) {
    const { circle, action } = btn;
    circle.hp = action === 'minus' ? Math.max(0, circle.hp - 1) : circle.hp + 1;
    socket.emit('update_hp', { session_id: SESSION_ID, circle_id: circle.id, hp: circle.hp });
    render();
    return;
  }

  const hit = circleAt(mm.x, mm.y);
  if (hit) {
    dragCircle     = hit;
    dragOffX       = mm.x - hit.x_mm;
    dragOffY       = mm.y - hit.y_mm;
    dragStartX     = hit.x_mm;
    dragStartY     = hit.y_mm;
    selectedCircle = hit;
    measureOriginX = hit.x_mm;
    measureOriginY = hit.y_mm;
    canvas.style.cursor = 'grabbing';
    render();
    return;
  }

  // Square drag — setup phase only
  if (gamePhase === 'setup') {
    const sqHit = squareAt(mm.x, mm.y);
    if (sqHit) {
      dragSquare     = sqHit;
      dragSquareOffX = mm.x - sqHit.x_mm;
      dragSquareOffY = mm.y - sqHit.y_mm;
      canvas.style.cursor = 'grabbing';
      return;
    }
  }

  selectedCircle = null;
  isPanning    = true;
  panStartX    = e.clientX;
  panStartY    = e.clientY;
  panStartPanX = panX;
  panStartPanY = panY;
  canvas.style.cursor = 'grabbing';
});

canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const mm   = canvasToMm(e.clientX - rect.left, e.clientY - rect.top);

  if (dragCircle) {
    dragCircle.x_mm = Math.max(dragCircle.radius_mm,
                       Math.min(BOARD_W_MM - dragCircle.radius_mm, mm.x - dragOffX));
    dragCircle.y_mm = Math.max(dragCircle.radius_mm,
                       Math.min(BOARD_H_MM - dragCircle.radius_mm, mm.y - dragOffY));
    render();
  } else if (dragSquare) {
    const hw = dragSquare.width_mm / 2, hh = dragSquare.height_mm / 2;
    dragSquare.x_mm = Math.max(hw, Math.min(BOARD_W_MM - hw, mm.x - dragSquareOffX));
    dragSquare.y_mm = Math.max(hh, Math.min(BOARD_H_MM - hh, mm.y - dragSquareOffY));
    render();
  } else if (isPanning) {
    panX = panStartPanX + (e.clientX - panStartX);
    panY = panStartPanY + (e.clientY - panStartY);
    render();
  }
});

canvas.addEventListener('mouseup', () => {
  if (dragCircle) {
    const movedX = dragCircle.x_mm, movedY = dragCircle.y_mm;
    const didMove = movedX !== dragStartX || movedY !== dragStartY;

    socket.emit('move_circle', {
      session_id: SESSION_ID,
      circle_id:  dragCircle.id,
      x_mm:       movedX,
      y_mm:       movedY,
    });

    // TODO: remove Guest bypass before production
    const eligibleToRecord = (isMyTurn() || USERNAME === 'Guest') &&
                             (dragCircle.created_by === USERNAME || USERNAME === 'Guest');
    if (didMove && eligibleToRecord) {
      recordMove(dragCircle.id, dragStartX, dragStartY, movedX, movedY);
    }

    dragCircle = null;
  }

  if (dragSquare) {
    socket.emit('move_square', {
      session_id: SESSION_ID,
      square_id:  dragSquare.id,
      x_mm:       dragSquare.x_mm,
      y_mm:       dragSquare.y_mm,
    });
    dragSquare = null;
  }

  selectedCircle = null;
  isPanning = false;
  canvas.style.cursor = 'grab';
  render();
});

canvas.addEventListener('mouseleave', () => {
  if (dragCircle) {
    socket.emit('move_circle', {
      session_id: SESSION_ID,
      circle_id:  dragCircle.id,
      x_mm:       dragCircle.x_mm,
      y_mm:       dragCircle.y_mm,
    });
    // TODO: remove Guest bypass before production
    const didMove2 = dragCircle.x_mm !== dragStartX || dragCircle.y_mm !== dragStartY;
    const eligible2 = (isMyTurn() || USERNAME === 'Guest') &&
                      (dragCircle.created_by === USERNAME || USERNAME === 'Guest');
    if (didMove2 && eligible2) {
      recordMove(dragCircle.id, dragStartX, dragStartY, dragCircle.x_mm, dragCircle.y_mm);
    }
    dragCircle = null;
  }

  if (dragSquare) {
    socket.emit('move_square', {
      session_id: SESSION_ID,
      square_id:  dragSquare.id,
      x_mm:       dragSquare.x_mm,
      y_mm:       dragSquare.y_mm,
    });
    dragSquare = null;
  }

  selectedCircle = null;
  isPanning = false;
  canvas.style.cursor = 'grab';
  render();
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect   = canvas.getBoundingClientRect();
  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
}, { passive: false });

// Right-click context menu
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const mm   = canvasToMm(e.clientX - rect.left, e.clientY - rect.top);

  const hit = circleAt(mm.x, mm.y);
  if (hit) {
    ctxMenuCircle = hit;
    ctxMenuSquare = null;
    ctxDelete.textContent = 'Delete Circle';
    ctxMenu.style.left = e.clientX + 'px';
    ctxMenu.style.top  = e.clientY + 'px';
    ctxMenu.classList.remove('hidden');
    return;
  }

  if (gamePhase === 'setup') {
    const sqHit = squareAt(mm.x, mm.y);
    if (sqHit) {
      ctxMenuSquare = sqHit;
      ctxMenuCircle = null;
      ctxDelete.textContent = 'Delete Terrain';
      ctxMenu.style.left = e.clientX + 'px';
      ctxMenu.style.top  = e.clientY + 'px';
      ctxMenu.classList.remove('hidden');
    }
  }
});

ctxDelete.addEventListener('click', () => {
  if (ctxMenuCircle) {
    const id = ctxMenuCircle.id;
    circles = circles.filter(c => c.id !== id);
    socket.emit('delete_circle', { session_id: SESSION_ID, circle_id: id });
    ctxMenuCircle = null;
  } else if (ctxMenuSquare) {
    const id = ctxMenuSquare.id;
    squares = squares.filter(s => s.id !== id);
    socket.emit('delete_square', { session_id: SESSION_ID, square_id: id });
    ctxMenuSquare = null;
  }
  hideCtxMenu();
  render();
});

document.addEventListener('click', hideCtxMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCtxMenu(); });
function hideCtxMenu() { ctxMenu.classList.add('hidden'); }

// ── Dice roller ───────────────────────────────────────────────────────────────
document.getElementById('btn-roll').addEventListener('click', () => {
  const n = parseInt(document.getElementById('dice-count').value, 10) || 1;
  socket.emit('roll_dice', { session_id: SESSION_ID, num_dice: n });
});

function showDiceResults(data) {
  const { counts, total, num_dice } = data;
  const tbody    = document.getElementById('dice-tbody');
  const maxCount = Math.max(...Object.values(counts), 1);
  tbody.innerHTML = '';
  for (let face = 1; face <= 6; face++) {
    const count = counts[String(face)] || 0;
    const pct   = Math.round((count / maxCount) * 100);
    const tr    = document.createElement('tr');
    tr.innerHTML = `
      <td style="color:var(--muted)">${face}</td>
      <td><strong>${count}</strong></td>
      <td class="bar-cell"><div class="bar-inner" style="width:${pct}%"></div></td>`;
    tbody.appendChild(tr);
  }
  document.getElementById('dice-total').textContent =
    `${num_dice} dice · total ${total} · avg ${(total / num_dice).toFixed(1)}`;
  document.getElementById('dice-results').classList.remove('hidden');
}

// ── Circle creator ────────────────────────────────────────────────────────────
document.getElementById('color-swatches').addEventListener('click', (e) => {
  if (!e.target.classList.contains('swatch')) return;
  document.querySelectorAll('.swatch').forEach(s => s.classList.remove('selected'));
  e.target.classList.add('selected');
  selectedColor = e.target.dataset.color;
});

document.getElementById('circle-hp-enabled').addEventListener('change', (e) => {
  document.getElementById('circle-hp-row').classList.toggle('hidden', !e.target.checked);
});

document.getElementById('btn-add-circle').addEventListener('click', () => {
  const diameter  = parseFloat(document.getElementById('circle-radius').value) || 40;
  const radius_mm = diameter / 2;
  const title     = document.getElementById('circle-title').value.trim() || 'Unit';
  const copies    = Math.max(1, Math.min(50, parseInt(document.getElementById('circle-copies').value, 10) || 1));
  const hpEnabled = document.getElementById('circle-hp-enabled').checked;
  const hpStart   = hpEnabled
    ? Math.max(1, parseInt(document.getElementById('circle-hp').value, 10) || 1)
    : undefined;

  const newCircles = [];
  const spacing    = diameter + 5;

  for (let i = 0; i < copies; i++) {
    const circle = {
      id:         crypto.randomUUID(),
      x_mm:       Math.min(radius_mm + 10 + i * spacing, BOARD_W_MM - radius_mm),
      y_mm:       radius_mm + 10,
      radius_mm,
      title:      copies > 1 ? `${title} ${i + 1}` : title,
      color:      selectedColor,
      created_by: USERNAME,    // ownership for undo eligibility
    };
    if (hpEnabled) circle.hp = hpStart;
    newCircles.push(circle);
  }

  circles.push(...newCircles);
  socket.emit('add_circles', { session_id: SESSION_ID, circles: newCircles });
  render();
});

// ── Terrain creator ───────────────────────────────────────────────────────────
document.getElementById('btn-add-square').addEventListener('click', () => {
  const widthIn   = parseFloat(document.getElementById('sq-width').value)     || 4;
  const heightIn  = parseFloat(document.getElementById('sq-height').value)    || 4;
  const elevation = parseInt(document.getElementById('sq-elevation').value, 10);
  const name      = document.getElementById('sq-name').value.trim() || 'Terrain';

  const width_mm  = widthIn  * 25.4;
  const height_mm = heightIn * 25.4;

  const sq = {
    id:         crypto.randomUUID(),
    x_mm:       width_mm  / 2 + 10,
    y_mm:       height_mm / 2 + 10,
    width_mm,
    height_mm,
    name,
    elevation:  isNaN(elevation) ? 0 : elevation,
    created_by: USERNAME,
  };

  squares.push(sq);
  socket.emit('add_squares', { session_id: SESSION_ID, squares: [sq] });
  render();
});

// ── Start Game ────────────────────────────────────────────────────────────────
document.getElementById('btn-start-game').addEventListener('click', () => {
  if (USERNAME !== PLAYER1_NAME) return;
  socket.emit('start_game', { session_id: SESSION_ID });
});

// ── Measure clear ─────────────────────────────────────────────────────────────
document.getElementById('measure-clear').addEventListener('click', () => {
  document.getElementById('measure-input').value = '';
  render();
});

// ── Save ──────────────────────────────────────────────────────────────────────
document.getElementById('btn-save').addEventListener('click', () => {
  socket.emit('save_state', { session_id: SESSION_ID });
});

// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener('resize', resizeCanvas);
resizeCanvas();
recalcBaseScale();
initPan();
zoomLabel.textContent = '100%';
updatePhaseUI();
render();
