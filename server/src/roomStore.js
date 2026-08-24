'use strict';

/**
 * @file In-memory room state for the signaling server.
 *
 * The store is deliberately "dumb": it only mutates plain data structures and
 * never touches Socket.IO. Handlers in src/handlers are responsible for
 * emitting events based on what the store returns.
 *
 * Data layout:
 *   rooms          Map<code, Room>
 *     Room = { code, name, hostId, isPublic, locked,
 *              members: Map<socketId, Member>,
 *              streamMode: { type: 'p2p'|'full'|'url', url: string|null } | null }
 *     Member = { displayName, role: 'host' | 'member' }
 *   socketToRoom   Map<socketId, code>      — reverse index for O(1) lookups
 *   guestCounters  Map<code, number>        — next "Guest-N" number per room
 */

class RoomStore {
  constructor() {
    /** @type {Map<string, object>} room code → room record */
    this.rooms = new Map();
    /** @type {Map<string, string>} socket id → room code */
    this.socketToRoom = new Map();
    /** @type {Map<string, number>} room code → last assigned guest number */
    this.guestCounters = new Map();
  }

  /** Number of active rooms (used by /health). */
  get size() {
    return this.rooms.size;
  }

  /**
   * Look up a room by its (already upper-cased) code.
   * @param {string} code
   */
  get(code) {
    return this.rooms.get(code);
  }

  /**
   * Which room code a socket currently belongs to, if any.
   * @param {string} socketId
   * @returns {string | undefined}
   */
  roomCodeOf(socketId) {
    return this.socketToRoom.get(socketId);
  }

  /**
   * Flatten a room's members Map into a plain array for transport.
   * @param {object} room
   * @returns {Array<{ socketId: string, displayName: string, role: string }>}
   */
  serialiseMembers(room) {
    const list = [];
    for (const [socketId, info] of room.members) {
      list.push({ socketId, displayName: info.displayName, role: info.role });
    }
    return list;
  }

  /**
   * Resolve a member's display name: use the caller-supplied name when it is
   * a non-empty string, otherwise fall back to `fallback`. If the name is
   * already taken inside the room, a numeric suffix (" 2", " 3", …) is
   * appended so every member stays distinguishable in chat/member lists.
   * Comparison is case-insensitive.
   *
   * @param {object} room
   * @param {string | undefined} desired raw (already length-capped) input
   * @param {string} fallback e.g. "Host" or "Guest-3"
   * @returns {string}
   */
  resolveDisplayName(room, desired, fallback) {
    const base = typeof desired === 'string' ? desired.trim() : '';
    if (!base) return fallback;

    const taken = new Set(
      [...room.members.values()].map((m) => m.displayName.toLowerCase())
    );
    let candidate = base;
    let n = 2;
    while (taken.has(candidate.toLowerCase())) {
      candidate = `${base} ${n}`;
      n += 1;
    }
    return candidate;
  }

  /**
   * Create a brand-new room owned by the given socket.
   *
   * @param {{ name: string, code: string, hostId: string, displayName?: string,
   *           isPublic?: boolean }} params
   *   `code` is expected pre-normalised (upper-case). `displayName` is an
   *   optional custom host name; defaults to "Host". `isPublic` marks the
   *   room discoverable via listPublicRooms() (default: private).
   * @returns {{ ok: true, room: object, members: object[] } |
   *           { ok: false, error: string }}
   */
  createHostRoom({ name, code, hostId, displayName, isPublic }) {
    if (this.rooms.has(code)) {
      return { ok: false, error: 'A room with that code already exists.' };
    }

    const room = {
      code,
      name,
      hostId,
      isPublic: !!isPublic,
      locked: false,
      members: new Map(),
      streamMode: null,
    };
    room.members.set(
      hostId,
      { displayName: this.resolveDisplayName(room, displayName, 'Host'), role: 'host' }
    );

    this.rooms.set(code, room);
    this.socketToRoom.set(hostId, code);
    this.guestCounters.set(code, 0);

    return { ok: true, room, members: this.serialiseMembers(room) };
  }

  /**
   * Add a guest to an existing room.
   *
   * Uses the guest's supplied `displayName` when present; otherwise falls
   * back to the next "Guest-N" name for the room. Duplicate names get a
   * numeric suffix (see resolveDisplayName).
   *
   * @param {{ code: string, socketId: string, displayName?: string }} params
   * @returns {{ ok: true, room: object, displayName: string, members: object[] } |
   *           { ok: false, error: string }}
   */
  joinGuest({ code, socketId, displayName }) {
    const room = this.rooms.get(code);
    if (!room) {
      return { ok: false, error: 'Room not found. Check the code and try again.' };
    }

    const guestNum = (this.guestCounters.get(code) || 0) + 1;
    this.guestCounters.set(code, guestNum);

    const finalName = this.resolveDisplayName(room, displayName, `Guest-${guestNum}`);

    room.members.set(socketId, { displayName: finalName, role: 'member' });
    this.socketToRoom.set(socketId, code);

    return { ok: true, room, displayName: finalName, members: this.serialiseMembers(room) };
  }

  /**
   * Store the room's current streaming mode (host-authoritative). The payload
   * shape is validated by the handler; the store just keeps it verbatim.
   *
   * @param {string} code
   * @param {{ type: string, url: string | null }} mode
   * @returns {object | null} the stored mode, or null when the room is gone
   */
  setStreamMode(code, mode) {
    const room = this.rooms.get(code);
    if (!room) return null;
    room.streamMode = mode;
    return room.streamMode;
  }

  /**
   * Store the room's visibility flag (host-authoritative).
   *
   * @param {string} code
   * @param {boolean} isPublic
   * @returns {boolean | null} the stored flag, or null when the room is gone
   */
  setRoomVisibility(code, isPublic) {
    const room = this.rooms.get(code);
    if (!room) return null;
    room.isPublic = !!isPublic;
    return room.isPublic;
  }

  /**
   * Store the room's locked flag (host-authoritative). A locked room rejects
   * every incoming join, even with the correct code.
   *
   * @param {string} code
   * @param {boolean} locked
   * @returns {boolean | null} the stored flag, or null when the room is gone
   */
  setLocked(code, locked) {
    const room = this.rooms.get(code);
    if (!room) return null;
    room.locked = !!locked;
    return room.locked;
  }

  /**
   * Snapshot of every public room for discovery listings. Private rooms are
   * never included — joining them requires knowing the exact code.
   *
   * @returns {Array<{ code: string, name: string, hostName: string, memberCount: number }>}
   */
  listPublicRooms() {
    const out = [];
    for (const room of this.rooms.values()) {
      if (!room.isPublic) continue;
      let hostName = 'Host';
      for (const info of room.members.values()) {
        if (info.role === 'host') hostName = info.displayName;
      }
      out.push({
        code: room.code,
        name: room.name,
        hostName,
        memberCount: room.members.size,
      });
    }
    return out;
  }

  /**
   * Remove a regular member from a room (host-initiated kick). The host
   * itself can never be removed through this path.
   *
   * @param {string} code
   * @param {string} socketId target member's socket id
   * @returns {{ ok: true, displayName: string, members: object[] } |
   *           { ok: false, error: string }}
   */
  removeMember(code, socketId) {
    const room = this.rooms.get(code);
    if (!room) return { ok: false, error: 'Room not found.' };

    const member = room.members.get(socketId);
    if (!member) return { ok: false, error: 'That member is not in the room.' };
    if (member.role === 'host') return { ok: false, error: 'The host cannot be removed.' };

    room.members.delete(socketId);
    this.socketToRoom.delete(socketId);

    return { ok: true, displayName: member.displayName, members: this.serialiseMembers(room) };
  }

  /**
   * Remove a socket from whatever room it is in.
   *
   * - Host leaving destroys the room outright: every remaining member's
   *   reverse-mapping is dropped and the room + counter are deleted.
   * - A regular member leaving just shrinks the member list.
   *
   * @param {string} socketId
   * @returns {{ code: string, destroyed: boolean, members: object[], displayName?: string } | null}
   *   null when the socket was not in any room. `displayName` is the leaver's
   *   name (absent when the room was destroyed or the member was unknown).
   */
  removeSocket(socketId) {
    const code = this.socketToRoom.get(socketId);
    if (!code) return null;

    this.socketToRoom.delete(socketId);

    const room = this.rooms.get(code);
    if (!room) return null;

    const leaver = room.members.get(socketId);
    room.members.delete(socketId);

    if (room.hostId === socketId) {
      // Host gone → tear the room down completely.
      for (const memberId of room.members.keys()) {
        this.socketToRoom.delete(memberId);
      }
      this.rooms.delete(code);
      this.guestCounters.delete(code);
      return { code, destroyed: true, members: [] };
    }

    return {
      code,
      destroyed: false,
      members: this.serialiseMembers(room),
      displayName: leaver?.displayName,
    };
  }
}

module.exports = { RoomStore };
