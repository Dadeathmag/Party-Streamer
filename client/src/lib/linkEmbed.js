/**
 * @file linkEmbed.js — pure parser turning a pasted share-link into a
 * deterministic playback plan shared by every room member.
 *
 * The server stores whatever http(s) URL the host submitted; THIS module is
 * the single place that decides how each client plays it:
 *
 *   kind            playback strategy
 *   ──────────────  ─────────────────────────────────────────────────────────
 *   'direct'        plain <video src> (native element → full host sync).
 *                   Google Drive share-links are rewritten into direct-file
 *                   URLs here (unofficial hack — see KNOWN CAVEATS below).
 *   'youtube'       iframe + official IFrame API      → synced
 *   'vimeo'         iframe + official Player SDK     → synced
 *   'dailymotion'   iframe + official player.js API  → synced
 *   'twitch-vod'    iframe + official Embed API      → synced
 *   'twitch-live'   iframe, NO seek/duration         → unsynced (live)
 *
 * parseLink() must stay pure and side-effect-free: every client runs it on
 * the same stored URL and MUST arrive at the identical result. The only
 * ambient input is the page hostname, needed for Twitch's `parent` param;
 * pass it explicitly in tests.
 *
 * KNOWN CAVEATS (accepted, surfaced in the UI where relevant):
 *   - Drive rewrite (`/uc?export=download&id=…`) is unsupported by Google:
 *     fails on private files and large files (~100 MB+, virus-scan page).
 *   - Extension-less direct media URLs are kept playable ('direct',
 *     uncertain:true) for backward compatibility with the previous
 *     any-URL-went-to-<video> behaviour.
 */

/** All recognisable link kinds (see @file doc). */
export const LINK_KINDS = {
  DIRECT: 'direct',
  YOUTUBE: 'youtube',
  VIMEO: 'vimeo',
  DAILYMOTION: 'dailymotion',
  TWITCH_VOD: 'twitch-vod',
  TWITCH_LIVE: 'twitch-live',
}

const MEDIA_EXT_RE = /\.(mp4|m4v|webm|ogg|ogv|mov|m3u8)$/i

/**
 * Parse "1h2m30s" / "90" / "2m" style timestamps into seconds (or null).
 * @param {string} value
 * @returns {number|null}
 */
function parseStartParam(value) {
  if (!value) return null
  if (/^\d+$/.test(value)) return parseInt(value, 10)
  const m = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i)
  if (!m || (!m[1] && !m[2] && !m[3])) return null
  return (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + +(m[3] || 0)
}

/** Human label for an identifier column ("YouTube • dQw4…"). */
function providerLabel(provider, id) {
  const short = id.length > 18 ? id.slice(0, 18) + '…' : id
  return `${provider} • ${short}`
}

/** Basename of a URL path, query stripped, decoded (fallback: generic). */
function fileNameLabel(urlObj) {
  const base = decodeURIComponent(
    (urlObj.pathname.split('/').pop() || '').split('?')[0],
  )
  return base || urlObj.hostname
}

/**
 * Google Drive share-links → direct-file URL. Accepts the common shapes:
 *   drive.google.com/file/d/<ID>/view…
 *   docs.google.com/file/d/<ID>/edit…
 *   drive.google.com/open?id=<ID>
 *   drive.google.com/uc?id=<ID>&export=view
 *   drive.usercontent.google.com/download?id=<ID>&export=download…
 * @param {URL} urlObj
 * @returns {string|null} canonical download URL for the file id
 */
function driveDirectUrl(urlObj) {
  const fileMatch = urlObj.pathname.match(/\/file\/d\/([\w-]+)/)
  if (fileMatch) return driveDownloadUrl(fileMatch[1])
  const id = urlObj.searchParams.get('id')
  if (id) return driveDownloadUrl(id)
  return null
}

function driveDownloadUrl(id) {
  return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`
}

/**
 * Resolve a pasted link into a playback plan.
 *
 * @param {string} rawUrl          user-submitted link (http/https)
 * @param {string} [hostname]      embedding page origin for Twitch's
 *                                 `parent` param (defaults to location)
 * @returns {{ kind: string, sourceUrl: string,
 *            playbackUrl: string|null, embedUrl: string|null,
 *            label: string, driveHack: boolean,
 *            uncertain: boolean, syncCapable: boolean } | null}
 *          null only when rawUrl isn't a usable absolute http(s) URL
 */
export function parseLink(rawUrl, hostname = defaultHostname()) {
  if (typeof rawUrl !== 'string') return null
  const trimmed = rawUrl.trim()
  let url
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null

  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  const segments = url.pathname.split('/').filter(Boolean)

  // ── YouTube ──────────────────────────────────────────────────────────────
  if (
    host === 'youtube.com' ||
    host === 'm.youtube.com' ||
    host === 'music.youtube.com' ||
    host === 'youtube-nocookie.com' ||
    host === 'youtu.be'
  ) {
    let id = null
    if (host === 'youtu.be') {
      id = segments[0] || null
    } else if (segments[0] === 'watch') {
      id = url.searchParams.get('v')
    } else if (/^(shorts|embed|live)$/.test(segments[0] || '')) {
      id = segments[1] || null
    }
    if (id) {
      const start = parseStartParam(url.searchParams.get('t') || url.searchParams.get('start'))
      const list = url.searchParams.get('list')
      const params = new URLSearchParams({ rel: '0', playsinline: '1' })
      if (start) params.set('start', String(start))
      if (list) params.set('list', list)
      return {
        kind: LINK_KINDS.YOUTUBE,
        sourceUrl: trimmed,
        playbackUrl: null,
        // www.youtube.com rather than youtube-nocookie.com — the nocookie
        // host has had intermittent TLS/availability issues (2026) and the
        // regular host is what YouTube's own embed docs use.
        embedUrl: `https://www.youtube.com/embed/${encodeURIComponent(id)}?${params}`,
        label: providerLabel('YouTube', id),
        driveHack: false,
        uncertain: false,
        syncCapable: true,
      }
    }
  }

  // ── Google Drive (rewritten to a direct file → synced <video>) ───────────
  if (
    host === 'drive.google.com' ||
    host === 'docs.google.com' ||
    host === 'drive.usercontent.google.com'
  ) {
    const direct = driveDirectUrl(url)
    if (direct) {
      return {
        kind: LINK_KINDS.DIRECT,
        sourceUrl: trimmed,
        playbackUrl: direct,
        embedUrl: null,
        label: 'Google Drive video',
        driveHack: true,
        uncertain: false,
        syncCapable: true,
      }
    }
    // Other Google Docs pages are not videos — fall through to rejection
    // via the uncertain-direct branch below (they simply won't render).
  }

  // ── Vimeo ────────────────────────────────────────────────────────────────
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const idx = host === 'player.vimeo.com' ? 1 : 0 // player.vimeo.com/video/<id>
    const id = segments[idx]
    if (id && /^\d+$/.test(id)) {
      const hash = host === 'vimeo.com' ? segments[idx + 1] : null
      const suffix = hash ? `?h=${encodeURIComponent(hash)}` : ''
      return {
        kind: LINK_KINDS.VIMEO,
        sourceUrl: trimmed,
        playbackUrl: null,
        embedUrl: `https://player.vimeo.com/video/${encodeURIComponent(id)}${suffix}`,
        label: providerLabel('Vimeo', id),
        driveHack: false,
        uncertain: false,
        syncCapable: true,
      }
    }
  }

  // ── Dailymotion ──────────────────────────────────────────────────────────
  if (host === 'dailymotion.com' || host === 'dai.ly') {
    const id =
      host === 'dailymotion.com' && segments[0] === 'video'
        ? segments[1]
        : segments[0]
    if (id) {
      return {
        kind: LINK_KINDS.DAILYMOTION,
        sourceUrl: trimmed,
        playbackUrl: null,
        embedUrl: `https://geo.dailymotion.com/player.html?video=${encodeURIComponent(id)}`,
        label: providerLabel('Dailymotion', id),
        driveHack: false,
        uncertain: false,
        syncCapable: true,
      }
    }
  }

  // ── Twitch ───────────────────────────────────────────────────────────────
  if (host === 'twitch.tv' || host === 'm.twitch.tv') {
    if (segments[0] === 'videos' && segments[1]) {
      const id = segments[1]
      return {
        kind: LINK_KINDS.TWITCH_VOD,
        sourceUrl: trimmed,
        playbackUrl: null,
        embedUrl: `https://player.twitch.tv/?video=${encodeURIComponent(id)}&parent=${encodeURIComponent(hostname)}&autoplay=false`,
        label: providerLabel('Twitch VOD', id),
        driveHack: false,
        uncertain: false,
        syncCapable: true,
      }
    }
    const channel = segments[0]
    if (channel && /^[A-Za-z0-9_]{3,25}$/.test(channel) && !['directory', 'downloads', 'p', 'settings', 'search'].includes(channel.toLowerCase())) {
      return {
        kind: LINK_KINDS.TWITCH_LIVE,
        sourceUrl: trimmed,
        playbackUrl: null,
        embedUrl: `https://player.twitch.tv/?channel=${encodeURIComponent(channel)}&parent=${encodeURIComponent(hostname)}&autoplay=false`,
        label: providerLabel('Twitch', channel),
        driveHack: false,
        uncertain: false,
        syncCapable: false, // live: no seek/duration → watch-together off
      }
    }
  }

  // ── Direct media (explicit extension) or best-guess fallback ────────────
  const explicit = MEDIA_EXT_RE.test(url.pathname)
  return {
    kind: LINK_KINDS.DIRECT,
    sourceUrl: trimmed,
    playbackUrl: trimmed,
    embedUrl: null,
    label: fileNameLabel(url),
    driveHack: false,
    uncertain: !explicit, // no media extension — may or may not play natively
    syncCapable: true,
  }
}

function defaultHostname() {
  return typeof window !== 'undefined' && window.location
    ? window.location.hostname
    : 'localhost'
}
