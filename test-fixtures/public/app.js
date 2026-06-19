'use strict';

// Focus web UI client (spec 002-focus-web-ui, task T5).
//
// Polls GET /api/state at least once per second and renders the countdown, the
// current phase, and the transition banner from server state. Wires the three
// control buttons to their POST routes, then refreshes state immediately so the
// UI reflects the new server state without waiting for the next poll. Plain
// browser JS, fetch only, no external libraries. No em dashes.

(function () {
  var POLL_MS = 1000;

  var timeEl = document.getElementById('time');
  var phaseEl = document.getElementById('phase-label');
  var bannerEl = document.getElementById('banner');
  var statusEl = document.getElementById('status');
  var startBtn = document.getElementById('start');
  var pauseBtn = document.getElementById('pause');
  var resetBtn = document.getElementById('reset');
  var ring = document.getElementById('ring');

  // MM:SS formatter matching focus.js formatTime semantics: zero-padded minutes
  // and seconds, minutes are NOT rolled into hours (e.g. 3600 -> "60:00").
  function formatTime(totalSeconds) {
    var safe = Math.max(0, Math.floor(totalSeconds || 0));
    var minutes = Math.floor(safe / 60);
    var seconds = safe % 60;
    var mm = String(minutes).padStart(2, '0');
    var ss = String(seconds).padStart(2, '0');
    return mm + ':' + ss;
  }

  // Human-readable status line per server status. Plain, active phrasing.
  var STATUS_TEXT = {
    idle: 'Ready when you are.',
    running: 'Counting down.',
    paused: 'Paused.',
    done: 'Session complete.',
  };

  // Draw the progress ring on canvas (no hand-authored SVG). The arc drains as
  // the current phase elapses; pink for work, light blue for break.
  function drawRing(state) {
    if (!ring || !ring.getContext) {
      return;
    }
    var ctx = ring.getContext('2d');
    var size = ring.width;
    var cx = size / 2;
    var cy = size / 2;
    var lineWidth = 12;
    var radius = (size - lineWidth) / 2 - 6;

    var total = state.totalSeconds > 0 ? state.totalSeconds : 1;
    var remaining = Math.max(0, Math.min(state.remainingSeconds, total));
    var fraction = remaining / total;

    var accent = state.phase === 'break' ? '#78b4d7' : '#db2777';

    ctx.clearRect(0, 0, size, size);

    // Track.
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = 'rgba(120, 180, 215, 0.16)';
    ctx.stroke();

    // Remaining arc, starting from the top (12 o'clock) and draining clockwise.
    if (fraction > 0) {
      var startAngle = -Math.PI / 2;
      var endAngle = startAngle + Math.PI * 2 * fraction;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, startAngle, endAngle);
      ctx.lineWidth = lineWidth;
      ctx.lineCap = 'round';
      ctx.strokeStyle = accent;
      ctx.stroke();
    }
  }

  function render(state) {
    if (!state) {
      return;
    }

    timeEl.textContent = formatTime(state.remainingSeconds);

    var isBreak = state.phase === 'break';
    phaseEl.textContent = isBreak ? 'Break' : 'Work';
    phaseEl.setAttribute('data-phase', isBreak ? 'break' : 'work');

    if (state.banner) {
      bannerEl.textContent = state.banner;
      bannerEl.hidden = false;
    } else {
      bannerEl.textContent = '';
      bannerEl.hidden = true;
    }

    statusEl.textContent = STATUS_TEXT[state.status] || '';

    // Reflect status on the controls: Start is for idle/paused/done; Pause is
    // only meaningful while running.
    var running = state.status === 'running';
    startBtn.disabled = running;
    pauseBtn.disabled = !running;

    drawRing(state);
  }

  function refresh() {
    return fetch('/api/state', { headers: { Accept: 'application/json' } })
      .then(function (res) {
        return res.json();
      })
      .then(render)
      .catch(function () {
        // Network blip between polls is non-fatal; the next poll retries.
      });
  }

  function control(path) {
    return fetch(path, { method: 'POST', headers: { Accept: 'application/json' } })
      .then(function (res) {
        return res.json();
      })
      .then(render)
      .catch(function () {
        statusEl.textContent = 'Could not reach the server.';
      });
  }

  startBtn.addEventListener('click', function () {
    control('/api/start');
  });
  pauseBtn.addEventListener('click', function () {
    control('/api/pause');
  });
  resetBtn.addEventListener('click', function () {
    control('/api/reset');
  });

  // Initial render plus a steady once-per-second poll while the page is open.
  refresh();
  setInterval(refresh, POLL_MS);
})();
