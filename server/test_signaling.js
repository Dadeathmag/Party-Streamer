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
    hostSocket.emit('room:create', { name: 'Integration Test Room', code: roomCode }, resolve);
  });
  console.log('✓ Host created room:', createRes);
  if (!createRes.ok || createRes.code !== roomCode) {
    throw new Error('Failed to create room');
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

  // 4. Guest Joins Room
  const joinRes = await new Promise((resolve) => {
    guestSocket.emit('room:join', { code: roomCode }, resolve);
  });
  console.log('✓ Guest joined room:', joinRes);
  if (!joinRes.ok || joinRes.members.length !== 2) {
    throw new Error('Failed to join room properly');
  }

  await hostMemberJoinedPromise;

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

  // 8. Test Disconnect / Host-Left
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
