import { PlayIcon } from './Icons.jsx'
import MembersPopup from './MembersPopup.jsx'

/**
 * @file The main viewing area: the <video> element (always mounted so the
 * guest-side MediaSource can attach before media arrives) with an optional
 * empty-state / receiving overlay, plus the members popup. Purely
 * presentational — all playback state lives in pages/Room.jsx.
 */

/**
 * @param {object} props
 * @param {React.RefObject} props.videoRef      ref attached to the <video> element
 * @param {string | null} props.videoSrc        object URL of the loaded file (host,
 *                                              or blob-fallback on guests)
 * @param {string} props.videoName              display name of the loaded file
 * @param {boolean} props.mediaReady            true once metadata has loaded for
 *                                              an imperatively-attached source
 * @param {string | null} props.incomingLabel   progress text while receiving P2P
 * @param {boolean} props.isHost                host sees a click-to-select empty state
 * @param {boolean} props.showMembers           whether the members popup is open
 * @param {Array<object>} props.members         room members (see useSocket)
 * @param {() => void} props.onSelectVideo      opens the hidden file picker
 * @param {() => void} props.onTogglePlay       host/guest click-to-toggle playback
 */
export default function VideoStage({
  videoRef,
  videoSrc,
  videoName,
  mediaReady = false,
  incomingLabel = null,
  isHost,
  showMembers,
  members,
  onSelectVideo,
  onTogglePlay,
}) {
  const showOverlay = !videoSrc && !mediaReady

  return (
    <div className="room__video-container" id="video-container">
      {/* src stays undefined until a blob URL exists; MSE mode attaches its
          MediaSource object URL imperatively and React never touches it. */}
      <video ref={videoRef} className="room__video" src={videoSrc || undefined} onClick={onTogglePlay} />

      {showOverlay && (
        <div
          className={`room__video-empty ${incomingLabel ? 'room__video-empty--incoming' : ''}`}
          onClick={isHost && !incomingLabel ? onSelectVideo : undefined}
        >
          {!incomingLabel && (
            <div className="room__empty-icon">
              <PlayIcon size={48} strokeWidth={1.5} />
            </div>
          )}
          <p className="room__empty-text">
            {incomingLabel || (isHost ? 'Click to select a video' : 'Waiting for host to start a video…')}
          </p>
          {videoName && !incomingLabel && <p className="room__now-playing">{videoName}</p>}
        </div>
      )}

      {/* Members Popup */}
      {showMembers && <MembersPopup members={members} />}
    </div>
  )
}
