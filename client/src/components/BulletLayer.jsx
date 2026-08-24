/**
 * @file Danmaku-style bullet overlay: recent chat messages scroll right-to-
 * left across the video surface. Rendered inside the video container so it
 * stays visible while the document is fullscreen; hidden outside of it via
 * CSS (.room--fullscreen .room__bullets). Purely presentational — bullet
 * spawning/expiry lives in pages/Room.jsx.
 */

export const BULLET_LANES = 7

/**
 * @param {object} props
 * @param {Array<{ id: number, user: string, text: string, isOwn?: boolean,
 *          lane: number, duration: number }>} props.bullets active bullets
 * @param {(id: number) => void} props.onExpire  called when a bullet's scroll
 *        animation finishes so Room can drop it from state
 */
export default function BulletLayer({ bullets, onExpire }) {
  return (
    <div className="room__bullets" id="bullet-layer" aria-hidden="true">
      {bullets.map((bullet) => (
        <span
          key={bullet.id}
          className={`room__bullet ${bullet.isOwn ? 'room__bullet--own' : ''}`}
          style={{
            top: `${bullet.lane * (100 / BULLET_LANES)}%`,
            animationDuration: `${bullet.duration}s`,
          }}
          onAnimationEnd={() => onExpire(bullet.id)}
        >
          <span className="room__bullet-user">{bullet.user}</span>
          {bullet.text}
        </span>
      ))}
    </div>
  )
}
