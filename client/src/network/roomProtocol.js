/**
 * @file roomProtocol — transport-independent message types for the peer
 * DataChannel (AGENTS.md rule 7).
 *
 * Two payload classes share one reliable/ordered DataChannel:
 *   - Control messages: JSON strings, shaped `{ type, ...payload }`.
 *   - Video bytes:      raw ArrayBuffers (never JSON), always file data
 *                       belonging to the most recently offered transfer.
 *
 * Wire format (host ⇄ guest):
 *   host → guest  FILE_OFFER    { name, size, mimeType, delivery }
 *   guest → host  FILE_ACCEPT   {}
 *   host → guest  (ArrayBuffer chunks, sequential)
 *   host → guest  FILE_COMPLETE {}
 *   either side   FILE_ABORT    { reason }
 *
 * `delivery` on FILE_OFFER tells the guest how to play what arrives:
 *   - 'progressive' — try MSE first so playback can start mid-transfer
 *   - 'full'        — buffer everything and only assemble a Blob at
 *                     FILE_COMPLETE (host's "full transfer" streaming mode)
 *
 * The room-wide streaming mode itself is announced out-of-band over the
 * signaling transport ('stream:mode-changed', see useSocket); it is not a
 * DataChannel message because it must reach peers whose channels do not
 * exist yet.
 */

/** @enum {string} */
export const MSG = {
  FILE_OFFER: 'FILE_OFFER',
  FILE_ACCEPT: 'FILE_ACCEPT',
  FILE_COMPLETE: 'FILE_COMPLETE',
  FILE_ABORT: 'FILE_ABORT',
}

/** @enum {string} How an offered file should be delivered/played. */
export const DELIVERY = {
  PROGRESSIVE: 'progressive',
  FULL: 'full',
}

/**
 * Serialize a control message for the wire.
 * @param {string} type one of MSG
 * @param {object} [payload]
 * @returns {string} JSON string
 */
export function encodeMessage(type, payload = {}) {
  return JSON.stringify({ type, ...payload })
}

/**
 * Parse a DataChannel text frame into a control message.
 * @param {string} raw
 * @returns {{ type: string } & object}
 */
export function decodeMessage(raw) {
  const msg = JSON.parse(raw)
  return typeof msg === 'object' && msg !== null ? msg : { type: '' }
}

/**
 * True when a DataChannel frame is a control message rather than video bytes.
 * @param {string|ArrayBuffer} data
 */
export function isControlMessage(data) {
  return typeof data === 'string'
}

/** Default chunk size; capped by the negotiated SCTP maxMessageSize. */
export const CHUNK_SIZE = 64 * 1024

/** Pause sending above this much queued in the channel. */
export const HIGH_WATER_MARK = 4 * 1024 * 1024

/** Resume sending once the queue drains below this. */
export const LOW_WATER_MARK = 1 * 1024 * 1024
