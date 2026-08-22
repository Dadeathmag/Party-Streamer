/**
 * @file Small pure helpers shared across the client.
 */

/**
 * Format a number of seconds as `m:ss` for display in the player time readout.
 *
 * @param {number} t  seconds; NaN/0/negative collapse to "0:00"
 * @returns {string} e.g. 0 → "0:00", 75.4 → "1:15"
 */
export function formatTime(t) {
  if (!t || isNaN(t)) return '0:00'
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}
