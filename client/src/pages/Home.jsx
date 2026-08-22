/**
 * @file Home page — landing screen for hosts and guests.
 *
 * Three-step flow driven by the local `mode` state:
 *   null   → choose "Host a Room" or "Join a Room"
 *   'host' → room name form; a random 6-char code is generated client-side
 *   'join' → 6-char code entry form
 *
 * Submitting either form calls `onEnterRoom({ name, code, role })`; App.jsx
 * performs the actual socket round-trip (room:create / room:join) and swaps
 * to the Room page on success. Connection errors surface via the `error`
 * prop and are rendered under the active form.
 */

import { useState } from 'react'
import { LogoMark, PlayIcon, UsersIcon, ArrowLeftIcon, LogInIcon } from '../components/Icons.jsx'
import './Home.css'

/**
 * Generate a random 6-character upper-case room code (e.g. "K3XP9Q").
 */
const generateCode = () => Math.random().toString(36).substring(2, 8).toUpperCase()

/**
 * @param {object} props
 * @param {(info: { name: string, code: string, role: 'host'|'member' }) => void} props.onEnterRoom
 * @param {string | null} props.error     last connection/room error to display
 * @param {boolean} props.connecting      true while create/join is in flight
 */
export default function Home({ onEnterRoom, error, connecting }) {
  const [mode, setMode] = useState(null) // null | 'host' | 'join'
  const [roomName, setRoomName] = useState('')
  const [roomCode, setRoomCode] = useState('')

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
              <LogoMark size={32} />
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
                <PlayIcon size={28} />
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
                <UsersIcon size={28} />
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
              <ArrowLeftIcon size={18} />
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
              disabled={!roomName.trim() || connecting}
            >
              <PlayIcon size={18} strokeWidth={2.5} />
              {connecting ? 'Creating…' : 'Start Party'}
            </button>

            {error && <p className="home__error">{error}</p>}
          </div>
        )}

        {/* Join Form */}
        {mode === 'join' && (
          <div className="home__form-card" id="join-form">
            <button className="home__back" id="btn-back-join" onClick={() => setMode(null)}>
              <ArrowLeftIcon size={18} />
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
              disabled={!roomCode.trim() || connecting}
            >
              <LogInIcon size={18} />
              {connecting ? 'Joining…' : 'Join Party'}
            </button>

            {error && <p className="home__error">{error}</p>}
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
