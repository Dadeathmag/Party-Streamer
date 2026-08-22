/**
 * @file useSocket — the client's single Socket.IO connection + room state.
 *
 * Owns everything realtime:
 *   - connection lifecycle (connect/disconnect/error flags)
 *   - membership list (updated by room:member-joined / room:member-left)
 *   - host-left notification forwarding
 *   - playback:sync send (host) and receive (guests)
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
 *   members    — array of { socketId, displayName, role }
 *   error      — string | null, last error message
 *   connecting — boolean, true while a create/join is in-flight
 *   createRoom(name, code) → Promise<response>
 *   joinRoom(code)         → Promise<response>
 *   leaveRoom()
 *   sendPlaybackSync(action, time)
 *   onPlaybackSync(callback) — register a listener for incoming sync events
 *   onHostLeft(callback)     — register a listener for host-left events
 */
export default function useSocket() {
  const socketRef = useRef(null)
  const [connected, setConnected] = useState(false)
  const [members, setMembers] = useState([])
  const [error, setError] = useState(null)
  const [connecting, setConnecting] = useState(false)

  // Refs for external callbacks (avoids stale closures)
  const playbackSyncCbRef = useRef(null)
  const hostLeftCbRef = useRef(null)

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
      setError(null)
    })

    socket.on('disconnect', (reason) => {
      console.log('[socket] disconnected:', reason)
      setConnected(false)
    })

    socket.on('connect_error', (err) => {
      console.warn('[socket] connect_error:', err.message)
      setConnected(false)
    })

    // ── Room events ──────────────────────────────────────────────────────
    socket.on('room:member-joined', ({ members: m }) => {
      setMembers(m)
    })

    socket.on('room:member-left', ({ members: m }) => {
      setMembers(m)
    })

    socket.on('room:host-left', () => {
      setMembers([])
      hostLeftCbRef.current?.()
    })

    // ── Playback sync (incoming, for non-hosts) ──────────────────────────
    socket.on('playback:sync', (data) => {
      playbackSyncCbRef.current?.(data)
    })

    return () => {
      socket.disconnect()
      socketRef.current = null
    }
  }, [])

  // ── Create Room ─────────────────────────────────────────────────────────
  const createRoom = useCallback(async (name, code) => {
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
      socket.emit('room:create', { name, code }, resolve)
    })

    setConnecting(false)
    if (res.ok) {
      setMembers(res.members)
      setError(null)
    } else {
      setError(res.error)
    }
    return res
  }, [])

  // ── Join Room ───────────────────────────────────────────────────────────
  const joinRoom = useCallback(async (code) => {
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
      socket.emit('room:join', { code }, resolve)
    })

    setConnecting(false)
    if (res.ok) {
      setMembers(res.members)
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
    setError(null)
  }, [])

  // ── Playback Sync (outgoing, for host) ──────────────────────────────────
  const sendPlaybackSync = useCallback((action, time) => {
    const socket = socketRef.current
    if (!socket?.connected) return
    socket.emit('playback:sync', { action, time })
  }, [])

  // ── Callback registration ──────────────────────────────────────────────
  const onPlaybackSync = useCallback((cb) => {
    playbackSyncCbRef.current = cb
  }, [])

  const onHostLeft = useCallback((cb) => {
    hostLeftCbRef.current = cb
  }, [])

  return {
    connected,
    members,
    error,
    connecting,
    createRoom,
    joinRoom,
    leaveRoom,
    sendPlaybackSync,
    onPlaybackSync,
    onHostLeft,
  }
}
