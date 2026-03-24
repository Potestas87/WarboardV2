'use strict';

// ── Constants (injected from game.html) ───────────────────────────────────────
// SESSION_ID, USERNAME, BOARD_W_MM, BOARD_H_MM are globals from the template.

// ── State ─────────────────────────────────────────────────────────────────────
let circles   = [];          // [{id, x_mm, y_mm, radius_mm, title, color}, ...]
let zoom      = 1.0;         // current zoom multiplier
let panX      = 0;           // canvas-px offset of board origin X
let panY      = 0;           // canvas-px offset of board origin Y
let baseScale = 1;           // px-per-mm at zoom=1 (recalculated on resize)

let selectedColor = '#e94560';

// Interaction state
let dragCircle   = null;     // circle being moved
let dragOffX     = 0;        // cursor offset inside circle (mm)
let dragOffY     = 0;
let isPanning    = false;    // board pan in progress
let panStartX    = 0;
let panStartY    = 0;
let panStartPanX = 0;
let panStartPanY = 0;

let ctxMenuCircle = null;    // circle targeted by right-click menu

// ── DOM refs ─────────────────────────────────────────────────────────────────
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

// board-mm → canvas-px
function mmToCanvas(x_mm, y_mm) {
  const s = totalScale();
  return { x: x_mm * s + panX, y: y_mm * s + panY };
}

// canvas-px → board-mm
function canvasToMm(px, py) {
  const s = totalScale();
  return { x: (px - panX) / s, y: (py - panY) / s };
}

// mm distance → px distance (for radii etc.)
function mmToPx(mm) { return mm * totalScale(); }

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Outer background
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.save();
  ctx.translate(panX, panY);
  ctx.scale(totalScale(), totalScale());
  // Now 1 canvas unit = 1 mm

  drawBoard();
  circles.forEach(drawCircle);

  ctx.restore();
}

function drawBoard() {
  // Board surface
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

  // Ruler marks — inch numbers along edges
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

  ctx.save();
  ctx.translate(x_mm, y_mm);

  // Fill — semi-transparent
  ctx.beginPath();
  ctx.arc(0, 0, radius_mm, 0, Math.PI * 2);
  ctx.fillStyle = color + '55';
  ctx.fill();

  // Stroke
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(radius_mm * 0.04, 0.5);
  ctx.stroke();

  // Title text — scales with circle
  const fontSize = Math.max(radius_mm * 0.28, 3);
  ctx.font = `${fontSize}px monospace`;
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Wrap long titles
  const maxW = radius_mm * 1.6;
  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, radius_mm * 0.92, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillText(title, 0, 0, maxW);
  ctx.restore();

  ctx.restore();
}

// ── Zoom ──────────────────────────────────────────────────────────────────────
function zoomAt(px, py, factor) {
  const mm = canvasToMm(px, py);   // mm point under cursor before zoom

  zoom = Math.max(0.15, Math.min(12, zoom * factor));

  // Reposition pan so that same mm point stays under cursor
  const s = totalScale();
  panX = px - mm.x * s;
  panY = py - mm.y * s;

  zoomLabel.textContent = Math.round(zoom * 100) + '%';
  render();
}

// ── Hit test ──────────────────────────────────────────────────────────────────
function circleAt(mm_x, mm_y) {
  for (let i = circles.length - 1; i >= 0; i--) {
    const c  = circles[i];
    const dx = mm_x - c.x_mm;
    const dy = mm_y - c.y_mm;
    if (dx * dx + dy * dy <= c.radius_mm * c.radius_mm) return c;
  }
  return null;
}

// ── Mouse events ──────────────────────────────────────────────────────────────
canvas.addEventListener('mousedown', (e) => {
  if (e.button === 2) return;  // handled by contextmenu
  hideCtxMenu();

  const rect = canvas.getBoundingClientRect();
  const px   = e.clientX - rect.left;
  const py   = e.clientY - rect.top;
  const mm   = canvasToMm(px, py);
  const hit  = circleAt(mm.x, mm.y);

  if (hit) {
    dragCircle = hit;
    dragOffX   = mm.x - hit.x_mm;
    dragOffY   = mm.y - hit.y_mm;
    canvas.style.cursor = 'grabbing';
  } else {
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
    // Clamp within board bounds
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

canvas.addEventListener('mouseup', (e) => {
  if (dragCircle) {
    // Persist final position
    socket.emit('move_circle', {
      session_id: SESSION_ID,
      circle_id:  dragCircle.id,
      x_mm:       dragCircle.x_mm,
      y_mm:       dragCircle.y_mm,
    });
    dragCircle = null;
  }
  isPanning = false;
  canvas.style.cursor = 'grab';
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
  isPanning = false;
  canvas.style.cursor = 'grab';
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
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideCtxMenu();
});

function hideCtxMenu() {
  ctxMenu.classList.add('hidden');
}

// ── Dice roller ───────────────────────────────────────────────────────────────
document.getElementById('btn-roll').addEventListener('click', () => {
  const n = parseInt(document.getElementById('dice-count').value, 10) || 1;
  socket.emit('roll_dice', { session_id: SESSION_ID, num_dice: n });
});

function showDiceResults(data) {
  const { counts, total, num_dice } = data;
  const tbody   = document.getElementById('dice-tbody');
  const maxCount = Math.max(...Object.values(counts), 1);

  tbody.innerHTML = '';
  for (let face = 1; face <= 6; face++) {
    const count = counts[String(face)] || 0;
    const pct   = Math.round((count / maxCount) * 100);
    const tr    = document.createElement('tr');
    tr.innerHTML = `
      <td>&#9856;${'&#9856;&#9857;&#9858;&#9859;&#9860;&#9861;'.split('').slice(0)[face-1] || face}</td>
      <td>${count}</td>
      <td class="bar-cell"><div class="bar-inner" style="width:${pct}%"></div></td>`;
    // Simpler: just use the number with a die face label
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
// Color swatch selection
document.getElementById('color-swatches').addEventListener('click', (e) => {
  if (!e.target.classList.contains('swatch')) return;
  document.querySelectorAll('.swatch').forEach(s => s.classList.remove('selected'));
  e.target.classList.add('selected');
  selectedColor = e.target.dataset.color;
});

document.getElementById('btn-add-circle').addEventListener('click', () => {
  const radius = parseFloat(document.getElementById('circle-radius').value) || 25;
  const title  = document.getElementById('circle-title').value.trim() || 'Unit';
  const copies = Math.max(1, Math.min(50, parseInt(document.getElementById('circle-copies').value, 10) || 1));

  const newCircles = [];
  const spacing    = radius * 2 + 5;   // small gap between copies

  for (let i = 0; i < copies; i++) {
    // Place copies in a row starting near top-left with a small offset per copy
    const x = Math.min(radius + 20 + i * spacing, BOARD_W_MM - radius);
    const y = radius + 20;

    newCircles.push({
      id:        crypto.randomUUID(),
      x_mm:      x,
      y_mm:      y,
      radius_mm: radius,
      title:     copies > 1 ? `${title} ${i + 1}` : title,
      color:     selectedColor,
    });
  }

  circles.push(...newCircles);
  socket.emit('add_circles', { session_id: SESSION_ID, circles: newCircles });
  render();
});

// ── Save button ───────────────────────────────────────────────────────────────
document.getElementById('btn-save').addEventListener('click', () => {
  socket.emit('save_state', { session_id: SESSION_ID });
});

// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener('resize', resizeCanvas);

// First render
resizeCanvas();
recalcBaseScale();
initPan();
zoomLabel.textContent = Math.round(zoom * 100) + '%';
render();
