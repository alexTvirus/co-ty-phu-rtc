import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '256kb' }));

// Lightweight ephemeral HTTP signaling store for WebRTC SDP handshake (no WebSockets, no game state)
interface PendingOffer {
  peerId: string;
  offer: unknown;
  createdAt: number;
}

interface PendingAnswer {
  answer: unknown;
  createdAt: number;
}

const SIGNAL_TTL_MS = 60_000;
const roomOffers = new Map<string, Map<string, PendingOffer>>();
const roomAnswers = new Map<string, Map<string, PendingAnswer>>();

function pruneExpiredSignals() {
  const now = Date.now();
  for (const [roomId, offers] of roomOffers.entries()) {
    for (const [peerId, entry] of offers.entries()) {
      if (now - entry.createdAt > SIGNAL_TTL_MS) {
        offers.delete(peerId);
      }
    }
    if (offers.size === 0) roomOffers.delete(roomId);
  }
  for (const [roomId, answers] of roomAnswers.entries()) {
    for (const [peerId, entry] of answers.entries()) {
      if (now - entry.createdAt > SIGNAL_TTL_MS) {
        answers.delete(peerId);
      }
    }
    if (answers.size === 0) roomAnswers.delete(roomId);
  }
}

app.post('/api/rtc-signal/offer', (req, res) => {
  pruneExpiredSignals();
  const { roomId, peerId, offer } = req.body || {};
  if (!roomId || !peerId || !offer) {
    res.status(400).json({ error: 'Missing roomId, peerId, or offer' });
    return;
  }
  const normalizedRoomId = String(roomId).trim().toUpperCase();
  let offers = roomOffers.get(normalizedRoomId);
  if (!offers) {
    offers = new Map();
    roomOffers.set(normalizedRoomId, offers);
  }
  offers.set(String(peerId), { peerId: String(peerId), offer, createdAt: Date.now() });
  res.json({ ok: true });
});

app.get('/api/rtc-signal/offers', (req, res) => {
  pruneExpiredSignals();
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.type('application/json');
  const roomId = String(req.query.roomId || '').trim().toUpperCase();
  if (!roomId) {
    res.send(JSON.stringify({ offers: [] }));
    return;
  }
  const offers = roomOffers.get(roomId);
  res.send(
    JSON.stringify({
      offers: offers
        ? Array.from(offers.values()).map(({ peerId, offer }) => ({ peerId, offer }))
        : [],
    })
  );
});

app.post('/api/rtc-signal/answer', (req, res) => {
  pruneExpiredSignals();
  const { roomId, peerId, answer } = req.body || {};
  if (!roomId || !peerId || !answer) {
    res.status(400).json({ error: 'Missing roomId, peerId, or answer' });
    return;
  }
  const normalizedRoomId = String(roomId).trim().toUpperCase();
  const normalizedPeerId = String(peerId);

  roomOffers.get(normalizedRoomId)?.delete(normalizedPeerId);

  let answers = roomAnswers.get(normalizedRoomId);
  if (!answers) {
    answers = new Map();
    roomAnswers.set(normalizedRoomId, answers);
  }
  answers.set(normalizedPeerId, { answer, createdAt: Date.now() });
  res.json({ ok: true });
});

app.get('/api/rtc-signal/answer', (req, res) => {
  pruneExpiredSignals();
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.type('application/json');
  const roomId = String(req.query.roomId || '').trim().toUpperCase();
  const peerId = String(req.query.peerId || '');
  if (!roomId || !peerId) {
    res.send(JSON.stringify({ answer: null }));
    return;
  }
  const entry = roomAnswers.get(roomId)?.get(peerId);
  if (entry) {
    roomAnswers.get(roomId)?.delete(peerId);
    res.send(JSON.stringify({ answer: entry.answer }));
    return;
  }
  res.send(JSON.stringify({ answer: null }));
});

app.delete('/api/rtc-signal/room', (req, res) => {
  const roomId = String(req.query.roomId || '').trim().toUpperCase();
  if (roomId) {
    roomOffers.delete(roomId);
    roomAnswers.delete(roomId);
  }
  res.json({ ok: true });
});

// Vite middlewares integration
async function setupVite() {
  const isProduction = process.env.NODE_ENV === 'production';

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }
}

setupVite().then(() => {
  const PORT = 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Monopoly Vietnam app server running on http://0.0.0.0:${PORT} (WebRTC P2P mode)`);
  });
});
