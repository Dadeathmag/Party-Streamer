/**
 * @file Room page — the watch-party screen.
 *
 * This component is the *orchestrator*: it owns all playback/chat state and
 * the Socket.IO sync wiring, then delegates rendering to focused components:
 *
 *   <VideoStage>       video element / empty state + members overlay
 *   <PlayerControls>   seek bar, transport buttons, volume, time readout
 *   <ChatPanel>        live-chat sidebar
 *
 * Sync model (Phase 4): the host is the single source of truth. Host
 * interactions call broadcastPlayback(), which fans SYNC_PLAY/PAUSE/SEEK
 * out over every viewer's DataChannel and dual-sends the legacy
 * 'playback:sync' Socket.IO relay as a temporary fallback — a monotonic
 * `seq` makes the duplicate idempotent for guests. While playing, the host
 * also publishes SYNC_BEACON state snapshots every BEACON_INTERVAL_MS so
 * viewers soft-correct drift (playbackRate nudge, snap-seek past the
 * threshold) and late joiners converge without waiting for an interaction.
 * Guests receive via onPeerPlaybackSync (DataChannel) and onPlaybackSync
 * (relay), both funneled into one applier below. Guests' own controls work
 * locally but are never broadcast.
 *
 * Media distribution: the host picks a streaming mode in the mode bar —
 *   'p2p'   local file streamed P2P in chunks, played progressively via MSE
 *           (formats MSE can't ingest abort with an error — use 'full';
 *           network/fileSender.js + fileReceiver.js)
 *   'full'  same P2P transfer, but guests only get playback after the whole
 *           file has arrived (delivery:'full' on FILE_OFFER)
 *   'url'   host pastes a share-link that every client loads itself; no P2P
 *           transfer at all. lib/linkEmbed.js classifies the link — direct
 *           files (and rewritten Google Drive links) play through the synced
 *           native <video>; YouTube/Vimeo/Dailymotion/Twitch render in an
 *           iframe driven by lib/embedSurface.js behind the SAME playback
 *           surface interface, so the sync protocol below is unchanged.
 *           Twitch LIVE channels expose no seek/duration → transport is
 *           disabled and watch-together sync is off for them.
 * The mode is stored server-side and broadcast via 'stream:mode-changed'
 * (see useSocket), so late joiners sync up through their join ack. All P2P
 * networking flows through props provided by usePeerNetwork (App.jsx).
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { ArrowLeftIcon, UploadIcon, DownloadIcon, LinkIcon, GlobeIcon, LockIcon, UnlockIcon, UsersIcon } from '../components/Icons.jsx'
import VideoStage from '../components/VideoStage.jsx'
import PlayerControls from '../components/PlayerControls.jsx'
import ChatPanel from '../components/ChatPanel.jsx'
import {
  BEACON_INTERVAL_MS,
  DRIFT_NUDGE_THRESHOLD_S,
  DRIFT_SEEK_THRESHOLD_S,
  RATE_NUDGE_LIMIT,
} from '../network/roomProtocol.js'
import { LINK_KINDS, parseLink } from '../lib/linkEmbed.js'
import { createEmbedSurface } from '../lib/embedSurface.js'
import './Room.css'

const SAMPLE_MESSAGES = [
  { id: 0, user: 'System', text: 'Welcome to the party! 🎉', system: true },
]

const STREAM_MODE_LABELS = { p2p: 'P2P', full: 'Full transfer', url: 'Link' }
const STREAM_MODE_HINTS = {
  p2p: 'Viewers start watching while the file streams over P2P.',
  full: 'Viewers download the whole file first, then playback begins.',
  url: 'Everyone loads the shared link directly — no P2P transfer.',
}

/**
 * @param {object} props
 * @param {{ name: string, code: string, role: 'host'|'member', displayName: string }} props.roomInfo
 * @param {() => void} props.onLeave
 * @param {Array<{ socketId: string, displayName: string, role: string }>} props.members
 * @param {string | null} props.myId   this client's socket id (marks own chat msgs)
 * @param {(cb: (data: { action: string, time: number, seq?: number }) => void) => void}
 *        props.onPlaybackSync         guest: host sync via the Socket.IO relay
 *                                     (temporary fallback transport)
 * @param {(text: string) => void} props.sendChat
 * @param {(cb: (data: { from: string, displayName: string, text: string, ts: number }) => void) => void} props.onChatMessage
 * @param {(cb: (displayName: string) => void) => void} props.onMemberJoined
 * @param {(cb: (displayName: string) => void) => void} props.onMemberLeft
 * @param {(cb: () => void) => void} props.onHostLeft
 * @param {(file: File, delivery?: string) => void} props.sendFile
 *        host: stream file to viewers ('progressive' | 'full')
 * @param {() => void} props.cancelTransfers   abort in-flight transfers + forget current file
 * @param {(el: HTMLVideoElement|null) => void} props.registerVideoElement
 * @param {(action: 'play'|'pause'|'seek', time: number) => void}
 *        props.broadcastPlayback      host: push a sync command over every
 *                                     viewer DataChannel (+ socket fallback)
 * @param {(time: number) => void} props.broadcastBeacon
 *        host: publish a { time, playing } state snapshot (drift correction,
 *        late-joiner convergence)
 * @param {{ direction: 'send'|'receive', name: string, pct: number } | null}
 *        props.transferStatus
 * @param {(cb: (info: { url: string | null, name: string }) => void) => void}
 *        props.onRemoteVideoReady   guest: streamed video is playable
 * @param {(cb: (err: Error) => void) => void} props.onTransferError
 * @param {(cb: (msg: { kind: 'command'|'beacon', action?: string,
 *          playing?: boolean, time: number, seq: number|null }) => void) => void}
 *        props.onPeerPlaybackSync   guest: host sync over DataChannels
 * @param {{ type: 'p2p'|'full'|'url', url: string | null } | null}
 *        props.streamMode           room's current streaming mode (host-set;
 *                                    also the source of truth in link mode)
 * @param {(type: string, url?: string|null) => Promise<{ ok: boolean, mode?: object, error?: string }>}
 *        props.sendStreamMode       host: change the streaming mode
 * @param {(cb: (mode: { type: string, url: string | null }) => void) => void}
 *        props.onStreamModeChanged  live streaming-mode transitions
 * @param {boolean} props.isPublic          whether the room is publicly listed
 * @param {boolean} props.locked            true when joins are blocked by the host
 * @param {(isPublic: boolean) => Promise<{ ok: boolean, error?: string }>}
 *        props.setVisibility               host: toggle private/public
 * @param {(locked: boolean) => Promise<{ ok: boolean, locked?: boolean, error?: string }>}
 *        props.setLocked                   host: lock/unlock the room door
 * @param {(socketId: string) => Promise<{ ok: boolean, error?: string }>}
 *        props.kickMember                  host: remove a member
 * @param {(cb: () => void) => void} props.onKicked
 *        this client was removed from the room by the host
 * @param {(cb: (info: { isPublic: boolean }) => void) => void}
 *        props.onVisibilityChanged         live visibility transitions
 * @param {(cb: (info: { locked: boolean }) => void) => void}
 *        props.onLockChanged               live lock transitions
 */
function Room({ roomInfo, onLeave, members = [], myId, onPlaybackSync, sendChat, onChatMessage, onMemberJoined, onMemberLeft, onHostLeft, sendFile, cancelTransfers, registerVideoElement, broadcastPlayback, broadcastBeacon, transferStatus, onRemoteVideoReady, onTransferError, onPeerPlaybackSync, streamMode, sendStreamMode, onStreamModeChanged, isPublic, locked, setVisibility, setLocked, kickMember, onKicked, onVisibilityChanged, onLockChanged }) {
  const { name, code, role } = roomInfo
  const isHost = role === 'host'
  // The room's active streaming mode ('p2p' until the host changes it).
  const activeStreamType = streamMode?.type || 'p2p'

  // ── State ─────────────────────────────────────────────────────────────────
  const [messages, setMessages] = useState(SAMPLE_MESSAGES)
  const [chatInput, setChatInput] = useState('')
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(0.8)
  const [isMuted, setIsMuted] = useState(false)
  const [videoSrc, setVideoSrc] = useState(null)
  const [videoName, setVideoName] = useState('')
  const [mediaReady, setMediaReady] = useState(false)
  const [showMembers, setShowMembers] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [chatCollapsed, setChatCollapsed] = useState(false)
  const [urlDraft, setUrlDraft] = useState('')
  const [urlInputOpen, setUrlInputOpen] = useState(false)
  const [embedError, setEmbedError] = useState(null)

  // ── Refs ──────────────────────────────────────────────────────────────────
  const videoRef = useRef(null)
  const chatEndRef = useRef(null)
  const fileInputRef = useRef(null)
  const progressRef = useRef(null)
  const nextMsgIdRef = useRef(1)
  const lastFileRef = useRef(null)
  // Provider-embed plumbing (link mode): mount point + active controller.
  const embedContainerRef = useRef(null)
  const embedSurfaceRef = useRef(null)
  /** Last play-state we broadcast for the current embed (echo dedup). */
  const lastEmbedPlayStateRef = useRef(false)
  /** Drive-hack caveat shown once per link. */
  const warnedDriveUrlRef = useRef(null)
  // Latest-value mirrors so the async embed creation can apply the current
  // audio state without re-mounting the player when volume changes later.
  const volumeRef = useRef(volume)
  const isMutedRef = useRef(isMuted)
  useEffect(() => { volumeRef.current = volume }, [volume])
  useEffect(() => { isMutedRef.current = isMuted }, [isMuted])

  // ── Effects ───────────────────────────────────────────────────────────────

  // Chat helper (declared early: several effects below append system lines).
  const addSystemMessage = (text) => {
    setMessages(prev => [...prev, {
      id: nextMsgIdRef.current++,
      user: 'System',
      text,
      system: true,
    }])
  }

  // Auto-scroll chat to the latest message.
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Track video time/duration/ended events for the controls UI. The <video>
  // element is always mounted (VideoStage), so listeners attach once.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const handleTime = () => setCurrentTime(video.currentTime)
    const handleDuration = () => {
      setDuration(video.duration)
      setMediaReady(true)
    }
    const handleEnded = () => setIsPlaying(false)
    video.addEventListener('timeupdate', handleTime)
    video.addEventListener('loadedmetadata', handleDuration)
    video.addEventListener('ended', handleEnded)
    return () => {
      video.removeEventListener('timeupdate', handleTime)
      video.removeEventListener('loadedmetadata', handleDuration)
      video.removeEventListener('ended', handleEnded)
    }
  }, [])

  // Hand the <video> element to the P2P layer (guest MediaSource attach).
  useEffect(() => {
    registerVideoElement?.(videoRef.current)
    return () => registerVideoElement?.(null)
  }, [registerVideoElement])

  // Guests: bounce back to home when the host leaves.
  useEffect(() => {
    if (isHost) return
    onHostLeft?.(() => {
      alert('The host has left the room.')
      onLeave()
    })
  }, [isHost, onHostLeft, onLeave])

  // Everyone: bounce back to home when removed by the host.
  useEffect(() => {
    onKicked?.(() => {
      alert('You were removed from the room by the host.')
      onLeave()
    })
  }, [onKicked, onLeave])

  // ── Playback surface (native <video> ⇄ provider embed) ──────────────────
  // Every sync path below talks to ONE interface. In link mode the embed
  // controller (lib/embedSurface.js) takes over; otherwise the native
  // element answers. Both are read through refs, so this never goes stale.

  const getNativeSurface = () => {
    const v = videoRef.current
    if (!v) return null
    return {
      play: () => v.play().catch(() => {}),
      pause: () => v.pause(),
      seek: (t) => { try { v.currentTime = t } catch { /* not seekable yet */ } },
      getTime: () => (Number.isFinite(v.currentTime) ? v.currentTime : 0),
      getDuration: () => (Number.isFinite(v.duration) ? v.duration : 0),
      isPaused: () => v.paused,
      setVolume: (val) => { v.volume = val },
      setMuted: (m) => { v.muted = m },
      setRate: (r) => { v.playbackRate = r },
    }
  }

  const getSurface = useCallback(
    () => embedSurfaceRef.current ?? getNativeSurface(),
    [],
  )

  // ── Link mode classification (pure; identical on every client) ───────────

  const urlMode = activeStreamType === 'url'
  const sharedUrl = streamMode?.url ?? null
  const parsedLink = useMemo(() => {
    if (!urlMode || !sharedUrl) return null
    return parseLink(sharedUrl)
  }, [urlMode, sharedUrl])
  /** Non-null when the link needs an iframe player instead of <video>. */
  const embedLink = parsedLink && parsedLink.kind !== LINK_KINDS.DIRECT ? parsedLink : null
  const syncEnabled = !embedLink || embedLink.syncCapable

  // Reset transient playback state whenever the media source identity
  // changes (new link, link removed, room entered mid-stream). Done as a
  // render-time derivation — the documented React pattern for "reset state
  // when a prop changes" — so stale time/duration from the previous source
  // never paints.
  const sourceKey = embedLink ? `${embedLink.kind}:${embedLink.embedUrl}` : null
  const [seenSourceKey, setSeenSourceKey] = useState(null)
  if (sourceKey !== seenSourceKey) {
    setSeenSourceKey(sourceKey)
    setIsPlaying(false)
    setCurrentTime(0)
    setDuration(0)
    setMediaReady(false)
    setEmbedError(null)
  }

  // Surface the Drive-hack caveat exactly once per link (host + guests).
  useEffect(() => {
    if (!parsedLink?.driveHack || !sharedUrl) return
    if (warnedDriveUrlRef.current === sharedUrl) return
    warnedDriveUrlRef.current = sharedUrl
    addSystemMessage(
      'Google Drive link converted to direct playback — private or very large files may fail to load.',
    )
  }, [parsedLink, sharedUrl])

  // Provider-initiated play-state changes (user clicked inside the iframe).
  // Kept behind a latest-ref so the embed never needs remounting when host
  // state or callbacks change identity. Hosts re-broadcast the transition
  // (echo-deduped against commands we issued ourselves); guests only mirror
  // it locally — their controls are never broadcast.
  const embedPlayStateRef = useRef(null)
  useEffect(() => {
    embedPlayStateRef.current = (playing) => {
      setIsPlaying(playing)
      if (!isHost || !syncEnabled) return
      if (playing === lastEmbedPlayStateRef.current) return
      lastEmbedPlayStateRef.current = playing
      broadcastPlayback?.(playing ? 'play' : 'pause', getSurface()?.getTime() ?? 0)
    }
  }, [isHost, syncEnabled, broadcastPlayback, getSurface])

  // Mount/unmount the provider-embed controller for non-direct links.
  // StrictMode-safe: async creation adopts the surface only if this mount is
  // still live; otherwise it destroys it immediately.
  useEffect(() => {
    embedSurfaceRef.current = null
    lastEmbedPlayStateRef.current = false
    if (!embedLink) return undefined

    let disposed = false
    createEmbedSurface(embedContainerRef.current, embedLink, {
      onTimeUpdate: (t, d) => {
        if (disposed) return
        setCurrentTime(t)
        if (d > 0) setDuration(d)
      },
      onMeta: ({ duration }) => {
        if (disposed) return
        setDuration(duration)
        setMediaReady(true)
      },
      onPlayState: (playing) => embedPlayStateRef.current?.(playing),
      onEnded: () => { if (!disposed) setIsPlaying(false) },
      onError: (message) => {
        if (disposed) return
        setEmbedError(message)
        addSystemMessage(`Link playback problem: ${message}`)
      },
    })
      .then((surface) => {
        if (disposed) {
          surface.destroy()
          return
        }
        embedSurfaceRef.current = surface
        surface.setVolume(volumeRef.current)
        surface.setMuted(isMutedRef.current)
        // The first poll tick may already have cached metadata.
        const d = surface.getDuration()
        if (d > 0) {
          setDuration(d)
          setMediaReady(true)
        }
      })
      .catch((err) => {
        if (disposed) return
        setEmbedError(err?.message || 'Could not load the embedded player.')
      })

    return () => {
      disposed = true
      embedSurfaceRef.current?.destroy()
      embedSurfaceRef.current = null
    }
  }, [embedLink])

  // ── Host sync application (guests, both transports) ──────────────────────

  // One applier fed by the DataChannel path (primary) and the Socket.IO
  // relay (temporary fallback). Commands carry the host's monotonic `seq`,
  // so whichever copy arrives first is applied and the duplicate dropped.
  const lastAppliedSeqRef = useRef(-1)

  const applyHostSync = useCallback((msg) => {
    if (!msg) return
    const surface = getSurface()
    if (!surface) return

    if (typeof msg.seq === 'number') {
      if (msg.seq <= lastAppliedSeqRef.current) return
      lastAppliedSeqRef.current = msg.seq
    }

    if (msg.kind === 'beacon') {
      // Reconcile desired state first — a late joiner may still be paused.
      if (msg.playing && surface.isPaused()) {
        surface.play()
        setIsPlaying(true)
      } else if (!msg.playing && !surface.isPaused()) {
        surface.pause()
        surface.setRate(1)
        setIsPlaying(false)
        return
      }
      if (!msg.playing) return

      // Drift correction while playing: snap hard past the seek threshold,
      // otherwise nudge playback rate toward the host clock and relax to 1x
      // once close enough. Providers without rate control no-op the nudge,
      // leaving snap-seek as their correction mechanism.
      const drift = msg.time - surface.getTime()
      const absDrift = Math.abs(drift)
      if (absDrift > DRIFT_SEEK_THRESHOLD_S) {
        surface.seek(msg.time)
        surface.setRate(1)
      } else if (absDrift > DRIFT_NUDGE_THRESHOLD_S) {
        surface.setRate(Math.min(
          1 + RATE_NUDGE_LIMIT,
          Math.max(1 - RATE_NUDGE_LIMIT, 1 + drift * 0.1),
        ))
      } else {
        surface.setRate(1)
      }
      return
    }

    switch (msg.action) {
      case 'play':
        surface.seek(msg.time)
        surface.play()
        surface.setRate(1)
        setIsPlaying(true)
        break
      case 'pause':
        surface.pause()
        surface.seek(msg.time)
        surface.setRate(1)
        setIsPlaying(false)
        break
      case 'seek':
        surface.seek(msg.time)
        break
    }
  }, [getSurface])

  // DataChannel path: pre-normalized by usePeerNetwork.
  useEffect(() => {
    if (isHost) return
    onPeerPlaybackSync?.(applyHostSync)
  }, [isHost, onPeerPlaybackSync, applyHostSync])

  // Socket.IO relay path: normalize into the same shape before applying.
  useEffect(() => {
    if (isHost) return
    onPlaybackSync?.((data) => {
      applyHostSync({
        kind: 'command',
        action: data?.action,
        time: typeof data?.time === 'number' && Number.isFinite(data.time) ? data.time : 0,
        seq: typeof data?.seq === 'number' ? data.seq : null,
      })
    })
  }, [isHost, onPlaybackSync, applyHostSync])

  // Host: periodic state beacons over the viewer DataChannels so drifting
  // viewers soft-correct and late joiners pick up current playback within
  // one interval instead of waiting for the next interaction. Sync-capable
  // links beacon from the embed surface; live channels skip beacons entirely.
  useEffect(() => {
    if (!isHost || !isPlaying || !mediaReady || !syncEnabled || !broadcastBeacon) return
    const fire = () => {
      const t = getSurface()?.getTime()
      if (Number.isFinite(t)) broadcastBeacon(t)
    }
    fire()
    const timer = setInterval(fire, BEACON_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [isHost, isPlaying, mediaReady, syncEnabled, broadcastBeacon, getSurface])

  // Guests: a streamed video from the host became playable (or finished
  // assembling). url === null means MSE is already wired to our <video>.
  useEffect(() => {
    onRemoteVideoReady?.(({ url, name }) => {
      if (url) setVideoSrc(url)
      setVideoName(name)
      setIsPlaying(false)
      setCurrentTime(0)
      addSystemMessage(`Now playing: ${name}`)
    })
  }, [onRemoteVideoReady])

  // Both roles: surface P2P transfer failures in chat.
  useEffect(() => {
    onTransferError?.((err) => addSystemMessage(`Video transfer failed: ${err.message}`))
  }, [onTransferError])

  // Both roles: live streaming-mode changes. URL mode tears down any P2P
  // transfer and opens the link input (host); file/full modes are driven by
  // the P2P FILE_OFFER handshake that follows, so only the chat note fires.
  // The initial join state arrives via the streamMode PROP and is rendered
  // directly below — this listener only handles transitions.
  const seenStreamTypeRef = useRef(activeStreamType)
  useEffect(() => {
    onStreamModeChanged?.((mode) => {
      if (!mode) return
      const previous = seenStreamTypeRef.current
      seenStreamTypeRef.current = mode.type
      if (mode.type === 'url') {
        cancelTransfers?.()
        setUrlInputOpen(true)
        setUrlDraft((d) => d || mode.url || '')
        if (previous !== 'url') addSystemMessage('Host switched to link streaming')
        return
      }
      if (previous === 'url') {
        addSystemMessage(
          `Streaming mode switched to ${mode.type === 'full' ? 'full transfer' : 'P2P'}`
        )
      }
    })
  }, [onStreamModeChanged, cancelTransfers])

  // Chat: the server broadcasts every message to the whole room INCLUDING the
  // sender, so this listener is the single place history gets appended from.
  useEffect(() => {
    onChatMessage?.(({ from, displayName: senderName, text }) => {
      setMessages(prev => [...prev, {
        id: nextMsgIdRef.current++,
        user: senderName,
        text,
        isOwn: from === myId,
      }])
    })
  }, [myId, onChatMessage])

  // ── Playback handlers (broadcast when host, local-only otherwise) ────────
  // All commands go through the unified playback surface — the native
  // <video> in file/direct-link modes, or the provider embed controller in
  // embed-link modes. Hosts broadcast; guests apply locally only.

  const togglePlay = () => {
    const surface = getSurface()
    if (!surface) return
    const next = !isPlaying
    if (next) surface.play()
    else surface.pause()
    if (isHost && syncEnabled) {
      if (embedLink) {
        // The provider will echo this state back via onPlayState; mark it
        // as already-broadcast so the echo doesn't send a duplicate.
        lastEmbedPlayStateRef.current = next
      }
      broadcastPlayback?.(next ? 'play' : 'pause', surface.getTime())
    }
    setIsPlaying(next)
  }

  const handleSeek = (e) => {
    const surface = getSurface()
    if (!surface || !progressRef.current) return
    const rect = progressRef.current.getBoundingClientRect()
    const clickPct = (e.clientX - rect.left) / rect.width
    const newTime = Math.min(Math.max(clickPct * duration, 0), duration || Infinity)
    surface.seek(newTime)
    if (isHost && syncEnabled) broadcastPlayback?.('seek', newTime)
  }

  const skip = (seconds) => {
    const surface = getSurface()
    if (!surface) return
    const target = surface.getTime() + seconds
    surface.seek(target)
    if (isHost && syncEnabled) broadcastPlayback?.('seek', target)
  }

  // ── Volume handlers (always local — never synced) ─────────────────────────

  const handleVolume = (e) => {
    const val = parseFloat(e.target.value)
    setVolume(val)
    getSurface()?.setVolume(val)
    setIsMuted(val === 0)
  }

  const toggleMute = () => {
    const next = !isMuted
    setIsMuted(next)
    getSurface()?.setMuted(next)
  }

  // ── Media selection (host only) ───────────────────────────────────────────

  const handleFileSelect = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    // Selecting a file while link-streaming implies switching back.
    if (activeStreamType === 'url' && sendStreamMode) {
      const res = await sendStreamMode('p2p')
      if (!res?.ok) {
        addSystemMessage(`Could not switch streaming mode: ${res?.error || 'unknown error'}`)
        return
      }
    }
    lastFileRef.current = file
    const url = URL.createObjectURL(file)
    setVideoSrc(url)
    setVideoName(file.name)
    setIsPlaying(false)
    setCurrentTime(0)
    setMediaReady(false)
    addSystemMessage(`Now playing: ${file.name}`)
    // Also distribute the file itself to connected viewers (P2P chunks),
    // delivered progressively or as a full transfer per the streaming mode.
    sendFile?.(file, activeStreamType === 'full' ? 'full' : 'progressive')
    e.target.value = '' // allow re-selecting the same file later
  }

  // ── Streaming mode (host only; guests see a read-only indicator) ──────────

  const applyStreamType = async (type, url = null) => {
    if (!sendStreamMode) return
    const previous = activeStreamType
    const res = await sendStreamMode(type, url)
    if (!res?.ok) {
      addSystemMessage(`Could not switch streaming mode: ${res?.error || 'unknown error'}`)
      return
    }
    // Re-send the current file under the new delivery so viewers restart in
    // the chosen mode (no-op when nothing is loaded or mode didn't change).
    if (previous !== type && lastFileRef.current && type !== 'url') {
      sendFile?.(lastFileRef.current, type === 'full' ? 'full' : 'progressive')
    }
  }

  const selectStreamType = async (type) => {
    setUrlInputOpen(type === 'url')
    if (type !== 'url') await applyStreamType(type)
  }

  const handleUrlSubmit = async (e) => {
    e.preventDefault()
    const trimmed = urlDraft.trim()
    if (!trimmed) return
    if (!/^https?:\/\//i.test(trimmed)) {
      addSystemMessage('Media URL must start with http:// or https://')
      return
    }
    await applyStreamType('url', trimmed)
  }

  // ── Member removal (host only; guests never see the buttons) ─────────────

  const handleKickMember = async (socketId) => {
    const res = await kickMember?.(socketId)
    if (!res?.ok) {
      addSystemMessage(`Could not remove member: ${res?.error || 'unknown error'}`)
    }
  }

  // Chat: system lines when other members join or leave the party.
  useEffect(() => {
    onMemberJoined?.((joinedName) => addSystemMessage(`${joinedName} joined the party`))
    onMemberLeft?.(({ displayName, kicked }) =>
      addSystemMessage(kicked ? `${displayName} was removed by the host` : `${displayName} left the party`)
    )
  }, [onMemberJoined, onMemberLeft])

  // Everyone: note host visibility changes in chat (initial value arrives
  // via the isPublic prop and stays silent).
  const seenPublicRef = useRef(isPublic)
  useEffect(() => {
    onVisibilityChanged?.(({ isPublic: pub }) => {
      if (pub !== seenPublicRef.current) {
        seenPublicRef.current = pub
        addSystemMessage(pub ? 'Room is now public — listed in the room browser' : 'Room is now private')
      }
    })
  }, [onVisibilityChanged])

  // Everyone: note room lock changes in chat (initial value stays silent).
  const seenLockedRef = useRef(locked)
  useEffect(() => {
    onLockChanged?.(({ locked: isLocked }) => {
      if (isLocked !== seenLockedRef.current) {
        seenLockedRef.current = isLocked
        addSystemMessage(isLocked ? 'Room locked — new members cannot join' : 'Room unlocked — new members can join again')
      }
    })
  }, [onLockChanged])

  const sendMessage = () => {
    const text = chatInput.trim()
    if (!text) return
    sendChat?.(text)
    setChatInput('')
  }

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {})
    } else {
      document.exitFullscreen()
    }
  }

  // Native exits (Esc / F11) must stay in sync with our icon state.
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onFsChange)
    return () => document.removeEventListener('fullscreenchange', onFsChange)
  }, [])

  const pct = duration ? (currentTime / duration) * 100 : 0

  // Link mode serves the shared URL straight from the mode state — no state
  // syncing needed. File modes fall back to the selected/received source.
  const displaySrc =
    activeStreamType === 'url' ? streamMode?.url || null : videoSrc
  const displayName =
    activeStreamType === 'url'
      ? streamMode?.url?.split('/').pop()?.split('?')[0] || 'Host link'
      : videoName

  const incomingLabel =
    transferStatus?.direction === 'receive'
      ? `Receiving "${transferStatus.name}"… ${Math.round(transferStatus.pct)}%`
      : null
  const sendingLabel =
    transferStatus?.direction === 'send'
      ? `Streaming "${transferStatus.name}" to viewers… ${Math.round(transferStatus.pct)}%`
      : null

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className={`room ${isFullscreen ? 'room--fullscreen' : ''}`}>
      {/* ── Top Bar ── */}
      <header className="room__topbar">
        <div className="room__topbar-left">
          <button className="room__back-btn" id="btn-leave-room" onClick={onLeave} title="Leave room">
            <ArrowLeftIcon size={18} />
          </button>
          <div className="room__info">
            <h1 className="room__name">{name}</h1>
            <div className="room__meta">
              <span className={`room__role-badge ${isHost ? 'room__role-badge--host' : 'room__role-badge--member'}`}>
                {isHost ? '★ HOST' : '● MEMBER'}
              </span>
              <span className="room__code-badge" title="Room Code">
                <LockIcon size={12} />
                {code}
              </span>
              {isHost ? (
                <button
                  className={`room__vis-toggle ${isPublic ? 'room__vis-toggle--public' : ''}`}
                  id="btn-toggle-visibility"
                  onClick={() => setVisibility?.(!isPublic)}
                  title={
                    isPublic
                      ? 'Public — listed in the room browser. Click to make private'
                      : 'Private — join with the code only. Click to make public'
                  }
                >
                  {isPublic ? <GlobeIcon size={11} /> : <LockIcon size={11} />}
                  <span className="room__vis-label">{isPublic ? 'Public' : 'Private'}</span>
                </button>
              ) : (
                <span className="room__vis-toggle room__vis-toggle--static" title="Room visibility">
                  {isPublic ? <GlobeIcon size={11} /> : <LockIcon size={11} />}
                  <span className="room__vis-label">{isPublic ? 'Public' : 'Private'}</span>
                </span>
              )}
              {locked && !isHost && (
                <span className="room__vis-toggle room__vis-toggle--static room__vis-toggle--locked" title="New members cannot join">
                  <LockIcon size={11} />
                  <span className="room__vis-label">Locked</span>
                </span>
              )}
              {isHost && !isPublic && (
                <button
                  className={`room__vis-toggle ${locked ? 'room__vis-toggle--locked' : ''}`}
                  id="btn-toggle-lock"
                  onClick={() => setLocked?.(!locked)}
                  aria-pressed={locked}
                  title={
                    locked
                      ? 'Locked — nobody can join while this is lit. Click to unlock'
                      : 'Lock the room so nobody can join, even with the code'
                  }
                >
                  {locked ? <LockIcon size={11} /> : <UnlockIcon size={11} />}
                  <span className="room__vis-label">Lock</span>
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="room__topbar-right">
          {isHost && (
            <button
              className="room__action-btn room__action-btn--accent"
              id="btn-select-video"
              onClick={() => fileInputRef.current?.click()}
              title="Select video"
            >
              <UploadIcon size={16} />
              <span className="room__action-label">Select Video</span>
            </button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*"
            onChange={handleFileSelect}
            style={{ display: 'none' }}
            id="input-video-file"
          />
          <button
            className={`room__action-btn ${showMembers ? 'room__action-btn--active' : ''}`}
            id="btn-toggle-members"
            onClick={() => setShowMembers(!showMembers)}
            title="Members"
          >
            <UsersIcon size={16} />
            <span className="room__action-label">{members.length}</span>
          </button>
        </div>
      </header>

      {/* ── Streaming Mode Bar ── */}
      <div className="room__mode-bar" id="mode-selector">
        <span className="room__mode-label">Streaming</span>
        {isHost ? (
          <>
            <div className="room__mode-seg" role="group" aria-label="Streaming mode">
              {['p2p', 'full', 'url'].map((type) => (
                <button
                  key={type}
                  id={`btn-mode-${type}`}
                  className={`room__mode-btn ${activeStreamType === type ? 'room__mode-btn--active' : ''}`}
                  onClick={() => selectStreamType(type)}
                  title={STREAM_MODE_HINTS[type]}
                >
                  {type === 'p2p' && <UploadIcon size={13} />}
                  {type === 'full' && <DownloadIcon size={13} />}
                  {type === 'url' && <LinkIcon size={13} />}
                  <span>{STREAM_MODE_LABELS[type]}</span>
                </button>
              ))}
            </div>
            {urlInputOpen && (
              <form className="room__url-form" onSubmit={handleUrlSubmit}>
                <input
                  id="input-stream-url"
                  className="room__url-input"
                  type="text"
                  placeholder="Paste a video link — YouTube, Drive, Vimeo, Twitch, direct MP4…"
                  value={urlDraft}
                  onChange={(e) => setUrlDraft(e.target.value)}
                  autoFocus
                />
                <button type="submit" className="room__url-load" id="btn-set-stream-url">
                  Load
                </button>
              </form>
            )}
            <span className="room__mode-hint">{STREAM_MODE_HINTS[activeStreamType]}</span>
          </>
        ) : (
          <span className="room__mode-hint">
            Host is streaming: {STREAM_MODE_LABELS[activeStreamType]}
          </span>
        )}
      </div>

      {/* ── Main Area ── */}
      <div className={`room__main ${chatCollapsed ? 'room__main--chat-collapsed' : ''}`}>
        {/* Video Panel */}
        <div className="room__video-panel">
          <VideoStage
            videoRef={videoRef}
            videoSrc={embedLink ? null : displaySrc}
            videoName={displayName}
            mediaReady={mediaReady}
            incomingLabel={incomingLabel}
            embedUrl={embedLink?.embedUrl || null}
            embedContainerRef={embedContainerRef}
            embedError={embedError}
            isHost={isHost}
            showMembers={showMembers}
            members={members}
            onKickMember={isHost ? handleKickMember : undefined}
            onSelectVideo={() => fileInputRef.current?.click()}
            onTogglePlay={togglePlay}
          />

          {sendingLabel && (
            <div className="room__transfer-status" id="transfer-status" role="status">
              {sendingLabel}
            </div>
          )}

          <PlayerControls
            progressRef={progressRef}
            pct={pct}
            onSeek={handleSeek}
            isPlaying={isPlaying}
            onTogglePlay={togglePlay}
            onSkip={skip}
            volume={volume}
            isMuted={isMuted}
            onVolumeChange={handleVolume}
            onToggleMute={toggleMute}
            currentTime={currentTime}
            duration={duration}
            videoName={displayName}
            isFullscreen={isFullscreen}
            onToggleFullscreen={toggleFullscreen}
            disabled={!syncEnabled}
          />
        </div>

        {/* Chat Sidebar */}
        <ChatPanel
          collapsed={chatCollapsed}
          onToggleCollapse={() => setChatCollapsed(!chatCollapsed)}
          messages={messages}
          chatEndRef={chatEndRef}
          chatInput={chatInput}
          onChatInput={setChatInput}
          onSend={sendMessage}
        />
      </div>
    </div>
  )
}

export default Room
