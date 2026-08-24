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
import usePeerNetwork from './hooks/usePeerNetwork.js'
import './App.css'

function App() {
  const [page, setPage] = useState('home') // 'home' | 'room'
  const [roomInfo, setRoomInfo] = useState(null) // { name, code, role }

  const socket = useSocket()
  const peerNet = usePeerNetwork(socket)

  const handleEnterRoom = async (info) => {
    const { displayName, name, code, role, isPublic } = info

    if (role === 'host') {
      const res = await socket.createRoom(name, code, displayName, isPublic)
      if (!res.ok) return // error is set inside the hook
    } else {
      const res = await socket.joinRoom(code, displayName)
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
          listRooms={socket.listRooms}
        />
      )}
      {page === 'room' && (
        <Room
          roomInfo={roomInfo}
          onLeave={handleLeaveRoom}
          members={socket.members}
          connected={socket.connected}
          myId={socket.myId}
          onPlaybackSync={socket.onPlaybackSync}
          sendChat={socket.sendChat}
          onChatMessage={socket.onChatMessage}
          onMemberJoined={socket.onMemberJoined}
          onMemberLeft={socket.onMemberLeft}
          onHostLeft={socket.onHostLeft}
          isPublic={socket.isPublic}
          locked={socket.locked}
          setVisibility={socket.setVisibility}
          setLocked={socket.setLocked}
          kickMember={socket.kickMember}
          onKicked={socket.onKicked}
          onVisibilityChanged={socket.onVisibilityChanged}
          onLockChanged={socket.onLockChanged}
          sendFile={peerNet.sendFile}
          cancelTransfers={peerNet.cancelTransfers}
          registerVideoElement={peerNet.registerVideoElement}
          broadcastPlayback={peerNet.broadcastPlayback}
          broadcastBeacon={peerNet.broadcastBeacon}
          transferStatus={peerNet.transferStatus}
          onRemoteVideoReady={peerNet.onRemoteVideoReady}
          onTransferError={peerNet.onTransferError}
          onPeerPlaybackSync={peerNet.onPeerPlaybackSync}
          streamMode={socket.streamMode}
          sendStreamMode={socket.sendStreamMode}
          onStreamModeChanged={socket.onStreamModeChanged}
        />
      )}
    </>
  )
}

export default App
