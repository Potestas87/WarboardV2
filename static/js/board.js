'use strict';

// ── Constants (injected from game.html) ───────────────────────────────────────
// SESSION_ID, USERNAME, BOARD_W_MM, BOARD_H_MM are globals from the template.

// ── State ─────────────────────────────────────────────────────────────────────
let circles   = [];   // [{id, x_mm, y_mm, radius_mm, title, color, hp?}, ...]
let zoom      = 1.0;
let panX      = 0;
let panY      = 0;
let baseScale = 1;    // px-per-mm at zoom=1

let selectedColor = '#e94560';

// Interaction state
let dragCircle   = null;
let dragOffX     = 0;
let dragOffY     = 0;
let isPanning    = false;
let panStartX    = 0;
let panStartY    = 0;
let panStartPanX = 0;
let panStartPanY = 0;

let ctxMenuCircle = null;

// Measure tool state
let selectedCircle  = null;   // circle actively held (mousedown)
let measureOriginX  = 0;      // board-mm position at the moment of selection
let measureOriginY  = 0;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const canvas     = document.getElementById('board-canvas');
const ctx        = canvas.getContext('2d');
const zoomLabel  = document.getElementById('zoom-label');
const ctxMenu    = document.getElementById('ctx-menu');
const ctxDelete  = document.getElementById('ctx-delete');
const saveStatus = document.getElementById('save-status');

// ── Socket.IO ─────────────────────────────────────────────────────────────────
const socket = io();

socket.on('connect', () => {
  socket.emit('join', { session_id: SESSION_ID });
});

socket.on('state_sync', (state) => {
  circles = state.circles || [];
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

socket.on('dice_result', (data) => {
  showDiceResults(data);
});

socket.on('state_saved', (data) => {
  saveStatus.textContent = data.message;
  setTimeout(() => { saveStatus.textContent = ''; }, 3000);
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
  // Fit the whole board into the canvas at zoom=1 (letterbox / pillarbox)
  const scaleX = canvas.width  / BOARD_W_MM;
  const scaleY = canvas.height / BOARD_H_MM;
  baseScale = Math.min(scaleX, scaleY);
}

function initPan() {
  // Centre the board in the canvas at zoom=1
  const boardPxW = BOARD_W_MM * baseScale * zoom;
  const boardPxH = BOARD_H_MM * baseScale * zoom;
  panX = (canvas.width  - boardPxW) / 2;
  panY = (canvas.height - boardPxH) / 2;
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
  // 1 canvas unit = 1 mm from here on

  drawBoard();
  drawMeasureRing();        // drawn before circles so it sits beneath them
  circles.forEach(drawCircle);

  ctx.restore();
}

function drawBoard() {
  ctx.fillStyle = '#1a2e22';
  ctx.fillRect(0, 0, BOARD_W_MM, BOARD_H_MM);

  // Minor grid — every inch (25.4 mm)
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 0.25;
  for (let x = 0; x <= BOARD_W_MM; x += 25.4) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, BOARD_H_MM); ctx.stroke();
  }
  for (let y = 0; y <= BOARD_H_MM; y += 25.4) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(BOARD_W_MM, y); ctx.stroke();
  }

  // Major grid — every 6 inches (152.4 mm)
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = 0.5;
  for (let x = 0; x <= BOARD_W_MM; x += 152.4) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, BOARD_H_MM); ctx.stroke();
  }
  for (let y = 0; y <= BOARD_H_MM; y += 152.4) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(BOARD_W_MM, y); ctx.stroke();
  }

  // Ruler marks along edges
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.font = '6px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 6; i < 72; i += 6) {
    ctx.fillText(i + '"', i * 25.4, 2);
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (let i = 6; i < 48; i += 6) {
    ctx.fillText(i + '"', 2, i * 25.4);
  }

  // Board border
  ctx.strokeStyle = '#3a7a55';
  ctx.lineWidth = 2;
  ctx.strokeRect(0, 0, BOARD_W_MM, BOARD_H_MM);
}

function drawCircle(c) {
  const { x_mm, y_mm, radius_mm, title, color } = c;
  const hasHP = c.hp !== undefined;

  ctx.save();
  ctx.translate(x_mm, y_mm);

  // Fill
  ctx.beginPath();
  ctx.arc(0, 0, radius_mm, 0, Math.PI * 2);
  ctx.fillStyle = color + '55';
  ctx.fill();

  // Outer ring
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(radius_mm * 0.04, 0.5);
  ctx.stroke();

  // Clip all text/buttons to just inside the ring
  ctx.beginPath();
  ctx.arc(0, 0, radius_mm * 0.9, 0, Math.PI * 2);
  ctx.clip();

  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  if (hasHP) {
    // Title — smaller, sits in upper area
    const titleSize = Math.max(radius_mm * 0.22, 2.5);
    ctx.font = `${titleSize}px monospace`;
    ctx.fillText(title, 0, -radius_mm * 0.28, radius_mm * 1.7);

    // HP number — large, centre
    const hpSize = Math.max(radius_mm * 0.32, 3.5);
    ctx.font = `bold ${hpSize}px monospace`;
    ctx.fillText(String(c.hp), 0, radius_mm * 0.12);

    // Button constants (local coords)
    const btnR  = radius_mm * 0.17;
    const btnY  = radius_mm * 0.60;
    const btnX  = radius_mm * 0.33;
    const btnFS = Math.max(btnR * 1.5, 2);

    // [−] button
    ctx.beginPath();
    ctx.arc(-btnX, btnY, btnR, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(radius_mm * 0.025, 0.25);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${btnFS}px monospace`;
    ctx.fillText('−', -btnX, btnY);

    // [+] button
    ctx.beginPath();
    ctx.arc(btnX, btnY, btnR, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(radius_mm * 0.025, 0.25);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.fillText('+', btnX, btnY);

  } else {
    // No HP — just title centred
    const fontSize = Math.max(radius_mm * 0.28, 3);
    ctx.font = `${fontSize}px monospace`;
    ctx.fillText(title, 0, 0, radius_mm * 1.7);
  }

  ctx.restore();
}

// ── Measure ring ──────────────────────────────────────────────────────────────
function getMeasureInches() {
  return parseFloat(document.getElementById('measure-input').value) || 0;
}

function drawMeasureRing() {
  if (!selectedCircle) return;
  const inches = getMeasureInches();
  if (inches <= 0) return;

  const radius_mm = inches * 25.4;   // inches as radius → radius in mm

  ctx.save();
  ctx.translate(measureOriginX, measureOriginY);

  // Transparent filled area
  ctx.beginPath();
  ctx.arc(0, 0, radius_mm, 0, Math.PI * 2);
  ctx.fillStyle = selectedCircle.color + '20';
  ctx.fill();

  // Dashed border
  ctx.strokeStyle = selectedCircle.color + 'aa';
  ctx.lineWidth   = Math.max(radius_mm * 0.008, 0.4);
  ctx.setLineDash([radius_mm * 0.025, radius_mm * 0.015]);
  ctx.stroke();
  ctx.setLineDash([]);

  // Inch label at the right edge of the ring
  const labelSize = Math.max(radius_mm * 0.04, 3);
  ctx.font        = `${labelSize}px monospace`;
  ctx.fillStyle   = selectedCircle.color + 'cc';
  ctx.textAlign   = 'left';
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

// Returns the topmost circle under a board-mm point, or null.
function circleAt(mm_x, mm_y) {
  for (let i = circles.length - 1; i >= 0; i--) {
    const c  = circles[i];
    const dx = mm_x - c.x_mm;
    const dy = mm_y - c.y_mm;
    if (dx * dx + dy * dy <= c.radius_mm * c.radius_mm) return c;
  }
  return null;
}

// Returns {circle, action:'plus'|'minus'} if an HP button is hit, or null.
// Must match the button positions in drawCircle exactly.
function hpButtonAt(mm_x, mm_y) {
  for (let i = circles.length - 1; i >= 0; i--) {
    const c = circles[i];
    if (c.hp === undefined) continue;

    const r    = c.radius_mm;
    const btnR = r * 0.17;
    const btnY = r * 0.60;
    const btnX = r * 0.33;

    // Translate click to circle-local coords
    const dx = mm_x - c.x_mm;
    const dy = mm_y - c.y_mm;

    // [−] at local (-btnX, btnY)
    if ((dx + btnX) ** 2 + (dy - btnY) ** 2 <= btnR ** 2) {
      return { circle: c, action: 'minus' };
    }
    // [+] at local (+btnX, btnY)
    if ((dx - btnX) ** 2 + (dy - btnY) ** 2 <= btnR ** 2) {
      return { circle: c, action: 'plus' };
    }
  }
  return null;
}

// ── Mouse events ──────────────────────────────────────────────────────────────
canvas.addEventListener('mousedown', (e) => {
  if (e.button === 2) return;
  hideCtxMenu();

  const rect = canvas.getBoundingClientRect();
  const px   = e.clientX - rect.left;
  const py   = e.clientY - rect.top;
  const mm   = canvasToMm(px, py);

  // HP buttons take priority over drag
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
    // Capture selection origin for measure ring — frozen at this position
    selectedCircle = hit;
    measureOriginX = hit.x_mm;
    measureOriginY = hit.y_mm;
    canvas.style.cursor = 'grabbing';
    render();   // show ring immediately on mousedown, before any movement
  } else {
    selectedCircle = null;   // clicking empty space clears selection
    isPanning    = true;
    panStartX    = e.clientX;
    panStartY    = e.clientY;
    panStartPanX = panX;
    panStartPanY = panY;
    canvas.style.cursor = 'grabbing';
  }
});

canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const px   = e.clientX - rect.left;
  const py   = e.clientY - rect.top;

  if (dragCircle) {
    const mm = canvasToMm(px, py);
    dragCircle.x_mm = Math.max(dragCircle.radius_mm,
                       Math.min(BOARD_W_MM - dragCircle.radius_mm, mm.x - dragOffX));
    dragCircle.y_mm = Math.max(dragCircle.radius_mm,
                       Math.min(BOARD_H_MM - dragCircle.radius_mm, mm.y - dragOffY));
    render();
  } else if (isPanning) {
    panX = panStartPanX + (e.clientX - panStartX);
    panY = panStartPanY + (e.clientY - panStartY);
    render();
  }
});

canvas.addEventListener('mouseup', () => {
  if (dragCircle) {
    socket.emit('move_circle', {
      session_id: SESSION_ID,
      circle_id:  dragCircle.id,
      x_mm:       dragCircle.x_mm,
      y_mm:       dragCircle.y_mm,
    });
    dragCircle = null;
  }
  selectedCircle = null;   // release clears measure ring
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
    dragCircle = null;
  }
  selectedCircle = null;
  isPanning = false;
  canvas.style.cursor = 'grab';
  render();
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect   = canvas.getBoundingClientRect();
  const px     = e.clientX - rect.left;
  const py     = e.clientY - rect.top;
  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  zoomAt(px, py, factor);
}, { passive: false });

// Right-click context menu
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const px   = e.clientX - rect.left;
  const py   = e.clientY - rect.top;
  const mm   = canvasToMm(px, py);
  const hit  = circleAt(mm.x, mm.y);

  if (hit) {
    ctxMenuCircle = hit;
    ctxMenu.style.left = e.clientX + 'px';
    ctxMenu.style.top  = e.clientY + 'px';
    ctxMenu.classList.remove('hidden');
  }
});

ctxDelete.addEventListener('click', () => {
  if (!ctxMenuCircle) return;
  const id = ctxMenuCircle.id;
  circles = circles.filter(c => c.id !== id);
  socket.emit('delete_circle', { session_id: SESSION_ID, circle_id: id });
  ctxMenuCircle = null;
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

// Show/hide HP input based on checkbox
document.getElementById('circle-hp-enabled').addEventListener('change', (e) => {
  document.getElementById('circle-hp-row').classList.toggle('hidden', !e.target.checked);
});

document.getElementById('btn-add-circle').addEventListener('click', () => {
  // Input is diameter; radius_mm = diameter / 2
  const diameter  = parseFloat(document.getElementById('circle-radius').value) || 40;
  const radius_mm = diameter / 2;
  const title     = document.getElementById('circle-title').value.trim() || 'Unit';
  const copies    = Math.max(1, Math.min(50, parseInt(document.getElementById('circle-copies').value, 10) || 1));
  const hpEnabled = document.getElementById('circle-hp-enabled').checked;
  const hpStart   = hpEnabled
    ? Math.max(1, parseInt(document.getElementById('circle-hp').value, 10) || 1)
    : undefined;

  const newCircles = [];
  const spacing    = diameter + 5;   // one diameter + small gap between copies

  for (let i = 0; i < copies; i++) {
    const x = Math.min(radius_mm + 10 + i * spacing, BOARD_W_MM - radius_mm);
    const y = radius_mm + 10;

    const circle = {
      id:        crypto.randomUUID(),
      x_mm:      x,
      y_mm:      y,
      radius_mm,
      title:     copies > 1 ? `${title} ${i + 1}` : title,
      color:     selectedColor,
    };
    if (hpEnabled) circle.hp = hpStart;
    newCircles.push(circle);
  }

  circles.push(...newCircles);
  socket.emit('add_circles', { session_id: SESSION_ID, circles: newCircles });
  render();
});

// ── Measure clear button ──────────────────────────────────────────────────────
document.getElementById('measure-clear').addEventListener('click', () => {
  document.getElementById('measure-input').value = '';
  render();
});

// ── Save button ───────────────────────────────────────────────────────────────
document.getElementById('btn-save').addEventListener('click', () => {
  socket.emit('save_state', { session_id: SESSION_ID });
});

// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener('resize', resizeCanvas);
resizeCanvas();
recalcBaseScale();
initPan();
zoomLabel.textContent = Math.round(zoom * 100) + '%';
render();
