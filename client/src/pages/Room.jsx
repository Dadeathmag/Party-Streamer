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
 * Sync model: the host is the single source of truth. Host interactions call
 * sendPlaybackSync() which the server relays to every other member; guests
 * receive 'playback:sync' via onPlaybackSync and apply it to their local
 * <video> element. Guests' own controls work locally but are never broadcast.
 *
 * Media distribution: the host picks a streaming mode in the mode bar —
 *   'p2p'   local file streamed P2P in chunks, played progressively via MSE
 *           (Blob fallback for formats MSE can't ingest; network/fileSender.js)
 *   'full'  same P2P transfer, but guests only get playback after the whole
 *           file has arrived (delivery:'full' on FILE_OFFER)
 *   'url'   host pastes a direct media URL that every client loads itself;
 *           no P2P transfer at all
 * The mode is stored server-side and broadcast via 'stream:mode-changed'
 * (see useSocket), so late joiners sync up through their join ack. All P2P
 * networking flows through props provided by usePeerNetwork (App.jsx).
 */

import { useState, useRef, useEffect } from 'react'
import { ArrowLeftIcon, UploadIcon, DownloadIcon, LinkIcon, UsersIcon, LockIcon, MaximizeIcon, MinimizeIcon } from '../components/Icons.jsx'
import VideoStage from '../components/VideoStage.jsx'
import PlayerControls from '../components/PlayerControls.jsx'
import ChatPanel from '../components/ChatPanel.jsx'
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
 * @param {(action: string, time: number) => void} props.sendPlaybackSync  host only
 * @param {(cb: (data: { action: string, time: number }) => void) => void} props.onPlaybackSync
 * @param {(text: string) => void} props.sendChat
 * @param {(cb: (data: { from: string, displayName: string, text: string, ts: number }) => void) => void} props.onChatMessage
 * @param {(cb: (displayName: string) => void) => void} props.onMemberJoined
 * @param {(cb: (displayName: string) => void) => void} props.onMemberLeft
 * @param {(cb: () => void) => void} props.onHostLeft
 * @param {(file: File, delivery?: string) => void} props.sendFile
 *        host: stream file to viewers ('progressive' | 'full')
 * @param {() => void} props.cancelTransfers   abort in-flight transfers + forget current file
 * @param {(el: HTMLVideoElement|null) => void} props.registerVideoElement
 * @param {{ direction: 'send'|'receive', name: string, pct: number } | null}
 *        props.transferStatus
 * @param {(cb: (info: { url: string | null, name: string }) => void) => void}
 *        props.onRemoteVideoReady   guest: streamed video is playable
 * @param {(cb: (err: Error) => void) => void} props.onTransferError
 * @param {{ type: 'p2p'|'full'|'url', url: string | null } | null}
 *        props.streamMode           room's current streaming mode (host-set;
 *                                    also the source of truth in link mode)
 * @param {(type: string, url?: string|null) => Promise<{ ok: boolean, mode?: object, error?: string }>}
 *        props.sendStreamMode       host: change the streaming mode
 * @param {(cb: (mode: { type: string, url: string | null }) => void) => void}
 *        props.onStreamModeChanged  live streaming-mode transitions
 */
function Room({ roomInfo, onLeave, members = [], myId, sendPlaybackSync, onPlaybackSync, sendChat, onChatMessage, onMemberJoined, onMemberLeft, onHostLeft, sendFile, cancelTransfers, registerVideoElement, transferStatus, onRemoteVideoReady, onTransferError, streamMode, sendStreamMode, onStreamModeChanged }) {
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

  // ── Refs ──────────────────────────────────────────────────────────────────
  const videoRef = useRef(null)
  const chatEndRef = useRef(null)
  const fileInputRef = useRef(null)
  const progressRef = useRef(null)
  const nextMsgIdRef = useRef(1)
  const lastFileRef = useRef(null)

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

  // Guests: apply host playback commands (play/pause/seek) to the local video.
  useEffect(() => {
    if (isHost) return
    onPlaybackSync?.(({ action, time }) => {
      const video = videoRef.current
      if (!video) return
      switch (action) {
        case 'play':
          video.currentTime = time
          video.play().catch(() => {})
          setIsPlaying(true)
          break
        case 'pause':
          video.pause()
          video.currentTime = time
          setIsPlaying(false)
          break
        case 'seek':
          video.currentTime = time
          break
      }
    })
  }, [isHost, onPlaybackSync])

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

  const togglePlay = () => {
    if (!videoRef.current) return
    if (isPlaying) {
      videoRef.current.pause()
      if (isHost) sendPlaybackSync?.('pause', videoRef.current.currentTime)
    } else {
      videoRef.current.play()
      if (isHost) sendPlaybackSync?.('play', videoRef.current.currentTime)
    }
    setIsPlaying(!isPlaying)
  }

  const handleSeek = (e) => {
    if (!videoRef.current || !progressRef.current) return
    const rect = progressRef.current.getBoundingClientRect()
    const pct = (e.clientX - rect.left) / rect.width
    const newTime = pct * duration
    videoRef.current.currentTime = newTime
    if (isHost) sendPlaybackSync?.('seek', newTime)
  }

  const skip = (seconds) => {
    if (!videoRef.current) return
    videoRef.current.currentTime += seconds
    if (isHost) sendPlaybackSync?.('seek', videoRef.current.currentTime)
  }

  // ── Volume handlers (always local — never synced) ─────────────────────────

  const handleVolume = (e) => {
    const val = parseFloat(e.target.value)
    setVolume(val)
    if (videoRef.current) videoRef.current.volume = val
    setIsMuted(val === 0)
  }

  const toggleMute = () => {
    if (!videoRef.current) return
    const next = !isMuted
    setIsMuted(next)
    videoRef.current.muted = next
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

  // Chat: system lines when other members join or leave the party.
  useEffect(() => {
    onMemberJoined?.((joinedName) => addSystemMessage(`${joinedName} joined the party`))
    onMemberLeft?.((leftName) => addSystemMessage(`${leftName} left the party`))
  }, [onMemberJoined, onMemberLeft])

  const sendMessage = () => {
    const text = chatInput.trim()
    if (!text) return
    sendChat?.(text)
    setChatInput('')
  }

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen()
      setIsFullscreen(true)
    } else {
      document.exitFullscreen()
      setIsFullscreen(false)
    }
  }

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
    <div className="room">
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
          <button
            className="room__action-btn"
            id="btn-toggle-fullscreen"
            onClick={toggleFullscreen}
            title="Fullscreen"
          >
            {isFullscreen ? <MinimizeIcon size={16} /> : <MaximizeIcon size={16} />}
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
                  placeholder="https://example.com/video.mp4"
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
            videoSrc={displaySrc}
            videoName={displayName}
            mediaReady={mediaReady}
            incomingLabel={incomingLabel}
            isHost={isHost}
            showMembers={showMembers}
            members={members}
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
