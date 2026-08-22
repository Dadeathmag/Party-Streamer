'use strict';

/**
 * @file Express application factory.
 *
 * Wires up:
 *  - CORS (config-driven)
 *  - GET /health        — JSON liveness/stats probe used by tests & monitoring
 *  - static + SPA routes — serves the built React client from ../client/dist
 *    when it exists, giving a single-origin deployment on PORT.
 */

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');

/**
 * Build the Express app.
 *
 * @param {object} options
 * @param {{ origin: string[] | boolean }} options.corsOrigin
 *   CORS setting shared with Socket.IO (see src/config.js).
 * @param {() => { status: string, rooms: number, connections: number }} [options.getStats]
 *   Called on every /health request. Supplied by server.js so the route can
 *   report live Socket.IO connection counts without this module depending on io.
 * @returns {import('express').Express}
 */
function createExpressApp({ corsOrigin, getStats }) {
  const app = express();
  app.use(cors(corsOrigin));

  // ── Health check ──────────────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json(getStats ? getStats() : { status: 'ok', rooms: 0, connections: 0 });
  });

  // ── Built client (single-origin mode) ────────────────────────────────────
  // After `npm run build` in client/, guests can just open http://<host-ip>:PORT
  // — no Vite dev server or CORS setup needed.
  const distDir = path.join(__dirname, '..', '..', 'client', 'dist');
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    // SPA fallback: anything that isn't the socket.io endpoint or /health gets
    // the client shell so deep links survive a refresh.
    app.get(/^\/(?!socket\.io|health).*/, (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  return app;
}

module.exports = { createExpressApp };
