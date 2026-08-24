const { spawn } = require('child_process');
const http = require('http');
const { io } = require('socket.io-client');

// ── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3002;
const SERVER_URL = `http://localhost:${PORT}`;
const STARTUP_TIMEOUT_MS = 10000;
const CONNECT_TIMEOUT_MS = 5000;
const TEST_WATCHDOG_MS = 30000;

let serverProcess = null;

function cleanup() {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
}
process.on('exit', cleanup);

// ── Server lifecycle helpers ────────────────────────────────────────────────

/**
 * Single health probe. Resolves true only if /health answers 200.
 */
function probeHealth() {
  return new Promise((resolve) => {
    const req = http.get(`${SERVER_URL}/health`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * Poll /health until the server responds or the deadline passes.
 */
async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeHealth()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `Signaling server did not become ready at ${SERVER_URL} within ${timeoutMs}ms`
  );
}

/**
 * Start server.js as a child process unless something is already listening.
 */
async function startServerIfNeeded() {
  if (await probeHealth()) {
    console.log(`Reusing already-running server at ${SERVER_URL}`);
    return;
  }

  console.log(`Starting signaling server on port ${PORT}...`);
  serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: process.env,
    stdio: 'inherit',
  });

  serverProcess.on('error', (err) => {
    console.error('Failed to spawn server process:', err.message);
    process.exit(1);
  });

  await waitForServer(STARTUP_TIMEOUT_MS);
  console.log('Server is up.');
}

/**
 * Connect a socket with a hard timeout so we never hang forever.
 */
function connectSocket(label) {
  const socket = io(SERVER_URL);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label}: timed out connecting to ${SERVER_URL}`));
    }, CONNECT_TIMEOUT_MS);

    socket.on('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(new Error(`${label}: connect_error — ${err.message}`));
    });
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

async function runTests() {
  // 1. Connect Host
  const hostSocket = await connectSocket('Host');
  console.log('✓ Host connected with ID:', hostSocket.id);

  // 2. Create Room
  const roomCode = 'TST' + Math.floor(100 + Math.random() * 900);
  const createRes = await new Promise((resolve) => {
    hostSocket.emit(
      'room:create',
      { name: 'Integration Test Room', code: roomCode, displayName: 'Test Host' },
      resolve
    );
  });
  console.log('✓ Host created room:', createRes);
  if (!createRes.ok || createRes.code !== roomCode) {
    throw new Error('Failed to create room');
  }
  if (createRes.members[0]?.displayName !== 'Test Host') {
    throw new Error('Host display name not applied');
  }

  // 3. Connect Guest
  const guestSocket = await connectSocket('Guest');
  console.log('✓ Guest connected with ID:', guestSocket.id);

  // Set up listener on Host for member joined
  const hostMemberJoinedPromise = new Promise((resolve) => {
    hostSocket.on('room:member-joined', (data) => {
      console.log('✓ Host received room:member-joined:', data.displayName);
      resolve(data);
    });
  });

  // 4. Guest Joins Room (with a custom display name)
  const joinRes = await new Promise((resolve) => {
    guestSocket.emit('room:join', { code: roomCode, displayName: 'Test Guest' }, resolve);
  });
  console.log('✓ Guest joined room:', joinRes);
  if (!joinRes.ok || joinRes.members.length !== 2) {
    throw new Error('Failed to join room properly');
  }
  const joinedMember = joinRes.members.find((m) => m.socketId === guestSocket.id);
  if (!joinedMember || joinedMember.displayName !== 'Test Guest') {
    throw new Error('Guest display name not applied');
  }

  const memberJoinedData = await hostMemberJoinedPromise;
  if (memberJoinedData.displayName !== 'Test Guest') {
    throw new Error('room:member-joined did not carry the custom display name');
  }

  // 5. Test WebRTC Signaling Relay
  const guestOfferPromise = new Promise((resolve) => {
    guestSocket.on('signal:offer', (data) => {
      console.log('✓ Guest received signal:offer from:', data.from);
      resolve(data);
    });
  });

  hostSocket.emit('signal:offer', { to: guestSocket.id, offer: { type: 'offer', sdp: 'fake-sdp' } });
  await guestOfferPromise;

  // 6. Test Playback Sync (Host -> Guest)
  const guestSyncPromise = new Promise((resolve) => {
    guestSocket.on('playback:sync', (data) => {
      console.log('✓ Guest received playback:sync:', data);
      resolve(data);
    });
  });

  hostSocket.emit('playback:sync', { action: 'play', time: 42.5 });
  const syncData = await guestSyncPromise;
  if (syncData.action !== 'play' || syncData.time !== 42.5) {
    throw new Error('Playback sync data mismatch');
  }

  // 7. Test Non-host Playback Sync blocked
  let guestDispatched = false;
  hostSocket.on('playback:sync', () => {
    guestDispatched = true;
  });
  guestSocket.emit('playback:sync', { action: 'pause', time: 10 });
  await new Promise((r) => setTimeout(r, 200));
  if (guestDispatched) {
    throw new Error('Non-host was able to dispatch playback:sync');
  }
  console.log('✓ Non-host playback sync properly ignored by server');

  // 8. Test Chat Relay — non-members must not reach the room
  const outsiderSocket = await connectSocket('Outsider');
  console.log('✓ Outsider connected with ID:', outsiderSocket.id);

  let strayChat = false;
  const onStrayChat = () => {
    strayChat = true;
  };
  hostSocket.on('chat:message', onStrayChat);
  outsiderSocket.emit('chat:message', { text: 'sneaky message' });
  await new Promise((r) => setTimeout(r, 200));
  hostSocket.off('chat:message', onStrayChat);
  if (strayChat) {
    throw new Error('Non-member was able to dispatch chat:message');
  }
  console.log('✓ Non-member chat properly ignored by server');

  // 9. Duplicate display names get a numeric suffix
  const dupJoinRes = await new Promise((resolve) => {
    outsiderSocket.emit('room:join', { code: roomCode, displayName: 'Test Guest' }, resolve);
  });
  if (!dupJoinRes.ok) throw new Error('Duplicate-name guest failed to join');
  const dupMember = dupJoinRes.members.find((m) => m.socketId === outsiderSocket.id);
  if (!dupMember || dupMember.displayName !== 'Test Guest 2') {
    throw new Error(`Duplicate name not suffixed (got "${dupMember?.displayName}")`);
  }
  console.log('✓ Duplicate guest name deduplicated as:', dupMember.displayName);

  // 10. Test Chat Relay — guest → room (sender receives own echo too)
  const hostChatPromise = new Promise((resolve) => {
    hostSocket.once('chat:message', resolve);
  });
  const guestEchoPromise = new Promise((resolve) => {
    guestSocket.once('chat:message', resolve);
  });
  const outsiderCopyPromise = new Promise((resolve) => {
    outsiderSocket.once('chat:message', resolve);
  });

  guestSocket.emit('chat:message', { text: 'hello from the guest' });
  const [hostChat, guestEcho] = await Promise.all([
    hostChatPromise,
    guestEchoPromise,
    outsiderCopyPromise,
  ]);
  if (
    hostChat.from !== guestSocket.id ||
    hostChat.displayName !== 'Test Guest' ||
    hostChat.text !== 'hello from the guest' ||
    typeof hostChat.ts !== 'number'
  ) {
    throw new Error('Guest chat relay data mismatch: ' + JSON.stringify(hostChat));
  }
  if (guestEcho.text !== 'hello from the guest') {
    throw new Error('Sender did not receive their own chat echo');
  }
  console.log('✓ Guest chat relayed to all members and echoed back to sender');

  // 11. Test Chat Relay — host → room
  const outsiderChatPromise = new Promise((resolve) => {
    outsiderSocket.once('chat:message', resolve);
  });
  hostSocket.emit('chat:message', { text: 'hello from the host   ' });
  const outsiderChat = await outsiderChatPromise;
  if (
    outsiderChat.from !== hostSocket.id ||
    outsiderChat.displayName !== 'Test Host' ||
    outsiderChat.text !== 'hello from the host'
  ) {
    throw new Error('Host chat relay data mismatch: ' + JSON.stringify(outsiderChat));
  }
  console.log('✓ Host chat relayed to members (input trimmed by server)');

  // ── Streaming mode (stream:set-mode / stream:mode-changed / join ack) ────

  // 12. Non-host may not change the streaming mode
  let strayModeChange = false;
  const onStrayMode = () => {
    strayModeChange = true;
  };
  hostSocket.on('stream:mode-changed', onStrayMode);
  const denyModeRes = await new Promise((resolve) => {
    guestSocket.emit('stream:set-mode', { type: 'url', url: 'https://example.com/sneaky.mp4' }, resolve);
  });
  if (denyModeRes.ok) {
    throw new Error('Non-host was able to change the streaming mode');
  }
  await new Promise((r) => setTimeout(r, 200));
  hostSocket.off('stream:mode-changed', onStrayMode);
  if (strayModeChange) {
    throw new Error('Non-host stream:set-mode reached the room');
  }
  console.log('✓ Non-host streaming mode change properly rejected by server');

  // 13. Host sets a URL mode → relayed to everyone including the sender
  const modePromises = [hostSocket, guestSocket, outsiderSocket].map(
    (s) => new Promise((resolve) => s.once('stream:mode-changed', resolve))
  );
  const setModeRes = await new Promise((resolve) => {
    hostSocket.emit(
      'stream:set-mode',
      { type: 'url', url: '  https://example.com/movie.mp4  ' },
      resolve
    );
  });
  if (!setModeRes.ok || setModeRes.mode?.type !== 'url') {
    throw new Error('Host stream:set-mode did not ack ok: ' + JSON.stringify(setModeRes));
  }
  const modePayloads = await Promise.all(modePromises);
  for (const p of modePayloads) {
    if (
      p.from !== hostSocket.id ||
      p.displayName !== 'Test Host' ||
      p.type !== 'url' ||
      p.url !== 'https://example.com/movie.mp4'
    ) {
      throw new Error('stream:mode-changed data mismatch: ' + JSON.stringify(p));
    }
  }
  console.log('✓ URL streaming mode set by host and relayed to all members (URL trimmed)');

  // 14. Invalid modes / URLs are rejected
  for (const bad of [
    { type: 'hologram' },
    { type: 'url' },
    { type: 'url', url: 'ftp://example.com/movie.mp4' },
  ]) {
    const badRes = await new Promise((resolve) => {
      hostSocket.emit('stream:set-mode', bad, resolve);
    });
    if (badRes.ok) {
      throw new Error('Invalid stream mode accepted: ' + JSON.stringify(bad));
    }
  }
  console.log('✓ Invalid streaming modes/URLs rejected by server');

  // 15. Late joiner learns the current streaming mode via the join ack
  const lateSocket = await connectSocket('Late Joiner');
  const lateJoinRes = await new Promise((resolve) => {
    lateSocket.emit('room:join', { code: roomCode, displayName: 'Late Guest' }, resolve);
  });
  if (
    !lateJoinRes.ok ||
    lateJoinRes.streamMode?.type !== 'url' ||
    lateJoinRes.streamMode?.url !== 'https://example.com/movie.mp4'
  ) {
    throw new Error('Join ack missing current streamMode: ' + JSON.stringify(lateJoinRes.streamMode));
  }
  console.log('✓ Late joiner received current streamMode in join ack');
  lateSocket.disconnect();

  // 16. Switching back to p2p mode relays url:null
  const fileModePromise = new Promise((resolve) => {
    guestSocket.once('stream:mode-changed', resolve);
  });
  hostSocket.emit('stream:set-mode', { type: 'p2p' });
  const fileModeData = await fileModePromise;
  if (fileModeData.type !== 'p2p' || fileModeData.url !== null) {
    throw new Error('File mode relay mismatch: ' + JSON.stringify(fileModeData));
  }
  // Restore URL mode so it is still active for the disconnect checks below.
  hostSocket.emit('stream:set-mode', { type: 'url', url: 'https://example.com/movie.mp4' });
  await new Promise((r) => setTimeout(r, 200));
  console.log('✓ P2P streaming mode relayed with url:null');

  // ── Room visibility + member removal (host administration) ───────────────

  // 17. Non-host may not change room visibility
  let strayVisibility = false;
  const onStrayVisibility = () => {
    strayVisibility = true;
  };
  hostSocket.on('room:visibility-changed', onStrayVisibility);
  const denyVisRes = await new Promise((resolve) => {
    guestSocket.emit('room:set-visibility', { isPublic: true }, resolve);
  });
  if (denyVisRes.ok) {
    throw new Error('Non-host was able to change room visibility');
  }
  await new Promise((r) => setTimeout(r, 200));
  hostSocket.off('room:visibility-changed', onStrayVisibility);
  if (strayVisibility) {
    throw new Error('Non-host room:set-visibility reached the room');
  }
  console.log('✓ Non-host visibility change properly rejected by server');

  // 18. Host makes the room public → relayed to all + discoverable via room:list
  const visPromises = [hostSocket, guestSocket, outsiderSocket].map(
    (s) => new Promise((resolve) => s.once('room:visibility-changed', resolve))
  );
  const visRes = await new Promise((resolve) => {
    hostSocket.emit('room:set-visibility', { isPublic: true }, resolve);
  });
  if (!visRes.ok || visRes.isPublic !== true) {
    throw new Error('Host room:set-visibility did not ack ok: ' + JSON.stringify(visRes));
  }
  const badVisRes = await new Promise((resolve) => {
    hostSocket.emit('room:set-visibility', { isPublic: 'yes' }, resolve);
  });
  if (badVisRes.ok) {
    throw new Error('Non-boolean isPublic accepted by server');
  }
  const visPayloads = await Promise.all(visPromises);
  for (const p of visPayloads) {
    if (
      p.from !== hostSocket.id ||
      p.displayName !== 'Test Host' ||
      p.isPublic !== true
    ) {
      throw new Error('room:visibility-changed data mismatch: ' + JSON.stringify(p));
    }
  }
  const listRes = await new Promise((resolve) => {
    hostSocket.emit('room:list', null, resolve);
  });
  if (!listRes.ok || !Array.isArray(listRes.rooms)) {
    throw new Error('room:list did not ack with a rooms array');
  }
  const listedRoom = listRes.rooms.find((r) => r.code === roomCode);
  if (
    !listedRoom ||
    listedRoom.name !== 'Integration Test Room' ||
    listedRoom.hostName !== 'Test Host' ||
    listedRoom.memberCount !== 3
  ) {
    throw new Error('Public room missing/wrong in room:list: ' + JSON.stringify(listRes.rooms));
  }
  console.log('✓ Public visibility relayed and room listed for discovery');

  // 19. Late joiner learns visibility via the join ack
  const lateSocket2 = await connectSocket('Late Joiner 2');
  const lateJoin2Res = await new Promise((resolve) => {
    lateSocket2.emit('room:join', { code: roomCode, displayName: 'Late Guest 2' }, resolve);
  });
  if (!lateJoin2Res.ok || lateJoin2Res.isPublic !== true) {
    throw new Error('Join ack missing isPublic: ' + JSON.stringify(lateJoin2Res));
  }
  console.log('✓ Late joiner received isPublic:true in join ack');
  lateSocket2.disconnect();

  // 20. Member removal (kick): permissions + full flow
  const victimSocket = await connectSocket('Victim');
  const victimJoinRes = await new Promise((resolve) => {
    victimSocket.emit('room:join', { code: roomCode, displayName: 'Victim Guest' }, resolve);
  });
  if (!victimJoinRes.ok) throw new Error('Victim failed to join');

  const guestKickRes = await new Promise((resolve) => {
    guestSocket.emit('room:kick', { socketId: victimSocket.id }, resolve);
  });
  if (guestKickRes.ok) {
    throw new Error('Non-host was able to kick a member');
  }

  const selfKickRes = await new Promise((resolve) => {
    hostSocket.emit('room:kick', { socketId: hostSocket.id }, resolve);
  });
  if (selfKickRes.ok) {
    throw new Error('Host was able to kick themselves');
  }

  const ghostKickRes = await new Promise((resolve) => {
    hostSocket.emit('room:kick', { socketId: 'no-such-socket' }, resolve);
  });
  if (ghostKickRes.ok) {
    throw new Error('Host was able to kick a non-member');
  }

  const victimKickedPromise = new Promise((resolve) => {
    victimSocket.once('room:kicked', resolve);
  });
  const kickLeftPromise = new Promise((resolve) => {
    guestSocket.once('room:member-left', resolve);
  });
  const kickAck = await new Promise((resolve) => {
    hostSocket.emit('room:kick', { socketId: victimSocket.id }, resolve);
  });
  if (!kickAck.ok) {
    throw new Error('Host kick failed: ' + JSON.stringify(kickAck));
  }
  const kickedData = await victimKickedPromise;
  if (!kickedData.reason) {
    throw new Error('room:kicked missing reason: ' + JSON.stringify(kickedData));
  }
  const kickLeftData = await kickLeftPromise;
  if (
    kickLeftData.socketId !== victimSocket.id ||
    kickLeftData.displayName !== 'Victim Guest' ||
    kickLeftData.kicked !== true ||
    kickLeftData.members.length !== 3
  ) {
    throw new Error('Kicked member-left data mismatch: ' + JSON.stringify(kickLeftData));
  }

  // The removed socket must no longer be able to reach the room…
  let strayPostKick = false;
  const onStrayPostKick = () => {
    strayPostKick = true;
  };
  guestSocket.on('playback:sync', onStrayPostKick);
  victimSocket.emit('playback:sync', { action: 'seek', time: 1 });
  await new Promise((r) => setTimeout(r, 200));
  guestSocket.off('playback:sync', onStrayPostKick);
  if (strayPostKick) {
    throw new Error('Kicked member could still broadcast into the room');
  }
  victimSocket.disconnect();
  console.log('✓ Host removed a member (kicked flag, room:kicked, access revoked)');

  // ── Room locking ──────────────────────────────────────────────────────────

  // 21. Non-host may not lock; host locks → relayed + joins rejected
  const denyLockRes = await new Promise((resolve) => {
    guestSocket.emit('room:set-locked', { locked: true }, resolve);
  });
  if (denyLockRes.ok) {
    throw new Error('Non-host was able to lock the room');
  }

  const badLockRes = await new Promise((resolve) => {
    hostSocket.emit('room:set-locked', { locked: 'yes' }, resolve);
  });
  if (badLockRes.ok) {
    throw new Error('Non-boolean locked accepted by server');
  }

  const lockPromises = [hostSocket, guestSocket, outsiderSocket].map(
    (s) => new Promise((resolve) => s.once('room:lock-changed', resolve))
  );
  const lockRes = await new Promise((resolve) => {
    hostSocket.emit('room:set-locked', { locked: true }, resolve);
  });
  if (!lockRes.ok || lockRes.locked !== true) {
    throw new Error('Host room:set-locked did not ack ok: ' + JSON.stringify(lockRes));
  }
  const lockPayloads = await Promise.all(lockPromises);
  for (const p of lockPayloads) {
    if (
      p.from !== hostSocket.id ||
      p.displayName !== 'Test Host' ||
      p.locked !== true
    ) {
      throw new Error('room:lock-changed data mismatch: ' + JSON.stringify(p));
    }
  }

  // A join with the CORRECT code is now rejected…
  const lockedJoiner = await connectSocket('Locked Joiner');
  const lockedJoinRes = await new Promise((resolve) => {
    lockedJoiner.emit('room:join', { code: roomCode, displayName: 'Should Fail' }, resolve);
  });
  if (
    lockedJoinRes.ok ||
    !/locked/i.test(lockedJoinRes.error || '')
  ) {
    throw new Error('Locked room accepted a join: ' + JSON.stringify(lockedJoinRes));
  }
  // …and the failed join did not cost the caller any existing membership.
  const outsiderStillIn = await new Promise((resolve) => {
    hostSocket.emit('room:list', null, (res) =>
      resolve(res.rooms?.some((r) => r.code === roomCode))
    );
  });
  if (!outsiderStillIn) {
    throw new Error('Room vanished after a rejected join');
  }
  console.log('✓ Locked room rejects joins with the correct code');

  // Late joiner that IS inside learns locked:true via the join ack.
  const lateJoin3Promise = new Promise((resolve) => {
    guestSocket.once('room:member-joined', resolve); // will fire for next join
  });

  // Host unlocks again → joins work once more.
  const unlockPromises = [hostSocket, guestSocket].map(
    (s) => new Promise((resolve) => s.once('room:lock-changed', resolve))
  );
  const unlockRes = await new Promise((resolve) => {
    hostSocket.emit('room:set-locked', { locked: false }, resolve);
  });
  if (!unlockRes.ok || unlockRes.locked !== false) {
    throw new Error('Host unlock did not ack ok: ' + JSON.stringify(unlockRes));
  }
  await Promise.all(unlockPromises);

  const rejoiner = await connectSocket('Rejoiner');
  const rejoinRes = await new Promise((resolve) => {
    rejoiner.emit('room:join', { code: roomCode, displayName: 'Rejoin Guest' }, resolve);
  });
  if (!rejoinRes.ok || rejoinRes.locked !== false || rejoinRes.isPublic !== true) {
    throw new Error('Post-unlock join failed or missing flags: ' + JSON.stringify(rejoinRes));
  }
  await lateJoin3Promise; // survivors saw the member-joined broadcast
  // Drain the departing member's broadcast so later tests see a quiet wire.
  const rejoinerId = rejoiner.id; // capture before disconnect() clears it
  const rejoinLeftPromise = new Promise((resolve) => {
    hostSocket.once('room:member-left', resolve);
  });
  rejoiner.disconnect();
  lockedJoiner.disconnect();
  const rejoinLeftData = await rejoinLeftPromise;
  if (rejoinLeftData.socketId !== rejoinerId) {
    throw new Error('Unexpected member-left during cleanup: ' + JSON.stringify(rejoinLeftData));
  }
  console.log('✓ Unlocking re-opens the room and join acks carry isPublic/locked flags');

  // 22. Test Member-Left carries the leaver's display name
  const outsiderId = outsiderSocket.id; // capture before disconnect() clears it
  const memberLeftPromise = new Promise((resolve) => {
    hostSocket.once('room:member-left', resolve);
  });
  outsiderSocket.disconnect();
  const leftData = await memberLeftPromise;
  if (
    leftData.socketId !== outsiderId ||
    leftData.displayName !== 'Test Guest 2'
  ) {
    throw new Error('room:member-left data mismatch: ' + JSON.stringify(leftData));
  }
  console.log('✓ Host received room:member-left with displayName:', leftData.displayName);

  // 23. Test Disconnect / Host-Left
  const guestHostLeftPromise = new Promise((resolve) => {
    guestSocket.on('room:host-left', () => {
      console.log('✓ Guest received room:host-left upon host disconnect');
      resolve();
    });
  });

  hostSocket.disconnect();
  await guestHostLeftPromise;

  guestSocket.disconnect();
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('--- Starting Signaling Server Integration Tests ---');

  // Watchdog: never let a stuck promise hang the run indefinitely.
  const watchdog = setTimeout(() => {
    console.error(`Test suite timed out after ${TEST_WATCHDOG_MS}ms`);
    process.exit(1);
  }, TEST_WATCHDOG_MS);

  try {
    await startServerIfNeeded();
    await runTests();
    clearTimeout(watchdog);
    console.log('--- All Signaling Server Tests Passed! ---');
  } finally {
    if (!process.exitCode) cleanup();
  }
}

main().catch((err) => {
  console.error('Test failed:', err?.message ?? err);
  process.exit(1);
});
