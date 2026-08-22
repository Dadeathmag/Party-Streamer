const { io } = require('socket.io-client');

const SERVER_URL = 'http://localhost:3001';

async function runTests() {
  console.log('--- Starting Signaling Server Integration Tests ---');
  
  // 1. Connect Host
  const hostSocket = io(SERVER_URL);
  await new Promise((resolve) => hostSocket.on('connect', resolve));
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
  const guestSocket = io(SERVER_URL);
  await new Promise((resolve) => guestSocket.on('connect', resolve));
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
  console.log('--- All Signaling Server Tests Passed! ---');
  process.exit(0);
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
