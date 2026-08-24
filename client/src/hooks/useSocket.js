/**
 * @file useSocket — the client's single Socket.IO connection + room state.
 *
 * Owns everything realtime:
 *   - connection lifecycle (connect/disconnect/error flags)
 *   - membership list (updated by room:member-joined / room:member-left)
 *   - host-left notification forwarding
 *   - playback:sync send (host) and receive (guests)
 *   - chat:message send and receive (echoed back to the sender, so history
 *     is appended from a single source; mark "own" via myId === msg.from)
 *   - signal:* passthrough for WebRTC signaling (see usePeerNetwork):
 *     three server events fan into one onSignal callback; sendSignal maps a
 *     normalized kind back onto the matching wire event.
 *
 * The hook is mounted once in App.jsx; components receive slices of it as
 * props. See src/handlers/*.js in the server for the matching wire format.
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { io } from 'socket.io-client'

// Empty by default → Socket.IO connects to the same origin that served this
// page (Vite dev proxy forwards /socket.io to the signaling server). This
// makes guests on other devices work without extra config; override with
// VITE_SERVER_URL if the client and server are hosted on different origins.
const SERVER_URL = import.meta.env.VITE_SERVER_URL || ''
const CONNECT_TIMEOUT_MS = 5000

// WebRTC signaling event name ⇄ payload key + normalized kind (see
// server/src/handlers/signalHandlers.js for the wire format).
const SIGNAL_KINDS = [
  { kind: 'offer', key: 'offer' },
  { kind: 'answer', key: 'answer' },
  { kind: 'ice-candidate', key: 'candidate' },
]

/**
 * Wait for the socket to reach a connected state, kicking off a fresh
 * connection attempt if auto-reconnect has given up.
 * Resolves true once connected, false on timeout/error.
 */
function ensureConnected(socket, timeoutMs = CONNECT_TIMEOUT_MS) {
  if (socket?.connected) return Promise.resolve(true)
  if (!socket) return Promise.resolve(false)

  return new Promise((resolve) => {
    const cleanup = () => {
      clearTimeout(timer)
      socket.off('connect', onConnect)
      socket.off('connect_error', onError)
    }
    const onConnect = () => {
      cleanup()
      resolve(true)
    }
    const onError = () => {
      cleanup()
      resolve(false)
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve(false)
    }, timeoutMs)

    // Revive the socket if it exhausted its reconnection attempts earlier
    if (!socket.active) socket.connect()

    socket.on('connect', onConnect)
    socket.on('connect_error', onError)
  })
}

/**
 * Custom hook that manages the Socket.IO connection and room lifecycle.
 *
 * Returns:
 *   connected  — boolean, true when socket is connected
 *   myId       — string | null, this client's current socket id
 *   members    — array of { socketId, displayName, role }
 *   streamMode — { type: 'p2p'|'full'|'url', url: string|null } | null,
 *                the room's current streaming mode (host-controlled; see
 *                server streamHandlers.js)
 *   error      — string | null, last error message
 *   connecting — boolean, true while a create/join is in-flight
 *   createRoom(name, code, displayName) → Promise<response>
 *   joinRoom(code, displayName)         → Promise<response>
 *   leaveRoom()
 *   sendStreamMode(type, url) → Promise<{ ok, mode?, error? }>  (host only)
 *   sendPlaybackSync(action, time)
 *   onPlaybackSync(callback) — register a listener for incoming sync events
 *   sendChat(text)
 *   onChatMessage(callback)  — register a listener for incoming chat messages
 *                              ({ from, displayName, text, ts })
 *   onMemberJoined(callback) — register a listener for other members joining
 *                              (receives their displayName)
 *   onMemberLeft(callback)   — register a listener for other members leaving
 *                              (receives their displayName)
 *   onHostLeft(callback)     — register a listener for host-left events
 *   onStreamModeChanged(cb)  — register a listener for live streaming-mode
 *                              changes ({ type, url }); initial state comes
 *                              via the streamMode value instead
 *   sendSignal(to, kind, payload) — relay WebRTC signaling to a peer
 *   onSignal(callback)       — incoming signaling: { from, kind, payload }
 */
export default function useSocket() {
  const socketRef = useRef(null)
  const [connected, setConnected] = useState(false)
  const [myId, setMyId] = useState(null)
  const [members, setMembers] = useState([])
  const [streamMode, setStreamMode] = useState(null)
  const [error, setError] = useState(null)
  const [connecting, setConnecting] = useState(false)

  // Refs for external callbacks (avoids stale closures)
  const playbackSyncCbRef = useRef(null)
  const chatMessageCbRef = useRef(null)
  const memberJoinedCbRef = useRef(null)
  const memberLeftCbRef = useRef(null)
  const hostLeftCbRef = useRef(null)
  const signalCbRef = useRef(null)
  const streamModeChangedCbRef = useRef(null)

  // ── Initialise socket once on mount ──────────────────────────────────────
  useEffect(() => {
    const socket = io(SERVER_URL, {
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
    })

    socketRef.current = socket

    socket.on('connect', () => {
      console.log('[socket] connected:', socket.id)
      setConnected(true)
      setMyId(socket.id)
      setError(null)
    })

    socket.on('disconnect', (reason) => {
      console.log('[socket] disconnected:', reason)
      setConnected(false)
      setMyId(null)
    })

    socket.on('connect_error', (err) => {
      console.warn('[socket] connect_error:', err.message)
      setConnected(false)
    })

    // ── Room events ──────────────────────────────────────────────────────
    // Note: the server sends member-joined/member-left to everyone EXCEPT
    // the joiner/leaver, so these always describe *other* members.
    socket.on('room:member-joined', ({ displayName, members: m }) => {
      setMembers(m)
      if (displayName) memberJoinedCbRef.current?.(displayName)
    })

    socket.on('room:member-left', ({ displayName, members: m }) => {
      setMembers(m)
      if (displayName) memberLeftCbRef.current?.(displayName)
    })

    socket.on('room:host-left', () => {
      setMembers([])
      setStreamMode(null)
      hostLeftCbRef.current?.()
    })

    // ── Playback sync (incoming, for non-hosts) ──────────────────────────
    socket.on('playback:sync', (data) => {
      playbackSyncCbRef.current?.(data)
    })

    // ── Streaming mode (host-controlled, echoed to the host too) ─────────
    socket.on('stream:mode-changed', ({ type, url }) => {
      const mode = { type, url: url ?? null }
      setStreamMode(mode)
      streamModeChangedCbRef.current?.(mode)
    })

    // ── Chat (incoming, includes the sender's own echo) ──────────────────
    socket.on('chat:message', (data) => {
      chatMessageCbRef.current?.(data)
    })

    // ── WebRTC signaling relay (blind pass-through, see signalHandlers) ──
    for (const { kind, key } of SIGNAL_KINDS) {
      socket.on(`signal:${kind}`, (data) => {
        signalCbRef.current?.({ from: data.from, kind, payload: data[key] })
      })
    }

    return () => {
      socket.disconnect()
      socketRef.current = null
    }
  }, [])

  // ── Create Room ─────────────────────────────────────────────────────────
  const createRoom = useCallback(async (name, code, displayName) => {
    const socket = socketRef.current

    setConnecting(true)
    setError(null)

    if (!(await ensureConnected(socket))) {
      const msg = 'Could not connect to the server. Is it running?'
      setConnecting(false)
      setError(msg)
      return { ok: false, error: msg }
    }

    const res = await new Promise((resolve) => {
      socket.emit('room:create', { name, code, displayName }, resolve)
    })

    setConnecting(false)
    if (res.ok) {
      setMembers(res.members)
      setStreamMode(res.streamMode ?? null)
      setError(null)
    } else {
      setError(res.error)
    }
    return res
  }, [])

  // ── Join Room ───────────────────────────────────────────────────────────
  const joinRoom = useCallback(async (code, displayName) => {
    const socket = socketRef.current

    setConnecting(true)
    setError(null)

    if (!(await ensureConnected(socket))) {
      const msg = 'Could not connect to the server. Is it running?'
      setConnecting(false)
      setError(msg)
      return { ok: false, error: msg }
    }

    const res = await new Promise((resolve) => {
      socket.emit('room:join', { code, displayName }, resolve)
    })

    setConnecting(false)
    if (res.ok) {
      setMembers(res.members)
      setStreamMode(res.streamMode ?? null)
      setError(null)
    } else {
      setError(res.error)
    }
    return res
  }, [])

  // ── Leave Room ──────────────────────────────────────────────────────────
  const leaveRoom = useCallback(() => {
    const socket = socketRef.current
    if (!socket?.connected) return
    socket.emit('room:leave')
    setMembers([])
    setStreamMode(null)
    setError(null)
  }, [])

  // ── Streaming mode (outgoing, for host) ─────────────────────────────────
  const sendStreamMode = useCallback(async (type, url = null) => {
    const socket = socketRef.current
    if (!(await ensureConnected(socket))) {
      return { ok: false, error: 'Not connected to the server.' }
    }
    return new Promise((resolve) => {
      socket.emit('stream:set-mode', { type, url }, resolve)
    })
  }, [])

  // ── Playback Sync (outgoing, for host) ──────────────────────────────────
  const sendPlaybackSync = useCallback((action, time) => {
    const socket = socketRef.current
    if (!socket?.connected) return
    socket.emit('playback:sync', { action, time })
  }, [])

  // ── Chat (outgoing; the server echoes it back to everyone incl. sender) ─
  const sendChat = useCallback((text) => {
    const socket = socketRef.current
    if (!socket?.connected) return
    socket.emit('chat:message', { text })
  }, [])

  // ── WebRTC signaling (outgoing) ─────────────────────────────────────────
  const sendSignal = useCallback((to, kind, payload) => {
    const socket = socketRef.current
    if (!socket?.connected || !to) return
    const entry = SIGNAL_KINDS.find((k) => k.kind === kind)
    if (!entry) return
    socket.emit(`signal:${kind}`, { to, [entry.key]: payload })
  }, [])

  // ── Callback registration ──────────────────────────────────────────────
  const onPlaybackSync = useCallback((cb) => {
    playbackSyncCbRef.current = cb
  }, [])

  const onChatMessage = useCallback((cb) => {
    chatMessageCbRef.current = cb
  }, [])

  const onMemberJoined = useCallback((cb) => {
    memberJoinedCbRef.current = cb
  }, [])

  const onMemberLeft = useCallback((cb) => {
    memberLeftCbRef.current = cb
  }, [])

  const onHostLeft = useCallback((cb) => {
    hostLeftCbRef.current = cb
  }, [])

  const onStreamModeChanged = useCallback((cb) => {
    streamModeChangedCbRef.current = cb
  }, [])

  const onSignal = useCallback((cb) => {
    signalCbRef.current = cb
  }, [])

  return {
    connected,
    myId,
    members,
    streamMode,
    error,
    connecting,
    createRoom,
    joinRoom,
    leaveRoom,
    sendStreamMode,
    sendPlaybackSync,
    onPlaybackSync,
    sendChat,
    onChatMessage,
    onMemberJoined,
    onMemberLeft,
    onHostLeft,
    onStreamModeChanged,
    sendSignal,
    onSignal,
  }
}
