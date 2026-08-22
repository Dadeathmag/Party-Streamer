import {
  PlaySolidIcon,
  PauseIcon,
  SkipBackIcon,
  SkipForwardIcon,
  VolumeIcon,
  VolumeOffIcon,
} from './Icons.jsx'
import { formatTime } from '../lib/formatTime.js'

/**
 * @file Transport controls under the video: seek bar, play/pause, ±10s skips,
 * volume group and the time readout. Presentational — playback state and the
 * <video> ref are owned by pages/Room.jsx.
 */

/**
 * @param {object} props
 * @param {React.RefObject} props.progressRef   container used for click-to-seek math
 * @param {number} props.pct                    played percentage (0–100)
 * @param {(e: MouseEvent) => void} props.onSeek
 * @param {boolean} props.isPlaying
 * @param {() => void} props.onTogglePlay
 * @param {(seconds: number) => void} props.onSkip
 * @param {number} props.volume                 0–1
 * @param {boolean} props.isMuted
 * @param {(e: ChangeEvent) => void} props.onVolumeChange
 * @param {() => void} props.onToggleMute
 * @param {number} props.currentTime            seconds
 * @param {number} props.duration               seconds; 0 until metadata loads
 * @param {string} props.videoName              shown as "now playing", if any
 */
export default function PlayerControls({
  progressRef,
  pct,
  onSeek,
  isPlaying,
  onTogglePlay,
  onSkip,
  volume,
  isMuted,
  onVolumeChange,
  onToggleMute,
  currentTime,
  duration,
  videoName,
}) {
  return (
    <div className="room__controls">
      {/* Progress Bar */}
      <div className="room__progress" ref={progressRef} onClick={onSeek} id="progress-bar">
        <div className="room__progress-fill" style={{ width: `${pct}%` }} />
        <div className="room__progress-thumb" style={{ left: `${pct}%` }} />
      </div>

      <div className="room__controls-row">
        <div className="room__controls-left">
          <button
            className="room__ctrl-btn"
            id="btn-play-pause"
            onClick={onTogglePlay}
            title={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? (
              <PauseIcon size={20} />
            ) : (
              <PlaySolidIcon size={20} />
            )}
          </button>

          <button
            className="room__ctrl-btn"
            id="btn-skip-back"
            onClick={() => onSkip(-10)}
            title="Back 10s"
          >
            <SkipBackIcon size={18} />
          </button>

          <button
            className="room__ctrl-btn"
            id="btn-skip-fwd"
            onClick={() => onSkip(10)}
            title="Forward 10s"
          >
            <SkipForwardIcon size={18} />
          </button>

          <div className="room__volume-group">
            <button
              className="room__ctrl-btn"
              id="btn-mute"
              onClick={onToggleMute}
              title={isMuted ? 'Unmute' : 'Mute'}
            >
              {isMuted || volume === 0 ? <VolumeOffIcon size={18} /> : <VolumeIcon size={18} />}
            </button>
            <input
              className="room__volume-slider"
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={isMuted ? 0 : volume}
              onChange={onVolumeChange}
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
  )
}
