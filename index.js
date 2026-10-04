/// <reference path="plugins.d.ts" />

// Square Golf Omni plugin for OpenGolfSim.

const UUID = {
  CMD: '86602101-6b7e-439a-bdd1-489a3213e9bb',
  EVT: '86602102-6b7e-439a-bdd1-489a3213e9bb',
  FW_VERSION: '86602003-6b7e-439a-bdd1-489a3213e9bb',
};

const CMD = {
  DETECT_BALL: 0x81,
  SELECT_CLUB: 0x82,
  HEARTBEAT: 0x83,
  QUERY: 0x86,
  REQUEST_CLUB_METRICS: 0x87,
};

const SPIN_ADVANCED = 0x11;
const HANDED_RIGHT = 0x00;

// Omni club codes: [club_number, category] (WIRE.md §8). * = unverified upstream.
const OMNI_CLUBS = {
  DRIVER: [0x01, 0x00],
  WOOD3: [0x03, 0x01],
  WOOD5: [0x05, 0x01], // *
  WOOD7: [0x07, 0x01], // *
  HYBRID3: [0x0d, 0x01],
  HYBRID4: [0x0e, 0x01], // *
  HYBRID5: [0x0f, 0x01],
  IRON3: [0x03, 0x02], // *
  IRON4: [0x04, 0x02],
  IRON5: [0x05, 0x02],
  IRON6: [0x06, 0x02],
  IRON7: [0x07, 0x02],
  IRON8: [0x08, 0x02],
  IRON9: [0x09, 0x02],
  PW: [0x0a, 0x02],
  GW: [0x0b, 0x02],
  SW: [0x0c, 0x02],
  LW: [0x0d, 0x02], // *
  PUTTER: [0x01, 0x03],
};

const MPS_TO_MPH = 2.23694;
const HEARTBEAT_MS = 5000;
const NAME_PATTERN = /^SquareGolf/i;

const scope = {
  bt: null,
  peripheral: null,
  chars: { cmd: null, evt: null, fw: null },
  isScanning: false,
  isConnecting: false,
  isExiting: false,
  seq: 0,
  shotNumber: 0,
  lastNotificationHex: null,
  heartbeatTimer: null,
  writeChain: Promise.resolve(),
  device: { isConnected: false, isReady: false },
};

// ---------- helpers ----------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toBytes(data) {
  if (!data) return new Uint8Array(0);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data.buffer instanceof ArrayBuffer) return new Uint8Array(data.buffer);
  return new Uint8Array(0);
}

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function i16le(b, o) {
  const v = b[o] | (b[o + 1] << 8);
  return v & 0x8000 ? v - 0x10000 : v;
}

function normalizeUuid(uuid) {
  return (uuid || '').replace(/-/g, '').toLowerCase();
}

function setStatus(patch) {
  let changed = false;
  for (const key of Object.keys(patch)) {
    if (scope.device[key] !== patch[key]) {
      scope.device[key] = patch[key];
      changed = true;
    }
  }
  if (changed) shotData.updateDeviceStatus({ ...scope.device });
}

// ---------- commands ----------

// Commands are always 9 bytes: [0x00, type, seq, payload..., zero-padded]
function encodeCommand(type, payload = []) {
  const b = new Uint8Array(9);
  b[0] = 0x00;
  b[1] = type;
  b[2] = scope.seq;
  scope.seq = (scope.seq + 1) & 0xff;
  payload.forEach((v, i) => { b[3 + i] = v & 0xff; });
  return b;
}

// Serialize writes; CMD is write-with-response.
function sendCommand(type, payload) {
  const bytes = encodeCommand(type, payload);
  scope.writeChain = scope.writeChain
    .then(() => {
      if (!scope.chars.cmd) throw new Error('CMD characteristic not available');
      return scope.chars.cmd.write(bytes.buffer, false);
    })
    .catch((err) => logging.error(`Command 0x${type.toString(16)} failed`, err));
  return scope.writeChain;
}

const sendHeartbeat = () => sendCommand(CMD.HEARTBEAT);
const sendQuery = () => sendCommand(CMD.QUERY);
const sendDetectBall = (on) => sendCommand(CMD.DETECT_BALL, [on ? 0x01 : 0x00, SPIN_ADVANCED]);
const sendSelectClub = (club, handed = HANDED_RIGHT) => sendCommand(CMD.SELECT_CLUB, [club[0], club[1], handed]);

// ---------- notifications ----------

function handleSensor(b) {
  if (b.length < 17) return;
  const ballReady = b[3] === 0x01 || b[3] === 0x02;
  const ballDetected = b[4] === 0x01;
  setStatus({ isReady: ballReady && ballDetected });
}

function handleBallMetrics(b) {
  if (b.length < 17) return;

  const ballSpeedMps = i16le(b, 3) / 100;
  const launchAngle = i16le(b, 5) / 100;
  const direction = i16le(b, 7) / 100; // positive = right
  const totalSpin = i16le(b, 9);
  // Omni reports spin axis negative = curves right; invert to positive = right.
  const spinAxis = -(i16le(b, 11) / 100);

  const valid =
    ballSpeedMps > 0 && ballSpeedMps < 250 &&
    totalSpin >= 0 && totalSpin < 30000 &&
    launchAngle >= 0;

  if (!valid) {
    logging.info('Discarding invalid ball metrics', { ballSpeedMps, launchAngle, totalSpin });
    return;
  }

  scope.shotNumber += 1;
  const shot = {
    shotNumber: scope.shotNumber,
    ballSpeed: ballSpeedMps * MPS_TO_MPH,
    verticalLaunchAngle: launchAngle,
    horizontalLaunchAngle: direction,
    spinSpeed: totalSpin,
    spinAxis,
  };

  logging.info('Sending shot', shot);
  shotData.sendShot(shot);
  setStatus({ isReady: false });
  // Device stays armed across shots (SEQUENCE.md §5); no re-arm needed.
}

function handleHeartbeatAck(b) {
  if (b.length < 4) return;
  // Device state: 0 none, 1 idle, 2 init, 3 detect, 4 ready, 5 shot, 6 done
  logging.info(`Device state: ${b[3]}`);
}

function handleBattery(b) {
  if (b.length < 2) return;
  setStatus({ batteryLevel: b[1] });
}

function handleNotification(data) {
  const b = toBytes(data);

  // Zero-length notification = device tearing down the link.
  if (b.length === 0) {
    logging.info('Zero-length notification; device disconnecting');
    return;
  }

  // Every notification is sent twice, byte-identical.
  const hex = toHex(b);
  if (hex === scope.lastNotificationHex) return;
  scope.lastNotificationHex = hex;

  const family = b[0];
  if (family === 0x91) return handleBattery(b);
  if (family === 0x71) return; // clock tick
  if (family !== 0x11 || b.length < 2) return;

  switch (b[1]) {
    case 0x01: return handleSensor(b);
    case 0x02: return handleBallMetrics(b);
    case 0x03: return handleHeartbeatAck(b);
    case 0x06: return; // query response
    case 0x07: return; // club metrics (not requested)
    default:
      logging.info(`Unhandled notification ${hex}`);
  }
}

// ---------- connection ----------

async function readFirmware() {
  if (!scope.chars.fw) return undefined;
  try {
    const raw = toBytes(await scope.chars.fw.read());
    const json = JSON.parse(String.fromCharCode.apply(null, raw));
    return json.lm || JSON.stringify(json);
  } catch (err) {
    logging.error('Failed to read firmware', err);
    return undefined;
  }
}

async function discoverCharacteristics(peripheral) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const result = await peripheral.discoverAllServicesAndCharacteristics();
    const characteristics = (result && result.characteristics) || [];
    if (characteristics.length > 0) return characteristics;
    logging.info(`No characteristics found (attempt ${attempt}), retrying...`);
    await sleep(250);
  }
  throw new Error('Service discovery returned no characteristics');
}

function resetConnectionState() {
  clearInterval(scope.heartbeatTimer);
  scope.heartbeatTimer = null;
  scope.peripheral = null;
  scope.chars = { cmd: null, evt: null, fw: null };
  scope.lastNotificationHex = null;
  scope.writeChain = Promise.resolve();
  scope.isConnecting = false;
  scope.device = { isConnected: false, isReady: false };
  shotData.updateDeviceStatus({ ...scope.device });
}

async function connectToDevice(peripheral) {
  scope.isConnecting = true;
  scope.peripheral = peripheral;

  try {
    await stopScan();
    await sleep(250);

    peripheral.on('disconnect', async () => {
      logging.info('Square Omni disconnected');
      resetConnectionState();
      if (!scope.isExiting) await startScan();
    });
    peripheral.on('error', (err) => logging.error('Peripheral error', err));

    await peripheral.connect();
    logging.info('Connected to Square Omni');
    await sleep(250);

    const characteristics = await discoverCharacteristics(peripheral);
    const find = (uuid) => characteristics.find((c) => normalizeUuid(c.uuid) === normalizeUuid(uuid));

    scope.chars.cmd = find(UUID.CMD);
    scope.chars.evt = find(UUID.EVT);
    scope.chars.fw = find(UUID.FW_VERSION);

    if (!scope.chars.cmd || !scope.chars.evt) {
      throw new Error('Required CMD/EVT characteristics not found');
    }

    const firmware = await readFirmware();
    logging.info(`Firmware (lm): ${firmware}`);

    await sleep(250);
    scope.chars.evt.on('data', (data) => {
      try {
        handleNotification(data);
      } catch (err) {
        logging.error('Notification error', err);
      }
    });
    await scope.chars.evt.subscribe();

    // Session init + arming (SEQUENCE.md §4-5)
    await sendQuery();
    await sendHeartbeat();
    await sendSelectClub(OMNI_CLUBS.DRIVER);
    await sendDetectBall(true);

    scope.heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);

    scope.isConnecting = false;
    setStatus({ isConnected: true, firmware });
  } catch (err) {
    logging.error('Failed to connect to Square Omni', err);
    try { await peripheral.disconnect(); } catch (e) { /* ignore */ }
    resetConnectionState();
    if (!scope.isExiting) await startScan();
  }
}

function isTargetDevice(device) {
  const pairedId = typeof preferences !== 'undefined'
    ? preferences.launchMonitor && preferences.launchMonitor.bluetoothAddress
    : undefined;
  if (pairedId && device.id === pairedId) return true;
  return NAME_PATTERN.test((device.advertisement && device.advertisement.localName) || '');
}

function handleDiscoveredDevice(device) {
  if (scope.isConnecting || scope.peripheral) return;
  if (!isTargetDevice(device)) return;
  logging.info(`Found Square Omni (id:${device.id}, name:${device.advertisement && device.advertisement.localName})`);
  connectToDevice(device);
}

async function startScan() {
  if (scope.isScanning) return;
  scope.bt.on('discover', handleDiscoveredDevice);
  await scope.bt.startScanning();
  scope.isScanning = true;
  logging.info('Scanning for Square Omni...');
}

async function stopScan() {
  if (!scope.isScanning) return;
  scope.bt.off('discover', handleDiscoveredDevice);
  await scope.bt.stopScanning();
  scope.isScanning = false;
}

system.on('exit', async () => {
  logging.info('Exiting ogs-plugin-square-omni...');
  scope.isExiting = true;
  clearInterval(scope.heartbeatTimer);
  try {
    if (scope.peripheral && scope.chars.cmd) {
      await sendDetectBall(false);
    }
    if (scope.peripheral) await scope.peripheral.disconnect();
  } catch (err) {
    logging.error('Error during disconnect', err);
  }
  await stopScan();
});

(async () => {
  try {
    logging.info('Starting ogs-plugin-square-omni...');
    scope.bt = bluetooth.createClient();
    await scope.bt.waitForPoweredOn();
    await startScan();
  } catch (err) {
    logging.error('Plugin error', err);
  }
})();
