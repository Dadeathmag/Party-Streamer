import { useEffect, useRef, useState, useCallback } from 'react'
import { io } from 'socket.io-client'

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001'

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
  const createRoom = useCallback((name, code) => {
    return new Promise((resolve) => {
      const socket = socketRef.current
      if (!socket?.connected) {
        setError('Not connected to server.')
        return resolve({ ok: false, error: 'Not connected to server.' })
      }

      setConnecting(true)
      setError(null)

      socket.emit('room:create', { name, code }, (res) => {
        setConnecting(false)
        if (res.ok) {
          setMembers(res.members)
          setError(null)
        } else {
          setError(res.error)
        }
        resolve(res)
      })
    })
  }, [])

  // ── Join Room ───────────────────────────────────────────────────────────
  const joinRoom = useCallback((code) => {
    return new Promise((resolve) => {
      const socket = socketRef.current
      if (!socket?.connected) {
        setError('Not connected to server.')
        return resolve({ ok: false, error: 'Not connected to server.' })
      }

      setConnecting(true)
      setError(null)

      socket.emit('room:join', { code }, (res) => {
        setConnecting(false)
        if (res.ok) {
          setMembers(res.members)
          setError(null)
        } else {
          setError(res.error)
        }
        resolve(res)
      })
    })
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
