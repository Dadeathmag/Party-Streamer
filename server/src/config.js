'use strict';

/**
 * @file Central configuration for the signaling server.
 *
 * Every value can be overridden via environment variables so the same code
 * runs unchanged in dev (localhost), on a LAN party host, or behind a proxy.
 */

/** Port the HTTP + Socket.IO server listens on. @type {number} */
const PORT = Number(process.env.PORT) || 3002;

/**
 * Comma-separated allowlist of client origins, e.g.
 * "http://localhost:5173,http://192.168.1.10:5173".
 *
 * When unset, CORS reflects whatever origin the request came from —
 * convenient for LAN use where guests connect via the host's IP.
 *
 * @type {{ origin: string[] | boolean }}
 */
const corsOrigin = process.env.CLIENT_ORIGIN
  ? { origin: process.env.CLIENT_ORIGIN.split(',').map((o) => o.trim()) }
  : { origin: true };

module.exports = { PORT, corsOrigin };
