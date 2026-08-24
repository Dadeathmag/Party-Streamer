/**
 * @file embedSurface.js — controls remote-provider embeds (YouTube, Vimeo,
 * Dailymotion, Twitch) behind ONE surface object so pages/Room.jsx can drive
 * them exactly like the native <video> element through its existing sync
 * machinery (play/pause/seek broadcast + drift-correcting beacons).
 *
 * createEmbedSurface(container, parsedLink, handlers) → Promise<surface>
 *   surface = {
 *     play()  pause()  seek(t)      — command playback
 *     getTime() getDuration()       — synchronous cached reads (beacon loop)
 *     isPaused()                    — current best-known state
 *     setVolume(0..1) setMuted(bool) setRate(rate)
 *     destroy()
 *   }
 *
 * Provider APIs are loaded lazily from their official CDNs on first use and
 * shared across instances (script-once cache). Time/duration are kept fresh
 * by one 500 ms poll per surface plus provider events where available.
 *
 * Reliability notes:
 *   - Every provider call is wrapped: a throwing API call must never break
 *     the room UI; failures surface via handlers.onError instead.
 *   - Twitch live channels expose no duration → getDuration() stays 0 and
 *     callers keep transport controls disabled for that kind.
 *   - Programmatic play() may be rejected by browser autoplay policy until
 *     the viewer interacts once; the rejection is swallowed (guests re-sync
 *     via beacons) rather than treated as fatal.
 */

const POLL_INTERVAL_MS = 500
const SCRIPT_TIMEOUT_MS = 15000

/** Shared script-once loader resolving when `check()` sees the global. */
function loadScript(src, check, markerAttr) {
  if (check()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const done = () => {
      clearInterval(poll)
      clearTimeout(timeout)
      resolve()
    }
    let poll = setInterval(() => {
      if (check()) done()
    }, 100)
    const timeout = setTimeout(() => {
      clearInterval(poll)
      reject(new Error('Player took too long to load — check your connection or ad-blocker.'))
    }, SCRIPT_TIMEOUT_MS)
    if (!document.querySelector(`script[${markerAttr}]`)) {
      const el = document.createElement('script')
      el.src = src
      el.async = true
      el.setAttribute(markerAttr, '1')
      el.onerror = () => {
        clearInterval(poll)
        clearTimeout(timeout)
        reject(new Error('Could not load the provider player script.'))
      }
      document.head.appendChild(el)
    }
  })
}

const loadYouTubeApi = () => loadScript(
  'https://www.youtube.com/iframe_api',
  () => window.YT && window.YT.Player,
  'data-party-yt-api',
)

const loadVimeoApi = () => loadScript(
  'https://player.vimeo.com/api/player.js',
  () => window.Vimeo && window.Vimeo.Player,
  'data-party-vimeo-api',
)

const loadDailymotionApi = () => loadScript(
  'https://api.dmcdn.net/all.js',
  () => window.DM && window.DM.player,
  'data-party-dm-api',
)

const loadTwitchApi = () => loadScript(
  'https://embed.twitch.tv/embed/v1.js',
  () => window.Twitch && window.Twitch.Embed,
  'data-party-twitch-api',
)

/**
 * Build the embed surface for a parsed link inside `container`.
 * The container is CLEARED on destroy — never pass a node holding other UI.
 *
 * @param {HTMLElement} container           dedicated mount point
 * @param {{ kind: string, sourceUrl: string, embedUrl: string }} parsedLink
 *        result of linkEmbed.parseLink with a non-'direct' kind
 * @param {object} handlers
 * @param {(t: number, duration: number) => void} [handlers.onTimeUpdate]
 * @param {({ duration: number }) => void} [handlers.onMeta]   metadata ready
 * @param {(playing: boolean) => void} [handlers.onPlayState]
 * @param {() => void} [handlers.onEnded]
 * @param {(message: string) => void} [handlers.onError]
 * @returns {Promise<object>} the unified surface (see @file doc)
 */
export async function createEmbedSurface(container, parsedLink, handlers = {}) {
  switch (parsedLink.kind) {
    case 'youtube':
      return createYouTubeSurface(container, parsedLink, handlers)
    case 'vimeo':
      return createVimeoSurface(container, parsedLink, handlers)
    case 'dailymotion':
      return createDailymotionSurface(container, parsedLink, handlers)
    case 'twitch-vod':
    case 'twitch-live':
      return createTwitchSurface(container, parsedLink, handlers)
    default:
      throw new Error(`No embed player for link kind "${parsedLink.kind}".`)
  }
}

// ── Shared plumbing ────────────────────────────────────────────────────────

/**
 * State cache + poll loop shared by all adapters. Provider-specific getters
 * refresh it; consumers read synchronously. The first positive duration seen
 * fires onMeta exactly once — the single "metadata ready" signal callers use
 * to enable transport controls.
 */
function createSurfaceCore({ getTimeRaw, getDurationRaw, onMeta }) {
  const state = {
    time: 0,
    duration: 0,
    playing: false,
    metaFired: false,
    destroyed: false,
    lastPlayState: null,
  }

  const core = {
    state,
    /** Poll tick — safe to run against half-initialised providers. */
    tick(onTimeUpdate) {
      if (state.destroyed) return
      try {
        const t = getTimeRaw()
        if (typeof t === 'number' && Number.isFinite(t)) state.time = t
      } catch { /* not ready yet */ }
      try {
        const d = getDurationRaw()
        if (!state.metaFired && typeof d === 'number' && Number.isFinite(d) && d > 0) {
          state.duration = d
          state.metaFired = true
          onMeta?.({ duration: d })
        } else if (state.metaFired && typeof d === 'number' && Number.isFinite(d) && d > 0) {
          state.duration = d // live-updating durations (rare)
        }
      } catch { /* not ready yet */ }
      if (!state.destroyed) onTimeUpdate?.(state.time, state.duration)
    },
    /** Dedup + fan-out of provider play-state events. */
    setPlaying(playing, onPlayState) {
      state.playing = playing
      if (state.lastPlayState !== playing) {
        state.lastPlayState = playing
        onPlayState?.(playing)
      }
    },
    destroyPoll(timer) {
      state.destroyed = true
      clearInterval(timer)
    },
  }
  return core
}

/** Wrap one provider method so failures degrade to no-ops. */
function guard(fn, onError) {
  return (...args) => {
    try {
      return fn(...args)
    } catch (err) {
      onError?.(err?.message || String(err))
    }
  }
}

// ── YouTube ────────────────────────────────────────────────────────────────

async function createYouTubeSurface(container, parsedLink, handlers) {
  await loadYouTubeApi()

  const mount = document.createElement('div')
  mount.style.width = '100%'
  mount.style.height = '100%'
  container.appendChild(mount)

  // videoId is everything after /embed/ in our generated embed URL.
  const videoId = parsedLink.embedUrl.split('/embed/')[1]?.split('?')[0]

  const core = createSurfaceCore({
    getTimeRaw: () => player.getCurrentTime(),
    getDurationRaw: () => player.getDuration(),
    onMeta: handlers.onMeta,
  })

  // The IFrame API attaches its methods (playVideo, mute, …) asynchronously:
  // until `onReady` fires they don't exist on the player object and any call
  // throws "x is not a function". Commands issued before readiness are
  // buffered here and flushed in order on onReady.
  let player = null
  let ready = false
  let destroyed = false
  const pending = []
  const whenReady = (fn) => {
    if (ready) fn()
    else if (!destroyed) pending.push(fn)
  }

  player = new window.YT.Player(mount, {
    videoId,
    width: '100%',
    height: '100%',
    playerVars: { rel: 0, playsinline: 1, modestbranding: 1 },
    events: {
      onReady: () => {
        ready = true
        pending.splice(0).forEach((fn) => fn())
      },
      onStateChange: (e) => {
        if (e.data === window.YT.PlayerState.PLAYING) {
          core.setPlaying(true, handlers.onPlayState)
        } else if (e.data === window.YT.PlayerState.PAUSED) {
          core.setPlaying(false, handlers.onPlayState)
        } else if (e.data === window.YT.PlayerState.ENDED) {
          core.setPlaying(false, handlers.onPlayState)
          handlers.onEnded?.()
        }
      },
      onError: () => {
        handlers.onError?.('YouTube refused to play this video here (embedding may be disabled).')
      },
    },
  })

  const onError = (msg) => handlers.onError?.(msg)
  const timer = setInterval(() => core.tick(handlers.onTimeUpdate), POLL_INTERVAL_MS)

  return {
    play: guard(() => whenReady(() => player.playVideo()), onError),
    pause: guard(() => whenReady(() => player.pauseVideo()), onError),
    seek: guard((t) => whenReady(() => player.seekTo(t, true)), onError),
    getTime: () => core.state.time,
    getDuration: () => core.state.duration,
    isPaused: () => !core.state.playing,
    setVolume: guard((v) => whenReady(() => player.setVolume(Math.round(v * 100))), onError),
    setMuted: guard((m) => whenReady(() => (m ? player.mute() : player.unMute())), onError),
    setRate: guard((r) => whenReady(() => player.setPlaybackRate(r)), onError),
    destroy() {
      destroyed = true
      core.destroyPoll(timer)
      try { player?.destroy() } catch { /* already gone */ }
      container.innerHTML = ''
    },
  }
}

// ── Vimeo ──────────────────────────────────────────────────────────────────

async function createVimeoSurface(container, parsedLink, handlers) {
  await loadVimeoApi()

  const iframe = document.createElement('iframe')
  iframe.src = parsedLink.embedUrl
  iframe.allow = 'autoplay; fullscreen; picture-in-picture'
  iframe.className = 'room__embed-iframe'
  iframe.setAttribute('title', 'Vimeo player')
  container.appendChild(iframe)

  const core = createSurfaceCore({
    getTimeRaw: () => core.state.time, // event-fed only (SDK is async)
    getDurationRaw: () => core.state.duration,
    onMeta: handlers.onMeta,
  })

  const player = new window.Vimeo.Player(iframe)

  player.on('timeupdate', ({ seconds, duration }) => {
    core.state.time = seconds ?? core.state.time
    if (duration > 0) core.state.duration = duration
    handlers.onTimeUpdate?.(core.state.time, core.state.duration)
  })
  player.on('play', () => core.setPlaying(true, handlers.onPlayState))
  player.on('pause', () => core.setPlaying(false, handlers.onPlayState))
  player.on('ended', () => {
    core.setPlaying(false, handlers.onPlayState)
    handlers.onEnded?.()
  })
  player.on('error', () => handlers.onError?.('Vimeo could not play this video.'))

  const timer = setInterval(() => core.tick(handlers.onTimeUpdate), POLL_INTERVAL_MS)

  return {
    play: () => player.play().catch(() => {}),
    pause: () => player.pause().catch(() => {}),
    seek: (t) => player.setCurrentTime(t).catch(() => {}),
    getTime: () => core.state.time,
    getDuration: () => core.state.duration,
    isPaused: () => !core.state.playing,
    setVolume: (v) => player.setVolume(v).catch(() => {}),
    setMuted: (m) => player.setMuted(m).catch(() => {}),
    setRate: (r) => player.setPlaybackRate(r).catch(() => {}),
    destroy() {
      core.destroyPoll(timer)
      player.destroy().catch(() => {})
      container.innerHTML = ''
    },
  }
}

// ── Dailymotion ────────────────────────────────────────────────────────────

async function createDailymotionSurface(container, parsedLink, handlers) {
  await loadDailymotionApi()

  const core = createSurfaceCore({
    getTimeRaw: () => {
      try { return player.currentTime } catch { return null }
    },
    getDurationRaw: () => {
      try { return player.getDuration() } catch { return null }
    },
    onMeta: handlers.onMeta,
  })

  // video id rides the query of geo.dailymotion.com/player.html?video=<id>
  const videoId = parsedLink.embedUrl.split('video=')[1]?.split('&')[0]

  let player = null
  player = window.DM.player(container, {
    video: videoId,
    width: '100%',
    height: '100%',
    params: { autoplay: false },
  })

  player.addEventListener('playing', () => core.setPlaying(true, handlers.onPlayState))
  player.addEventListener('start', () => core.setPlaying(true, handlers.onPlayState))
  player.addEventListener('pause', () => core.setPlaying(false, handlers.onPlayState))
  player.addEventListener('end', () => {
    core.setPlaying(false, handlers.onPlayState)
    handlers.onEnded?.()
  })
  player.addEventListener('timeupdate', (e) => {
    if (typeof e?.time === 'number') core.state.time = e.time
    handlers.onTimeUpdate?.(core.state.time, core.state.duration)
  })
  player.addEventListener('error', () => handlers.onError?.('Dailymotion could not play this video.'))

  const onError = (msg) => handlers.onError?.(msg)
  const timer = setInterval(() => core.tick(handlers.onTimeUpdate), POLL_INTERVAL_MS)

  return {
    play: guard(() => player.play(), onError),
    pause: guard(() => player.pause(), onError),
    seek: guard((t) => player.seek(t), onError),
    getTime: () => core.state.time,
    getDuration: () => core.state.duration,
    isPaused: () => !core.state.playing,
    // DM's volume scale differs across SDK versions — try both.
    setVolume: guard((v) => {
      try { player.setVolume(Math.round(v * 100)) } catch { player.setVolume(v) }
    }, onError),
    setMuted: guard((m) => player.setMuted(m), onError),
    setRate: guard((r) => { if (player.setSpeed) player.setSpeed(r) }, onError),
    destroy() {
      core.destroyPoll(timer)
      try { if (player.destroy) player.destroy() } catch { /* older SDKs */ }
      container.innerHTML = ''
    },
  }
}

// ── Twitch ─────────────────────────────────────────────────────────────────

async function createTwitchSurface(container, parsedLink, handlers) {
  await loadTwitchApi()

  const mount = document.createElement('div')
  mount.style.width = '100%'
  mount.style.height = '100%'
  container.appendChild(mount)

  const url = new URL(parsedLink.embedUrl)
  const isVod = Boolean(url.searchParams.get('video'))
  const options = {
    width: '100%',
    height: '100%',
    layout: 'video',
    autoplay: false,
    parent: [window.location.hostname],
  }
  if (isVod) options.video = url.searchParams.get('video')
  else options.channel = url.searchParams.get('channel')

  const core = createSurfaceCore({
    getTimeRaw: () => getPlayer()?.getTime(),
    getDurationRaw: () => getPlayer()?.getDuration(),
    onMeta: handlers.onMeta,
  })

  const embed = new window.Twitch.Embed(mount, options)
  const getPlayer = () => {
    try { return embed.getPlayer() } catch { return null }
  }

  const onError = (msg) => handlers.onError?.(msg)
  const timer = setInterval(() => core.tick(handlers.onTimeUpdate), POLL_INTERVAL_MS)

  return {
    play: guard(() => getPlayer()?.play(), onError),
    pause: guard(() => getPlayer()?.pause(), onError),
    seek: guard((t) => getPlayer()?.seek(t), onError),
    getTime: () => core.state.time,
    getDuration: () => core.state.duration,
    isPaused: () => !core.state.playing,
    setVolume: guard((v) => getPlayer()?.setVolume(v), onError),
    setMuted: guard((m) => getPlayer()?.setMuted(m), onError),
    setRate: () => {}, // Twitch exposes no playback-rate control
    destroy() {
      core.destroyPoll(timer)
      container.innerHTML = '' // Embed has no official teardown
    },
  }
}
