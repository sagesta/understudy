'use strict';
// The main window's size and place across runs (C3), and the one-time hint when it is closed during a
// meeting (C4). No Electron import: main.js passes in the screens and the window, so the tests can run it.

const MIN = { width: 960, height: 620 };
const DEFAULT = { width: 1180, height: 800 };
const SEEN = 100; // pixels of the window that must be on a screen, both across and down

// { x, y, width, height } of finite numbers (width and height above zero), rounded; anything else is null.
// A file edited by hand, or written by another version, can hold anything.
function cleanBounds(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  for (const k of ['x', 'y', 'width', 'height']) {
    const n = v[k];
    if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 100000) return null;
    out[k] = Math.round(n);
  }
  return out.width > 0 && out.height > 0 ? out : null;
}

// What to open the window with. `saved` is { bounds, maximized } from the settings file (anything at all);
// `areas` are the work areas of the screens connected now ({ x, y, width, height } each).
// Returns { bounds, maximized }: `bounds` has x and y only when the saved place is still on a screen
// (otherwise the system picks one), and is never below the minimum size nor bigger than the largest screen.
function restoreWindow(saved, areas, { min = MIN, fallback = DEFAULT } = {}) {
  const s = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  const maximized = s.maximized === true;
  const b = cleanBounds(s.bounds);
  if (!b) return { bounds: { width: fallback.width, height: fallback.height }, maximized };
  const wa = (Array.isArray(areas) ? areas : []).map(cleanBounds).filter(Boolean);
  const room = (k) => (wa.length ? Math.max(min[k], ...wa.map((a) => a[k])) : Infinity);
  const width = Math.min(Math.max(b.width, min.width), room('width'));
  const height = Math.min(Math.max(b.height, min.height), room('height'));
  // Enough of it on one screen to grab and move: 100 px across and down, and the title bar not above the screen.
  const onScreen = wa.some((a) => Math.min(b.x + width, a.x + a.width) - Math.max(b.x, a.x) >= SEEN && Math.min(b.y + height, a.y + a.height) - Math.max(b.y, a.y) >= SEEN && b.y >= a.y - 10);
  return { bounds: onScreen ? { x: b.x, y: b.y, width, height } : { width, height }, maximized };
}

// What to write down for a window (its restored size, not the maximised one), or null when it holds nothing usable.
function windowState(win) {
  const bounds = cleanBounds(win.getNormalBounds());
  return bounds ? { bounds, maximized: win.isMaximized() === true } : null;
}

const TRAY_HINT = 'Still listening. Understudy is in the tray.';

// Says once per meeting that closing the window did not end it. Returns a function to call whenever the main
// window goes away; it sends nothing when no meeting is running or when this meeting has already been told.
// `send` is the same path every other hint takes to the overlay.
function createTrayHint({ meeting, send }) {
  let told = null;
  return function trayHint() {
    try {
      if (!meeting || !meeting.active) return false;
      const key = meeting.meta || meeting;
      if (told === key) return false;
      told = key;
      send({ type: 'hint', message: TRAY_HINT });
      return true;
    } catch { return false; }
  };
}

module.exports = { MIN, DEFAULT, SEEN, cleanBounds, restoreWindow, windowState, createTrayHint, TRAY_HINT };
