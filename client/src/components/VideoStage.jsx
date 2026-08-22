import { PlayIcon } from './Icons.jsx'
import MembersPopup from './MembersPopup.jsx'

/**
 * @file The main viewing area: either the <video> element or an empty state,
 * plus the members overlay. Purely presentational — all playback state lives
 * in pages/Room.jsx.
 */

/**
 * @param {object} props
 * @param {React.RefObject} props.videoRef      ref attached to the <video> element
 * @param {string | null} props.videoSrc        object URL of the selected file
 * @param {string} props.videoName              display name of the loaded file
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
  isHost,
  showMembers,
  members,
  onSelectVideo,
  onTogglePlay,
}) {
  return (
    <div className="room__video-container" id="video-container">
      {videoSrc ? (
        <video ref={videoRef} className="room__video" src={videoSrc} onClick={onTogglePlay} />
      ) : (
        <div
          className="room__video-empty"
          onClick={isHost ? onSelectVideo : undefined}
        >
          <div className="room__empty-icon">
            <PlayIcon size={48} strokeWidth={1.5} />
          </div>
          <p className="room__empty-text">
            {isHost ? 'Click to select a video' : 'Waiting for host to start a video…'}
          </p>
          {videoName && <p className="room__now-playing">{videoName}</p>}
        </div>
      )}

      {/* Members Popup */}
      {showMembers && <MembersPopup members={members} />}
    </div>
  )
}
