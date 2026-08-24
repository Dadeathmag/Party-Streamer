import { PlayIcon, LinkIcon } from './Icons.jsx'
import BulletLayer from './BulletLayer.jsx'
import MembersPopup from './MembersPopup.jsx'

/**
 * @file The main viewing area: the <video> element (always mounted so the
 * guest-side MediaSource can attach before media arrives) with an optional
 * empty-state / receiving overlay, an optional provider-embed layer
 * (YouTube/Vimeo/… link mode), plus the members popup. Purely
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
 * @param {string | null} [props.embedUrl]      iframe src when a provider link is
 *                                              active (Room owns the controller)
 * @param {React.RefObject} [props.embedContainerRef]
 *                                              ref for the embed mount point
 * @param {string | null} [props.embedError]    fatal embed load/play message
 * @param {boolean} props.isHost                host sees a click-to-select empty state
 * @param {Array<object>} [props.bullets]       active danmaku bullets (fullscreen only)
 * @param {(id: number) => void} [props.onBulletExpire]
 *                                              bullet scroll finished
 * @param {boolean} props.showMembers           whether the members popup is open
 * @param {Array<object>} props.members         room members (see useSocket)
 * @param {(socketId: string) => void} [props.onKickMember]
 *                                              host-only member removal
 * @param {() => void} props.onSelectVideo      opens the hidden file picker
 * @param {() => void} props.onTogglePlay       host/guest click-to-toggle playback
 */
export default function VideoStage({
  videoRef,
  videoSrc,
  videoName,
  mediaReady = false,
  incomingLabel = null,
  embedUrl = null,
  embedContainerRef,
  embedError = null,
  isHost,
  bullets,
  onBulletExpire,
  showMembers,
  members,
  onKickMember,
  onSelectVideo,
  onTogglePlay,
}) {
  const embedActive = Boolean(embedUrl)
  const showOverlay = !videoSrc && !mediaReady && !embedActive

  return (
    <div className={`room__video-container ${embedActive ? 'room__video-container--embed' : ''}`} id="video-container">
      {/* src stays undefined until a blob URL exists; MSE mode attaches its
          MediaSource object URL imperatively and React never touches it.
          While a provider embed is showing, the element stays mounted but is
          hidden — the P2P layer keeps its handle. */}
      <video
        ref={videoRef}
        className={`room__video ${embedActive ? 'room__video--hidden' : ''}`}
        src={videoSrc || undefined}
        onClick={onTogglePlay}
      />

      {embedActive && (
        <div className="room__embed-layer">
          <div className="room__embed-frame" ref={embedContainerRef} />
          {embedError ? (
            <div className="room__embed-loading room__embed-loading--error">
              <LinkIcon size={22} />
              <span>{embedError}</span>
            </div>
          ) : (
            !mediaReady && (
              <div className="room__embed-loading">
                <LinkIcon size={22} />
                <span>Loading player…</span>
              </div>
            )
          )}
        </div>
      )}

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

      {/* Danmaku bullets (visible only in fullscreen via CSS) */}
      {bullets?.length > 0 && <BulletLayer bullets={bullets} onExpire={onBulletExpire} />}

      {/* Members Popup */}
      {showMembers && <MembersPopup members={members} onKickMember={onKickMember} />}
    </div>
  )
}
