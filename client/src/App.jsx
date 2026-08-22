import { useState } from 'react'
import Home from './pages/Home.jsx'
import Room from './pages/Room.jsx'
import './App.css'

function App() {
  const [page, setPage] = useState('home') // 'home' | 'room'
  const [roomInfo, setRoomInfo] = useState(null) // { name, code, role }

  const handleEnterRoom = (info) => {
    setRoomInfo(info)
    setPage('room')
  }

  const handleLeaveRoom = () => {
    setRoomInfo(null)
    setPage('home')
  }

  return (
    <>
      {page === 'home' && <Home onEnterRoom={handleEnterRoom} />}
      {page === 'room' && <Room roomInfo={roomInfo} onLeave={handleLeaveRoom} />}
    </>
  )
}

export default App
