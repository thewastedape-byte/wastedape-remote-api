const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const Stripe = require('stripe');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 5e6 // 5MB for screenshot frames
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_placeholder', { apiVersion: '2024-04-10' });

// Sessions: code -> session object
const sessions = new Map();
// Latest screenshots: code -> base64 jpeg
const screenshots = new Map();
// Pending command results: code -> array of results
const commandResults = new Map();

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

setInterval(() => {
  const now = Date.now();
  for (const [code, session] of sessions.entries()) {
    if (now - session.createdAt > 60 * 60 * 1000) { // 1hr expiry
      sessions.delete(code);
      screenshots.delete(code);
      commandResults.delete(code);
    }
  }
}, 5 * 60 * 1000);

// ─── REST ENDPOINTS ───────────────────────────────────────────

app.get('/status', (req, res) => {
  res.json({ status: 'online', activeSessions: sessions.size });
});

// Create session
app.post('/api/session/create', (req, res) => {
  const { hostName, sessionType } = req.body;
  const code = generateCode();
  sessions.set(code, {
    code, hostName: hostName || 'WastedApe Tech',
    sessionType: sessionType || 'support',
    hostSocketId: null, clientSocketId: null, agentSocketId: null,
    paid: true, // all sessions free for now
    createdAt: Date.now()
  });
  commandResults.set(code, []);
  res.json({ code, expiresIn: '60 minutes' });
});

// Validate session
app.get('/api/session/:code', (req, res) => {
  const session = sessions.get(req.params.code);
  if (!session) return res.status(404).json({ error: 'Session not found or expired' });
  res.json({ valid: true, hostName: session.hostName, agentConnected: !!session.agentSocketId });
});

// ─── AI CONTROL API ──────────────────────────────────────────
// These endpoints let Maximus (AI) directly control a remote machine

// Get latest screenshot from agent
app.get('/api/control/:code/screenshot', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.CONTROL_API_KEY && apiKey !== 'wastedape-maximus-2026') {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const shot = screenshots.get(req.params.code);
  if (!shot) return res.status(404).json({ error: 'No screenshot yet - agent may not be connected' });
  res.json({ screenshot: shot, timestamp: Date.now() });
});

// Send command to agent
app.post('/api/control/:code/command', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.CONTROL_API_KEY && apiKey !== 'wastedape-maximus-2026') {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const session = sessions.get(req.params.code);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!session.agentSocketId) return res.status(400).json({ error: 'Agent not connected' });

  const cmd = req.body;
  io.to(session.agentSocketId).emit('control', cmd);
  res.json({ sent: true, command: cmd });
});

// Send multiple commands in sequence
app.post('/api/control/:code/sequence', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.CONTROL_API_KEY && apiKey !== 'wastedape-maximus-2026') {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const session = sessions.get(req.params.code);
  if (!session || !session.agentSocketId) return res.status(400).json({ error: 'Agent not connected' });

  const { commands, delayMs } = req.body;
  const delay = delayMs || 300;

  for (const cmd of commands) {
    io.to(session.agentSocketId).emit('control', cmd);
    await new Promise(r => setTimeout(r, delay));
  }
  res.json({ sent: commands.length, commands });
});

// Run a shell command on the remote machine and get output
app.post('/api/control/:code/shell', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.CONTROL_API_KEY && apiKey !== 'wastedape-maximus-2026') {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const session = sessions.get(req.params.code);
  if (!session || !session.agentSocketId) return res.status(400).json({ error: 'Agent not connected' });

  const { command, timeout } = req.body;
  const requestId = Date.now().toString();

  // Wait for result with timeout
  const timeoutMs = timeout || 30000;
  let resolved = false;

  const timer = setTimeout(() => {
    if (!resolved) {
      resolved = true;
      res.json({ requestId, output: null, error: 'Command timed out', timedOut: true });
    }
  }, timeoutMs);

  // Store pending shell request so socket handler can resolve it
  if (!session.pendingShell) session.pendingShell = {};
  session.pendingShell[requestId] = (result) => {
    if (!resolved) {
      resolved = true;
      clearTimeout(timer);
      res.json({ requestId, output: result.output, error: result.error, exitCode: result.exitCode });
    }
  };

  io.to(session.agentSocketId).emit('shell', { command, requestId });
});

// Get session info
app.get('/api/control/:code/info', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.CONTROL_API_KEY && apiKey !== 'wastedape-maximus-2026') {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const session = sessions.get(req.params.code);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({
    code: session.code,
    agentConnected: !!session.agentSocketId,
    hostConnected: !!session.hostSocketId,
    createdAt: session.createdAt,
    hasScreenshot: screenshots.has(req.params.code),
    screenW: session.screenW || null,
    screenH: session.screenH || null
  });
});

// Stripe
app.post('/api/session/checkout', async (req, res) => {
  const { code, service } = req.body;
  const session = sessions.get(code);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const PRICES = {
    basic: 'price_1TUnQTHfCuVeN1IriDWY13yV',
    pro: 'price_1TUnQUHfCuVeN1Ir1OtyiZdS',
  };
  try {
    const cs = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{ price: PRICES[service] || PRICES.basic, quantity: 1 }],
      metadata: { sessionCode: code },
      success_url: `${process.env.APP_URL || 'https://www.wastedape.org'}/remote/connect?code=${code}&paid=true`,
      cancel_url: `${process.env.APP_URL || 'https://www.wastedape.org'}/remote`,
    });
    res.json({ url: cs.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SOCKET.IO ────────────────────────────────────────────────

io.on('connection', (socket) => {

  socket.on('host:join', ({ code }) => {
    const session = sessions.get(code);
    if (!session) { socket.emit('error', 'Session not found'); return; }
    session.hostSocketId = socket.id;
    socket.join(`session:${code}`);
    socket.emit('host:ready', { code });
    if (session.clientSocketId) socket.emit('client:waiting', { code });
    if (session.agentSocketId) socket.emit('agent:ready', { code });
  });

  socket.on('client:join', ({ code }) => {
    const session = sessions.get(code);
    if (!session) { socket.emit('error', 'Session not found or expired'); return; }
    session.clientSocketId = socket.id;
    socket.join(`session:${code}`);
    if (session.hostSocketId) io.to(session.hostSocketId).emit('client:joined', { code });
    socket.emit('client:ready', { code, hostName: session.hostName });
  });

  // Agent (desktop agent on customer machine)
  socket.on('agent:join', ({ code }) => {
    const session = sessions.get(code);
    if (!session) { socket.emit('error', 'Session not found'); return; }
    session.agentSocketId = socket.id;
    socket.join(`session:${code}`);
    if (session.hostSocketId) io.to(session.hostSocketId).emit('agent:ready', { code });
    socket.emit('agent:connected', { code });
    console.log(`Agent joined session ${code}`);
    // Request immediate screenshot
    socket.emit('control', { type: 'screenshot' });
  });

  // Agent reports screen info
  socket.on('agent:info', ({ code, screenW, screenH }) => {
    const session = sessions.get(code)
    if (session) { session.screenW = screenW; session.screenH = screenH }
  })

  // Agent sends screenshot — store it + forward to host
  socket.on('agent:screenshot', ({ code, data }) => {
    screenshots.set(code, data);
    const session = sessions.get(code);
    if (session?.hostSocketId) io.to(session.hostSocketId).emit('screenshot', { data });
  });

  // Agent sends shell command result
  socket.on('shell:result', ({ requestId, output, error, exitCode }) => {
    // Find session with this pending request
    for (const [code, session] of sessions.entries()) {
      if (session.pendingShell && session.pendingShell[requestId]) {
        session.pendingShell[requestId]({ output, error, exitCode });
        delete session.pendingShell[requestId];
        break;
      }
    }
  });

  // Host → agent control relay
  socket.on('agent:control', ({ code, command }) => {
    const session = sessions.get(code);
    if (!session?.agentSocketId) return;
    io.to(session.agentSocketId).emit('control', command);
  });

  // WebRTC signaling
  socket.on('webrtc:offer', ({ code, offer }) => {
    const session = sessions.get(code);
    if (session?.clientSocketId) io.to(session.clientSocketId).emit('webrtc:offer', { offer });
  });
  socket.on('webrtc:answer', ({ code, answer }) => {
    const session = sessions.get(code);
    if (session?.hostSocketId) io.to(session.hostSocketId).emit('webrtc:answer', { answer });
  });
  socket.on('webrtc:ice', ({ code, candidate, from }) => {
    const session = sessions.get(code);
    if (!session) return;
    const targetId = from === 'host' ? session.clientSocketId : session.hostSocketId;
    if (targetId) io.to(targetId).emit('webrtc:ice', { candidate });
  });

  socket.on('session:end', ({ code }) => {
    const session = sessions.get(code);
    if (session) {
      io.to(`session:${code}`).emit('session:ended');
      sessions.delete(code);
      screenshots.delete(code);
    }
  });

  socket.on('disconnect', () => {
    for (const [code, session] of sessions.entries()) {
      if (session.agentSocketId === socket.id) {
        session.agentSocketId = null;
        if (session.hostSocketId) io.to(session.hostSocketId).emit('agent:disconnected');
      } else if (session.hostSocketId === socket.id || session.clientSocketId === socket.id) {
        io.to(`session:${code}`).emit('peer:disconnected');
      }
    }
  });
});

const PORT = process.env.PORT || 3002;
server.listen(PORT, () => console.log(`WastedApe Remote API on port ${PORT}`));
