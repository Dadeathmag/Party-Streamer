/**
 * @file usePeerNetwork — React glue between the Socket.IO signaling transport
 * (useSocket) and the P2P layer (network/peer.js + file transfer).
 *
 * Responsibilities:
 *   - keep one Peer connection per remote member, reconciled against the
 *     live members list (host ⇄ each viewer star topology)
 *   - route incoming signals (offer/answer/ICE) into the right Peer
 *   - HOST: chunked-upload the selected file to every connected viewer;
 *     late joiners automatically receive the currently selected video once
 *     their DataChannel opens
 *   - GUEST: feed incoming offers/chunks into a single FileReceiver wired
 *     to the room's <video> element (registered from Room.jsx)
 *
 * The server relays signaling blindly and never sees media (AGENTS.md rule 1).
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import Peer, { PEER_STATE } from '../network/peer.js'
import FileSender from '../network/fileSender.js'
import FileReceiver from '../network/fileReceiver.js'
import {
  decodeMessage,
  encodeMessage,
  isControlMessage,
} from '../network/roomProtocol.js'

/**
 * Remote peers this client should be connected to, given its own role.
 * @param {Array<{ socketId: string, role: string }>} members
 * @param {string} myId
 * @returns {string[]}
 */
function desiredPeerIds(members, myId) {
  const me = members.find((m) => m.socketId === myId)
  if (!me) return []
  const others = members.filter((m) => m.socketId !== myId)
  if (me.role === 'host') {
    return others.filter((m) => m.role !== 'host').map((m) => m.socketId)
  }
  return others.filter((m) => m.role === 'host').map((m) => m.socketId)
}

/**
 * @param {object} socketApi everything returned by useSocket()
 */
export default function usePeerNetwork(socketApi) {
  const { myId, members, sendSignal, onSignal } = socketApi

  /** @type {React.MutableRefObject<Map<string, Peer>>} */
  const peersRef = useRef(new Map())
  /** @type {React.MutableRefObject<Map<string, FileSender>>} */
  const sendersRef = useRef(new Map())
  /** @type {React.MutableRefObject<FileReceiver|null>} */
  const receiverRef = useRef(null)
  /** @type {React.MutableRefObject<File|null>} */
  const currentFileRef = useRef(null)
  /** @type {React.MutableRefObject<HTMLVideoElement|null>} */
  const videoElRef = useRef(null)

  // Latest props for use inside stable callbacks (avoids stale closures);
  // refreshed in an effect, so callbacks read at most one render behind.
  const latestRef = useRef({ members, myId })
  useEffect(() => {
    latestRef.current = { members, myId }
  }, [members, myId])

  const [transferStatus, setTransferStatus] = useState(null)
  const remoteReadyCbRef = useRef(null)
  const transferErrorCbRef = useRef(null)

  const isHostNow = () => {
    const { members: m, myId: id } = latestRef.current
    return m.some((x) => x.socketId === id && x.role === 'host')
  }

  // ── Transfer status helpers ───────────────────────────────────────────────

  const recalcSendStatus = useCallback(() => {
    const active = [...sendersRef.current.values()]
    setTransferStatus((prev) => {
      if (active.length === 0) return prev?.direction === 'send' ? null : prev
      if (prev?.direction !== 'send') return prev
      const slowest = Math.min(...active.map((s) => (s.sentBytes / s.file.size) * 100))
      return { ...prev, pct: Math.min(100, slowest) }
    })
  }, [])

  const beginSendStatus = useCallback((file) => {
    setTransferStatus((prev) =>
      prev?.direction === 'send' ? prev : { direction: 'send', name: file.name, pct: 0 },
    )
  }, [])

  // ── Sender management (host) ──────────────────────────────────────────────

  const startSenderTo = useCallback(
    (peer, file) => {
      if (sendersRef.current.has(peer.peerId) || !peer.isOpen) return
      const sender = new FileSender({
        peer,
        file,
        onProgress: recalcSendStatus,
        onComplete: () => {
          sendersRef.current.delete(peer.peerId)
          recalcSendStatus()
        },
        onError: () => {
          sendersRef.current.delete(peer.peerId)
          recalcSendStatus()
        },
      })
      sendersRef.current.set(peer.peerId, sender)
      beginSendStatus(file)
      sender.start()
    },
    [recalcSendStatus, beginSendStatus],
  )

  /**
   * Host: stream the newly selected file to everyone connected now; peers
   * connecting later are handled by the DataChannel-open handler below.
   */
  const sendFile = useCallback(
    (file) => {
      if (!file || !isHostNow()) return
      currentFileRef.current = file
      for (const sender of sendersRef.current.values()) sender.abort('New video selected')
      sendersRef.current.clear()
      for (const peer of peersRef.current.values()) {
        if (peer.isOpen) startSenderTo(peer, file)
      }
    },
    [startSenderTo],
  )

  // ── Receiver management (guest) ───────────────────────────────────────────

  const ensureReceiver = useCallback((hostPeerId) => {
    if (receiverRef.current) return receiverRef.current
    receiverRef.current = new FileReceiver({
      sendControl: (type, payload) => {
        peersRef.current.get(hostPeerId)?.sendText(encodeMessage(type, payload))
      },
      onStarted: ({ name }) => setTransferStatus({ direction: 'receive', name, pct: 0 }),
      onProgress: (pct) =>
        setTransferStatus((prev) =>
          prev?.direction === 'receive' ? { ...prev, pct } : prev,
        ),
      onComplete: ({ url, name }) => {
        setTransferStatus(null)
        remoteReadyCbRef.current?.({ url, name })
      },
      onFailed: (err) => {
        setTransferStatus(null)
        transferErrorCbRef.current?.(err)
      },
    })
    receiverRef.current.attachVideo(videoElRef.current)
    return receiverRef.current
  }, [])

  /**
   * Room.jsx hands its <video> element over so the guest-side MediaSource
   * can attach as soon as a FILE_OFFER arrives (the element renders even
   * while the empty-state overlay is showing).
   */
  const registerVideoElement = useCallback((el) => {
    videoElRef.current = el
    receiverRef.current?.attachVideo(el)
  }, [])

  // ── Message routing ───────────────────────────────────────────────────────

  const handlePeerMessage = useCallback(
    (peerId, data) => {
      if (isControlMessage(data)) {
        let msg
        try {
          msg = decodeMessage(data)
        } catch {
          return
        }
        sendersRef.current.get(peerId)?.handleControlMessage(msg)
        if (!isHostNow()) ensureReceiver(peerId).handleControlMessage(msg)
      } else if (!isHostNow()) {
        ensureReceiver(peerId).handleBinary(data)
      }
    },
    [ensureReceiver],
  )

  // ── Peer lifecycle ────────────────────────────────────────────────────────

  const destroyPeer = useCallback((peerId) => {
    const peer = peersRef.current.get(peerId)
    if (!peer) return
    peersRef.current.delete(peerId) // delete first: onStateChange fires sync
    sendersRef.current.get(peerId)?.abort('Peer disconnected')
    sendersRef.current.delete(peerId)
    peer.close()
  }, [])

  const destroyEverything = useCallback(() => {
    for (const id of [...peersRef.current.keys()]) destroyPeer(id)
    sendersRef.current.clear()
    receiverRef.current?.destroy()
    receiverRef.current = null
    setTransferStatus(null)
  }, [destroyPeer])

  const createPeer = useCallback(
    (peerId, isOfferer) => {
      const peer = new Peer({
        peerId,
        isOfferer,
        sendSignal: (kind, payload) => sendSignal(peerId, kind, payload),
        onMessage: (data) => handlePeerMessage(peerId, data),
        onStateChange: (state) => {
          if (state === PEER_STATE.OPEN && isOfferer && currentFileRef.current) {
            // Late joiner (or reconnect): push the current video immediately.
            startSenderTo(peer, currentFileRef.current)
          }
          if (state === PEER_STATE.CLOSED || state === PEER_STATE.FAILED) {
            sendersRef.current.get(peerId)?.abort('Connection lost')
            sendersRef.current.delete(peerId)
            recalcSendStatus()
            if (!isOfferer) {
              receiverRef.current?.reset(false)
              setTransferStatus((prev) => (prev?.direction === 'receive' ? null : prev))
            }
            if (state === PEER_STATE.FAILED && peersRef.current.get(peerId) === peer) {
              peersRef.current.delete(peerId)
            }
          }
        },
      })
      peersRef.current.set(peerId, peer)
      return peer
    },
    [sendSignal, handlePeerMessage, startSenderTo, recalcSendStatus],
  )

  // ── Incoming WebRTC signaling ─────────────────────────────────────────────
  useEffect(() => {
    onSignal(({ from, kind, payload }) => {
      let peer = peersRef.current.get(from)
      if (!peer) peer = createPeer(from, isHostNow())
      peer.handleSignal(kind, payload)
    })
  }, [onSignal, createPeer])

  // ── Reconcile connections against the members list ────────────────────────
  // Also covers socket-identity churn: when myId/members reset (reconnect,
  // leave, host-left), `wanted` becomes empty and everything tears down.
  useEffect(() => {
    const amHost = isHostNow()
    const wanted = new Set(desiredPeerIds(members, myId))

    for (const id of [...peersRef.current.keys()]) {
      if (!wanted.has(id)) destroyPeer(id)
    }
    for (const id of wanted) {
      if (!peersRef.current.has(id)) createPeer(id, amHost)
    }
  }, [members, myId, createPeer, destroyPeer])

  useEffect(() => destroyEverything, [destroyEverything])

  // ── Callback registration ─────────────────────────────────────────────────

  /** ({ url: string|null, name: string }) → guest video ready to show */
  const onRemoteVideoReady = useCallback((cb) => {
    remoteReadyCbRef.current = cb
  }, [])

  /** (Error) → a transfer failed or was aborted */
  const onTransferError = useCallback((cb) => {
    transferErrorCbRef.current = cb
  }, [])

  return {
    sendFile,
    registerVideoElement,
    transferStatus,
    onRemoteVideoReady,
    onTransferError,
  }
}
