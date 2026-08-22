import { useState } from 'react'
import './Home.css'

export default function Home({ onEnterRoom }) {
  const [mode, setMode] = useState(null) // null | 'host' | 'join'
  const [roomName, setRoomName] = useState('')
  const [roomCode, setRoomCode] = useState('')

  const generateCode = () => {
    return Math.random().toString(36).substring(2, 8).toUpperCase()
  }

  const handleHost = () => {
    if (!roomName.trim()) return
    const code = generateCode()
    onEnterRoom({ name: roomName.trim(), code, role: 'host' })
  }

  const handleJoin = () => {
    if (!roomCode.trim()) return
    onEnterRoom({ name: `Room ${roomCode.trim()}`, code: roomCode.trim().toUpperCase(), role: 'member' })
  }

  return (
    <div className="home">
      {/* Animated background elements */}
      <div className="home__bg">
        <div className="home__orb home__orb--1" />
        <div className="home__orb home__orb--2" />
        <div className="home__orb home__orb--3" />
        <div className="home__grid-overlay" />
      </div>

      <div className="home__content">
        {/* Logo / Brand */}
        <header className="home__header">
          <div className="home__logo">
            <div className="home__logo-icon">
              <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                <rect width="32" height="32" rx="8" fill="url(#logo-grad)" />
                <path d="M12 10L22 16L12 22V10Z" fill="white" />
                <defs>
                  <linearGradient id="logo-grad" x1="0" y1="0" x2="32" y2="32">
                    <stop stopColor="#8b5cf6" />
                    <stop offset="1" stopColor="#22d3ee" />
                  </linearGradient>
                </defs>
              </svg>
            </div>
            <span className="home__logo-text">Party Stream</span>
          </div>
        </header>

        {/* Hero */}
        <div className="home__hero">
          <h1 className="home__title">
            Watch <span className="home__title-accent">Together</span>
          </h1>
          <p className="home__subtitle">
            Host a room or join your friends. Stream videos in sync with real-time chat.
          </p>
        </div>

        {/* Mode Selection */}
        {mode === null && (
          <div className="home__choices" id="mode-selection">
            <button
              className="home__choice-card"
              id="btn-host-mode"
              onClick={() => setMode('host')}
            >
              <div className="home__choice-icon home__choice-icon--host">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
              </div>
              <h2 className="home__choice-title">Host a Room</h2>
              <p className="home__choice-desc">Create a watch party and invite friends with a unique code</p>
              <span className="home__choice-arrow">→</span>
            </button>

            <button
              className="home__choice-card home__choice-card--join"
              id="btn-join-mode"
              onClick={() => setMode('join')}
            >
              <div className="home__choice-icon home__choice-icon--join">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
              </div>
              <h2 className="home__choice-title">Join a Room</h2>
              <p className="home__choice-desc">Enter a room code to join an existing watch party</p>
              <span className="home__choice-arrow">→</span>
            </button>
          </div>
        )}

        {/* Host Form */}
        {mode === 'host' && (
          <div className="home__form-card" id="host-form">
            <button className="home__back" id="btn-back-host" onClick={() => setMode(null)}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="19" y1="12" x2="5" y2="12" />
                <polyline points="12 19 5 12 12 5" />
              </svg>
              Back
            </button>

            <div className="home__form-header">
              <div className="home__form-badge home__form-badge--host">HOST</div>
              <h2 className="home__form-title">Create Your Room</h2>
              <p className="home__form-desc">Name your watch party and share the code</p>
            </div>

            <div className="home__input-group">
              <label className="home__label" htmlFor="input-room-name">Room Name</label>
              <input
                id="input-room-name"
                className="home__input"
                type="text"
                placeholder="e.g. Movie Night 🍿"
                value={roomName}
                onChange={(e) => setRoomName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleHost()}
                autoFocus
                maxLength={40}
              />
            </div>

            <button
              className="home__btn home__btn--primary"
              id="btn-create-room"
              onClick={handleHost}
              disabled={!roomName.trim()}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
              Start Party
            </button>
          </div>
        )}

        {/* Join Form */}
        {mode === 'join' && (
          <div className="home__form-card" id="join-form">
            <button className="home__back" id="btn-back-join" onClick={() => setMode(null)}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="19" y1="12" x2="5" y2="12" />
                <polyline points="12 19 5 12 12 5" />
              </svg>
              Back
            </button>

            <div className="home__form-header">
              <div className="home__form-badge home__form-badge--join">JOIN</div>
              <h2 className="home__form-title">Join a Party</h2>
              <p className="home__form-desc">Enter the 6-character room code from your host</p>
            </div>

            <div className="home__input-group">
              <label className="home__label" htmlFor="input-room-code">Room Code</label>
              <input
                id="input-room-code"
                className="home__input home__input--code"
                type="text"
                placeholder="ABC123"
                value={roomCode}
                onChange={(e) => setRoomCode(e.target.value.toUpperCase().slice(0, 6))}
                onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
                autoFocus
                maxLength={6}
                spellCheck={false}
                autoComplete="off"
              />
            </div>

            <button
              className="home__btn home__btn--secondary"
              id="btn-join-room"
              onClick={handleJoin}
              disabled={!roomCode.trim()}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                <polyline points="10 17 15 12 10 7" />
                <line x1="15" y1="12" x2="3" y2="12" />
              </svg>
              Join Party
            </button>
          </div>
        )}

        {/* Footer */}
        <footer className="home__footer">
          <span>Built for watch parties</span>
          <span className="home__footer-dot">·</span>
          <span>Sync in real time</span>
        </footer>
      </div>
    </div>
  )
}