/**
 * @file Overlay listing everyone currently in the room.
 * Rendered on top of the video stage when the members toggle is active.
 */

/**
 * @param {{ members: Array<{ socketId: string, displayName: string, role: string }> }} props
 */
export default function MembersPopup({ members = [] }) {
  return (
    <div className="room__members-popup" id="members-popup">
      <h3 className="room__members-title">Members ({members.length})</h3>
      {members.map((m) => (
        <div className="room__member-item" key={m.socketId}>
          <div
            className={`room__member-avatar ${m.role === 'host' ? 'room__member-avatar--host' : ''}`}
          >
            {m.displayName.charAt(0).toUpperCase()}
          </div>
          <span>{m.displayName}</span>
          {m.role === 'host' && <span className="room__member-role">★</span>}
        </div>
      ))}
    </div>
  )
}
