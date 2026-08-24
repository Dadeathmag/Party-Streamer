import { XIcon } from './Icons.jsx'

/**
 * @file Overlay listing everyone currently in the room.
 * Rendered on top of the video stage when the members toggle is active.
 * Hosts get a remove ("kick") button per non-host member when an
 * onKickMember callback is provided.
 */

/**
 * @param {object} props
 * @param {{ members: Array<{ socketId: string, displayName: string, role: string }> }} props.members
 * @param {(socketId: string) => void} [props.onKickMember]
 *        host-only: removes that member from the room; absent for guests
 */
export default function MembersPopup({ members = [], onKickMember }) {
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
          {onKickMember && m.role !== 'host' && (
            <button
              className="room__members-kick"
              id={`btn-kick-${m.socketId}`}
              title={`Remove ${m.displayName} from the room`}
              onClick={() => onKickMember(m.socketId)}
            >
              <XIcon size={12} />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
