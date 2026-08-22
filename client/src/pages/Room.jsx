import { useState, useRef, useEffect, useCallback } from 'react'
import './Room.css'

const SAMPLE_MESSAGES = [
  { id: 1, user: 'System', text: 'Welcome to the party! 🎉', system: true },
]

function Room({ roomInfo, onLeave, members = [], connected, sendPlaybackSync, onPlaybackSync, onHostLeft }) {
  const { name, code, role } = roomInfo
  const isHost = role === 'host'

  const [messages, setMessages] = useState(SAMPLE_MESSAGES)
  const [chatInput, setChatInput] = useState('')
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(0.8)
  const [isMuted, setIsMuted] = useState(false)
  const [videoSrc, setVideoSrc] = useState(null)
  const [videoName, setVideoName] = useState('')
  const [showMembers, setShowMembers] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [chatCollapsed, setChatCollapsed] = useState(false)

  const videoRef = useRef(null)
  const chatEndRef = useRef(null)
  const fileInputRef = useRef(null)
  const progressRef = useRef(null)

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Video time update
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const handleTime = () => setCurrentTime(video.currentTime)
    const handleDuration = () => setDuration(video.duration)
    const handleEnded = () => setIsPlaying(false)
    video.addEventListener('timeupdate', handleTime)
    video.addEventListener('loadedmetadata', handleDuration)
    video.addEventListener('ended', handleEnded)
    return () => {
      video.removeEventListener('timeupdate', handleTime)
      video.removeEventListener('loadedmetadata', handleDuration)
      video.removeEventListener('ended', handleEnded)
    }
  }, [videoSrc])

  // ── Host-left handler ──────────────────────────────────────────────────
  useEffect(() => {
    if (isHost) return
    onHostLeft?.(() => {
      alert('The host has left the room.')
      onLeave()
    })
  }, [isHost, onHostLeft, onLeave])

  // ── Incoming playback sync (non-host) ──────────────────────────────────
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

  const skip = (seconds) => {
    if (!videoRef.current) return
    videoRef.current.currentTime += seconds
    if (isHost) sendPlaybackSync?.('seek', videoRef.current.currentTime)
  }

  const handleFileSelect = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const url = URL.createObjectURL(file)
    setVideoSrc(url)
    setVideoName(file.name)
    setIsPlaying(false)
    setCurrentTime(0)
    addSystemMessage(`Now playing: ${file.name}`)
  }

  const formatTime = (t) => {
    if (!t || isNaN(t)) return '0:00'
    const m = Math.floor(t / 60)
    const s = Math.floor(t % 60)
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  const addSystemMessage = (text) => {
    setMessages(prev => [...prev, {
      id: Date.now(),
      user: 'System',
      text,
      system: true,
    }])
  }

  const sendMessage = () => {
    if (!chatInput.trim()) return
    setMessages(prev => [...prev, {
      id: Date.now(),
      user: isHost ? 'Host' : 'You',
      text: chatInput.trim(),
      isOwn: true,
    }])
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

  return (
    <div className="room">
      {/* ── Top Bar ── */}
      <header className="room__topbar">
        <div className="room__topbar-left">
          <button className="room__back-btn" id="btn-leave-room" onClick={onLeave} title="Leave room">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="19" y1="12" x2="5" y2="12" />
              <polyline points="12 19 5 12 12 5" />
            </svg>
          </button>
          <div className="room__info">
            <h1 className="room__name">{name}</h1>
            <div className="room__meta">
              <span className={`room__role-badge ${isHost ? 'room__role-badge--host' : 'room__role-badge--member'}`}>
                {isHost ? '★ HOST' : '● MEMBER'}
              </span>
              <span className="room__code-badge" title="Room Code">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
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
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
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
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            <span className="room__action-label">{members.length}</span>
          </button>
          <button
            className="room__action-btn"
            id="btn-toggle-fullscreen"
            onClick={toggleFullscreen}
            title="Fullscreen"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {isFullscreen ? (
                <>
                  <polyline points="4 14 10 14 10 20" />
                  <polyline points="20 10 14 10 14 4" />
                  <line x1="14" y1="10" x2="21" y2="3" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </>
              ) : (
                <>
                  <polyline points="15 3 21 3 21 9" />
                  <polyline points="9 21 3 21 3 15" />
                  <line x1="21" y1="3" x2="14" y2="10" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </>
              )}
            </svg>
          </button>
        </div>
      </header>

      {/* ── Main Area ── */}
      <div className={`room__main ${chatCollapsed ? 'room__main--chat-collapsed' : ''}`}>
        {/* Video Panel */}
        <div className="room__video-panel">
          <div className="room__video-container" id="video-container">
            {videoSrc ? (
              <video
                ref={videoRef}
                className="room__video"
                src={videoSrc}
                onClick={togglePlay}
              />
            ) : (
              <div className="room__video-empty" onClick={isHost ? () => fileInputRef.current?.click() : undefined}>
                <div className="room__empty-icon">
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="5 3 19 12 5 21 5 3" />
                  </svg>
                </div>
                <p className="room__empty-text">
                  {isHost ? 'Click to select a video' : 'Waiting for host to start a video…'}
                </p>
                {videoName && <p className="room__now-playing">{videoName}</p>}
              </div>
            )}

            {/* Members Popup */}
            {showMembers && (
              <div className="room__members-popup" id="members-popup">
                <h3 className="room__members-title">Members ({members.length})</h3>
                {members.map((m) => (
                  <div className="room__member-item" key={m.socketId}>
                    <div className={`room__member-avatar ${m.role === 'host' ? 'room__member-avatar--host' : ''}`}>
                      {m.displayName.charAt(0).toUpperCase()}
                    </div>
                    <span>{m.displayName}</span>
                    {m.role === 'host' && <span className="room__member-role">★</span>}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Video Controls ── */}
          <div className="room__controls">
            {/* Progress Bar */}
            <div
              className="room__progress"
              ref={progressRef}
              onClick={handleSeek}
              id="progress-bar"
            >
              <div className="room__progress-fill" style={{ width: `${pct}%` }} />
              <div className="room__progress-thumb" style={{ left: `${pct}%` }} />
            </div>

            <div className="room__controls-row">
              <div className="room__controls-left">
                <button className="room__ctrl-btn" id="btn-play-pause" onClick={togglePlay} title={isPlaying ? 'Pause' : 'Play'}>
                  {isPlaying ? (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                      <rect x="6" y="4" width="4" height="16" rx="1" />
                      <rect x="14" y="4" width="4" height="16" rx="1" />
                    </svg>
                  ) : (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                  )}
                </button>

                <button className="room__ctrl-btn" id="btn-skip-back" onClick={() => skip(-10)} title="Back 10s">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="1 4 1 10 7 10" />
                    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                  </svg>
                </button>

                <button className="room__ctrl-btn" id="btn-skip-fwd" onClick={() => skip(10)} title="Forward 10s">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="23 4 23 10 17 10" />
                    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                  </svg>
                </button>

                <div className="room__volume-group">
                  <button className="room__ctrl-btn" id="btn-mute" onClick={toggleMute} title={isMuted ? 'Unmute' : 'Mute'}>
                    {isMuted || volume === 0 ? (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                        <line x1="23" y1="9" x2="17" y2="15" />
                        <line x1="17" y1="9" x2="23" y2="15" />
                      </svg>
                    ) : (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                        <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                        <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                      </svg>
                    )}
                  </button>
                  <input
                    className="room__volume-slider"
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={isMuted ? 0 : volume}
                    onChange={handleVolume}
                    id="volume-slider"
                  />
                </div>

                <span className="room__time" id="video-time">
                  {formatTime(currentTime)} / {formatTime(duration)}
                </span>
              </div>

              <div className="room__controls-right">
                {videoName && (
                  <span className="room__now-playing-label" title={videoName}>
                    {videoName.length > 30 ? videoName.slice(0, 30) + '…' : videoName}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ── Chat Sidebar ── */}
        <aside className={`room__chat ${chatCollapsed ? 'room__chat--collapsed' : ''}`}>
          <button
            className="room__chat-toggle"
            id="btn-toggle-chat"
            onClick={() => setChatCollapsed(!chatCollapsed)}
            title={chatCollapsed ? 'Open chat' : 'Close chat'}
          >
            {chatCollapsed ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            )}
          </button>

          {!chatCollapsed && (
            <>
              <div className="room__chat-header">
                <h2 className="room__chat-title">Live Chat</h2>
                <span className="room__chat-live-dot" />
              </div>

              <div className="room__chat-messages" id="chat-messages">
                {messages.map(msg => (
                  <div
                    key={msg.id}
                    className={`room__chat-msg ${msg.system ? 'room__chat-msg--system' : ''} ${msg.isOwn ? 'room__chat-msg--own' : ''}`}
                  >
                    {!msg.system && <span className="room__chat-user">{msg.user}</span>}
                    <span className="room__chat-text">{msg.text}</span>
                  </div>
                ))}
                <div ref={chatEndRef} />
              </div>

              <div className="room__chat-input-area">
                <input
                  className="room__chat-input"
                  id="input-chat"
                  type="text"
                  placeholder="Type a message…"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
                  maxLength={200}
                />
                <button
                  className="room__chat-send"
                  id="btn-send-chat"
                  onClick={sendMessage}
                  disabled={!chatInput.trim()}
                  title="Send"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="22" y1="2" x2="11" y2="13" />
                    <polygon points="22 2 15 22 11 13 2 9 22 2" />
                  </svg>
                </button>
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  )
}

export default Room
