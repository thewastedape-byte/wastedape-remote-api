const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const Stripe = require('stripe');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json());

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_placeholder', { apiVersion: '2024-04-10' });

// Active sessions: code -> { hostSocketId, clientSocketId, paid, createdAt, hostName }
const sessions = new Map();

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function cleanOldSessions() {
  const now = Date.now();
  for (const [code, session] of sessions.entries()) {
    if (now - session.createdAt > 30 * 60 * 1000) { // 30 min expiry
      sessions.delete(code);
    }
  }
}
setInterval(cleanOldSessions, 5 * 60 * 1000);

// REST endpoints
app.get('/status', (req, res) => {
  res.json({ status: 'online', activeSessions: sessions.size, app: 'WastedApe Remote Access' });
});

// Create a session (host calls this)
app.post('/api/session/create', (req, res) => {
  const { hostName, sessionType } = req.body;
  const code = generateCode();
  sessions.set(code, {
    code, hostName: hostName || 'WastedApe Tech',
    sessionType: sessionType || 'support',
    hostSocketId: null, clientSocketId: null,
    paid: sessionType === 'free' || false,
    createdAt: Date.now(), connected: false
  });
  res.json({ code, expiresIn: '30 minutes' });
});

// Validate a session code (client calls this)
app.get('/api/session/:code', (req, res) => {
  const session = sessions.get(req.params.code);
  if (!session) return res.status(404).json({ error: 'Session not found or expired' });
  res.json({ valid: true, hostName: session.hostName, sessionType: session.sessionType, paid: session.paid });
});

// Stripe checkout for paid sessions
app.post('/api/session/checkout', async (req, res) => {
  const { code, service } = req.body;
  const session = sessions.get(code);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const PRICES = {
    basic: 'price_1TUnQTHfCuVeN1IriDWY13yV', // $299 basic setup
    pro: 'price_1TUnQUHfCuVeN1Ir1OtyiZdS',   // $499 pro setup
  };

  try {
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{ price: PRICES[service] || PRICES.basic, quantity: 1 }],
      metadata: { sessionCode: code },
      success_url: `${process.env.APP_URL || 'https://www.wastedape.org'}/remote/connect?code=${code}&paid=true`,
      cancel_url: `${process.env.APP_URL || 'https://www.wastedape.org'}/remote`,
    });
    res.json({ url: checkoutSession.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark session as paid (webhook or redirect)
app.post('/api/session/:code/mark-paid', (req, res) => {
  const session = sessions.get(req.params.code);
  if (!session) return res.status(404).json({ error: 'Not found' });
  session.paid = true;
  res.json({ success: true });
});

// WebRTC signaling via Socket.io
io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  // Host joins their session
  socket.on('host:join', ({ code }) => {
    const session = sessions.get(code);
    if (!session) { socket.emit('error', 'Session not found'); return; }
    session.hostSocketId = socket.id;
    socket.join(`session:${code}`);
    socket.emit('host:ready', { code });
    // If client already waiting, notify host
    if (session.clientSocketId) {
      socket.emit('client:waiting', { code });
    }
    console.log(`Host joined session ${code}`);
  });

  // Client joins with a code
  socket.on('client:join', ({ code }) => {
    const session = sessions.get(code);
    if (!session) { socket.emit('error', 'Session not found or expired'); return; }
    if (!session.paid) { socket.emit('error', 'Payment required'); return; }
    session.clientSocketId = socket.id;
    socket.join(`session:${code}`);
    // Notify host that client is ready
    if (session.hostSocketId) {
      io.to(session.hostSocketId).emit('client:joined', { code });
    }
    socket.emit('client:ready', { code, hostName: session.hostName });
    console.log(`Client joined session ${code}`);
  });

  // WebRTC offer from host to client
  socket.on('webrtc:offer', ({ code, offer }) => {
    const session = sessions.get(code);
    if (!session || !session.clientSocketId) return;
    io.to(session.clientSocketId).emit('webrtc:offer', { offer });
  });

  // WebRTC answer from client to host
  socket.on('webrtc:answer', ({ code, answer }) => {
    const session = sessions.get(code);
    if (!session || !session.hostSocketId) return;
    io.to(session.hostSocketId).emit('webrtc:answer', { answer });
  });

  // ICE candidates
  socket.on('webrtc:ice', ({ code, candidate, from }) => {
    const session = sessions.get(code);
    if (!session) return;
    const targetId = from === 'host' ? session.clientSocketId : session.hostSocketId;
    if (targetId) io.to(targetId).emit('webrtc:ice', { candidate });
  });

  // Agent joins (Python client)
  socket.on('agent:join', ({ code }) => {
    const session = sessions.get(code)
    if (!session) { socket.emit('error', 'Session not found'); return }
    session.agentSocketId = socket.id
    socket.join(`session:${code}`)
    // Notify host that agent is ready
    if (session.hostSocketId) {
      io.to(session.hostSocketId).emit('agent:ready', { code })
    }
    socket.emit('agent:connected', { code, hostName: session.hostName })
    console.log(`Agent joined session ${code}`)
  })

  // Host sends control command to agent
  socket.on('agent:control', ({ code, command }) => {
    const session = sessions.get(code)
    if (!session || !session.agentSocketId) return
    io.to(session.agentSocketId).emit('control', command)
  })

  // Agent sends screenshot back to host
  socket.on('agent:screenshot', ({ code, data }) => {
    const session = sessions.get(code)
    if (!session || !session.hostSocketId) return
    io.to(session.hostSocketId).emit('screenshot', { data })
  })

  // Session end
  socket.on('session:end', ({ code }) => {
    const session = sessions.get(code);
    if (session) {
      io.to(`session:${code}`).emit('session:ended');
      sessions.delete(code);
    }
  });

  // Disconnect cleanup
  socket.on('disconnect', () => {
    for (const [code, session] of sessions.entries()) {
      if (session.hostSocketId === socket.id || session.clientSocketId === socket.id) {
        io.to(`session:${code}`).emit('peer:disconnected');
      }
    }
  });
});

const PORT = process.env.PORT || 3002;
server.listen(PORT, () => console.log(`WastedApe Remote API running on port ${PORT}`));
