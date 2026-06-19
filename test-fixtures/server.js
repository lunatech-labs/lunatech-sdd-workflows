#!/usr/bin/env node
'use strict';

// Tiny stdlib HTTP server for the Focus Web UI (spec 002-focus-web-ui, task T4).
//
// This is a thin transport wrapper around a single lib/session.js instance. It
// serves the static UI assets from public/ and exposes a small JSON API for
// session state and control. No framework, no router library, no dependency:
// node:http, node:fs, node:path only. All timer/countdown semantics live in the
// session (which reuses focus.js); this module just threads a scheduler and
// exposes HTTP.
//
// Factory contract (the binding tests live in test/server.test.js):
//
//   createServer({ env = {}, scheduler }) -> { server, listen, close }
//     - env: a plain object (NOT process.env) used for duration config. It is
//       passed through parseDurations(env) from lib/session.js.
//     - scheduler: an injectable tick driver mirroring focus.js's scheduleTick
//       contract (scheduleTick(fn) -> { cancel }, tick(), pending()). When a
//       scheduler IS injected (tests) it is threaded straight into the session
//       and NO real timer is armed. When NO scheduler is injected (production) a
//       real controllable scheduler is built that fires the pending session tick
//       about once per second WHILE the session is running.
//     - server: the node http.Server instance (tests read server.address().port).
//     - listen(port, cb): start listening.
//     - close(cb): stop the server and release the handle.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { createSession, parseDurations } = require('./lib/session.js');

const DEFAULT_PORT = 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// Map a file extension to a Content-Type for the static assets we serve.
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

// Build a real, controllable scheduler for production use. It mirrors the
// scheduleTick(fn) -> { cancel } contract that lib/session.js (via focus.js's
// runInterval) expects, but instead of arming a timer per tick it stores the
// pending tick and runs a single ~1000ms interval that fires it while the
// session is running. This keeps exactly one timer alive only while ticking and
// lets us stop it (and avoid leaking a handle) once the session is idle, paused,
// or done.
function createRealScheduler({ tickMs = 1000, isRunning } = {}) {
  let pendingFn = null;
  let interval = null;

  const ensureInterval = () => {
    if (interval !== null) {
      return;
    }
    interval = setInterval(() => {
      // Only fire while the session is actually running and a tick is pending.
      // When idle/paused/done, fire nothing and stop the interval so no timer
      // lingers and keeps the process alive after the session is done.
      if (!isRunning() || pendingFn === null) {
        stopInterval();
        return;
      }
      const fn = pendingFn;
      pendingFn = null;
      fn();
      // If the tick did not register a further tick (phase/session ended), or
      // the session is no longer running, release the timer.
      if (pendingFn === null || !isRunning()) {
        stopInterval();
      }
    }, tickMs);
    // Do not let this interval, on its own, keep the process alive.
    if (typeof interval.unref === 'function') {
      interval.unref();
    }
  };

  const stopInterval = () => {
    if (interval !== null) {
      clearInterval(interval);
      interval = null;
    }
  };

  const scheduleTick = (fn) => {
    pendingFn = fn;
    ensureInterval();
    return {
      cancel: () => {
        pendingFn = null;
        stopInterval();
      },
    };
  };

  const tick = () => {
    const fn = pendingFn;
    pendingFn = null;
    if (fn) {
      fn();
    }
  };

  const pending = () => pendingFn !== null;

  return { scheduleTick, tick, pending, stop: stopInterval };
}

function createServer({ env = {}, scheduler } = {}) {
  const durations = parseDurations(env);

  // When no scheduler is injected (production), build a real one that ticks the
  // session about once per second while it is running. We need a forward
  // reference to the session for the isRunning predicate, so declare it first.
  let session;
  const activeScheduler =
    scheduler ||
    createRealScheduler({
      isRunning: () => session.getState().status === 'running',
    });

  session = createSession({ durations, scheduler: activeScheduler });

  const sendJson = (res, statusCode, payload) => {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
  };

  const sendSnapshot = (res) => {
    sendJson(res, 200, session.getState());
  };

  // Resolve a request path to a file inside public/, guarding against path
  // traversal outside the public root. Returns the absolute file path, or null
  // if the request escapes public/.
  const resolvePublicPath = (urlPath) => {
    // Strip the leading slash and normalize. path.normalize collapses any ".."
    // segments; we then re-join against the public root and verify containment.
    const relative = decodeURIComponent(urlPath.replace(/^\/+/, ''));
    const resolved = path.resolve(PUBLIC_DIR, relative);
    const root = path.resolve(PUBLIC_DIR);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return null;
    }
    return resolved;
  };

  const serveStatic = (res, filePath) => {
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentTypeFor(filePath) });
      res.end(data);
    });
  };

  const server = http.createServer((req, res) => {
    const { method } = req;
    // Strip any query string; we only route on the path.
    const urlPath = (req.url || '/').split('?')[0];

    // JSON API routes.
    if (urlPath === '/api/state') {
      if (method === 'GET') {
        sendSnapshot(res);
        return;
      }
      sendJson(res, 404, { error: 'Not Found' });
      return;
    }

    if (urlPath === '/api/start') {
      if (method === 'POST') {
        session.start();
        sendSnapshot(res);
        return;
      }
      sendJson(res, 404, { error: 'Not Found' });
      return;
    }

    if (urlPath === '/api/pause') {
      if (method === 'POST') {
        session.pause();
        sendSnapshot(res);
        return;
      }
      sendJson(res, 404, { error: 'Not Found' });
      return;
    }

    if (urlPath === '/api/reset') {
      if (method === 'POST') {
        session.reset();
        sendSnapshot(res);
        return;
      }
      sendJson(res, 404, { error: 'Not Found' });
      return;
    }

    // Static asset routes (GET only). "/" maps to index.html.
    if (method === 'GET') {
      const requested = urlPath === '/' ? '/index.html' : urlPath;
      const filePath = resolvePublicPath(requested);
      if (filePath === null) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
      serveStatic(res, filePath);
      return;
    }

    // Unknown route / method.
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  });

  const listen = (port, cb) => {
    server.listen(port, cb);
  };

  const close = (cb) => {
    // Release any production interval so no handle lingers after close.
    if (activeScheduler && typeof activeScheduler.stop === 'function') {
      activeScheduler.stop();
    }
    server.close(cb);
  };

  return { server, listen, close };
}

module.exports = { createServer };

// Module guard: only start listening when run directly, not on import, so tests
// can import createServer without binding a fixed port.
if (require.main === module) {
  const port = parseDurations && process.env.PORT
    ? Number.parseInt(process.env.PORT, 10) || DEFAULT_PORT
    : DEFAULT_PORT;
  const app = createServer({ env: process.env });
  app.listen(port, () => {
    const bound = app.server.address().port;
    process.stdout.write(`focus web UI listening on http://localhost:${bound}\n`);
  });
}
