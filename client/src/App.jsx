/**
 * @file Root component — owns the two-page flow (home ⇄ room) and the single
 * shared Socket.IO connection via useSocket().
 *
 * Page switching is plain state rather than a router: the app has exactly two
 * screens, and entering a room requires a successful socket round-trip
 * (room:create for hosts / room:join for guests) before the swap happens.
 * The server-authoritative room name replaces the guest's placeholder name
 * after a successful join.
 */

import { useState } from 'react'
import Home from './pages/Home.jsx'
import Room from './pages/Room.jsx'
import useSocket from './hooks/useSocket.js'
import './App.css'

function App() {
  const [page, setPage] = useState('home') // 'home' | 'room'
  const [roomInfo, setRoomInfo] = useState(null) // { name, code, role }

  const socket = useSocket()

  const handleEnterRoom = async (info) => {
    const { name, code, role } = info

    if (role === 'host') {
      const res = await socket.createRoom(name, code)
      if (!res.ok) return // error is set inside the hook
    } else {
      const res = await socket.joinRoom(code)
      if (!res.ok) return
      // Use the server-authoritative room name
      info = { ...info, name: res.name }
    }

    setRoomInfo(info)
    setPage('room')
  }

  const handleLeaveRoom = () => {
    socket.leaveRoom()
    setRoomInfo(null)
    setPage('home')
  }

  return (
    <>
      {page === 'home' && (
        <Home
          onEnterRoom={handleEnterRoom}
          error={socket.error}
          connecting={socket.connecting}
        />
      )}
      {page === 'room' && (
        <Room
          roomInfo={roomInfo}
          onLeave={handleLeaveRoom}
          members={socket.members}
          connected={socket.connected}
          sendPlaybackSync={socket.sendPlaybackSync}
          onPlaybackSync={socket.onPlaybackSync}
          onHostLeft={socket.onHostLeft}
        />
      )}
    </>
  )
}

export default App
