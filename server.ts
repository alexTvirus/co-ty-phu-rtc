import express, { type NextFunction, type Request, type Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Máy chủ signaling WebRTC tối giản (chỉ trao đổi SDP offer/answer, không giữ trạng thái game).
 *
 * Biến môi trường (tùy chọn):
 *   PORT             Cổng lắng nghe (mặc định 3000)
 *   TRUST_PROXY      Số lớp reverse proxy tin cậy để lấy IP thật cho rate limit (vd: "1")
 *   ALLOWED_ORIGINS  Danh sách origin được phép gọi API, cách nhau bằng dấu phẩy (mặc định "*")
 *                    Cần khi trang static host ở domain khác với server này.
 */

// ---------- Cấu hình & giới hạn ----------
const SIGNAL_TTL_MS = 60_000;
const MAX_ROOMS = 2_000;
const MAX_OFFERS_PER_ROOM = 16;
const MAX_ANSWERS_PER_ROOM = 16;
const MAX_SDP_LENGTH = 16_000;
const BODY_LIMIT = '64kb';

const ROOM_ID_RE = /^[\p{L}\p{N}_-]{1,32}$/u;
const PEER_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

// Rate limit theo IP (cửa sổ 60 giây). Nhiều người chơi chung 1 NAT nên để GET khá rộng.
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_READ = 600; // GET /offers, GET /answer (poll ~1 req/giây/người)
const RATE_LIMIT_WRITE = 60; // POST offer/answer, DELETE

const PORT = Number(process.env.PORT) || 3000;

// ---------- Kho dữ liệu tạm trong bộ nhớ ----------
interface PendingOffer {
  peerId: string;
  offer: RTCSessionDescriptionInitLike;
  createdAt: number;
}

interface PendingAnswer {
  answer: RTCSessionDescriptionInitLike;
  createdAt: number;
}

interface RTCSessionDescriptionInitLike {
  type: 'offer' | 'answer';
  sdp: string;
}

const roomOffers = new Map<string, Map<string, PendingOffer>>();
const roomAnswers = new Map<string, Map<string, PendingAnswer>>();

function pruneExpiredSignals() {
  const now = Date.now();
  for (const [roomId, offers] of roomOffers.entries()) {
    for (const [peerId, entry] of offers.entries()) {
      if (now - entry.createdAt > SIGNAL_TTL_MS) offers.delete(peerId);
    }
    if (offers.size === 0) roomOffers.delete(roomId);
  }
  for (const [roomId, answers] of roomAnswers.entries()) {
    for (const [peerId, entry] of answers.entries()) {
      if (now - entry.createdAt > SIGNAL_TTL_MS) answers.delete(peerId);
    }
    if (answers.size === 0) roomAnswers.delete(roomId);
  }
}

// ---------- Rate limit ----------
const rateBuckets = new Map<string, { windowStart: number; count: number }>();

function pruneRateBuckets() {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets.entries()) {
    if (now - bucket.windowStart > RATE_WINDOW_MS) rateBuckets.delete(key);
  }
}

function rateLimit(kind: 'read' | 'write', limit: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${kind}:${req.ip || 'unknown'}`;
    const now = Date.now();
    let bucket = rateBuckets.get(key);
    if (!bucket || now - bucket.windowStart > RATE_WINDOW_MS) {
      bucket = { windowStart: now, count: 0 };
      rateBuckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > limit) {
      const retryAfter = Math.max(1, Math.ceil((bucket.windowStart + RATE_WINDOW_MS - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: 'Too many requests' });
      return;
    }
    next();
  };
}

// ---------- Validate ----------
function normalizeRoomId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim().toUpperCase();
  return ROOM_ID_RE.test(id) ? id : null;
}

function normalizePeerId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return PEER_ID_RE.test(value) ? value : null;
}

function parseSdp(
  value: unknown,
  expectedType: 'offer' | 'answer'
): RTCSessionDescriptionInitLike | null {
  if (!value || typeof value !== 'object') return null;
  const { type, sdp } = value as { type?: unknown; sdp?: unknown };
  if (type !== expectedType) return null;
  if (typeof sdp !== 'string' || sdp.length === 0 || sdp.length > MAX_SDP_LENGTH) return null;
  if (!sdp.startsWith('v=0')) return null;
  // Chỉ giữ đúng 2 trường, loại bỏ mọi field lạ do client gửi lên
  return { type: expectedType, sdp };
}

// ---------- App ----------
const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) {
  const n = Number(process.env.TRUST_PROXY);
  app.set('trust proxy', Number.isNaN(n) ? process.env.TRUST_PROXY : n);
}

// CORS cho các endpoint signaling (cho phép trang static ở domain khác gọi tới)
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use('/api/rtc-signal', (req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

app.use('/api/rtc-signal', express.json({ limit: BODY_LIMIT }));

app.get(['/api/rtc-signal', '/api/rtc-signal/health'], (_req, res) => {
  res.json({ ok: true, service: 'monopoly-rtc-signal', storage: 'memory' });
});

// 1. Guest gửi SDP Offer lên cho Host
app.post('/api/rtc-signal/offer', rateLimit('write', RATE_LIMIT_WRITE), (req, res) => {
  const body = (req.body || {}) as Record<string, unknown>;
  const roomId = normalizeRoomId(body.roomId);
  const peerId = normalizePeerId(body.peerId);
  const offer = parseSdp(body.offer, 'offer');
  if (!roomId || !peerId || !offer) {
    res.status(400).json({ error: 'Invalid roomId, peerId, or offer' });
    return;
  }

  pruneExpiredSignals();
  let offers = roomOffers.get(roomId);
  if (!offers) {
    if (roomOffers.size >= MAX_ROOMS) {
      res.status(503).json({ error: 'Server is busy, try again later' });
      return;
    }
    offers = new Map();
    roomOffers.set(roomId, offers);
  }
  if (!offers.has(peerId) && offers.size >= MAX_OFFERS_PER_ROOM) {
    res.status(429).json({ error: 'Too many pending offers for this room' });
    return;
  }
  offers.set(peerId, { peerId, offer, createdAt: Date.now() });
  res.json({ ok: true });
});

// 2. Host lấy danh sách Offer đang chờ theo roomId
app.get('/api/rtc-signal/offers', rateLimit('read', RATE_LIMIT_READ), (req, res) => {
  const roomId = normalizeRoomId(req.query.roomId);
  if (!roomId) {
    res.json({ offers: [] });
    return;
  }
  pruneExpiredSignals();
  const offers = roomOffers.get(roomId);
  res.json({
    offers: offers ? Array.from(offers.values()).map(({ peerId, offer }) => ({ peerId, offer })) : [],
  });
});

// 3. Host gửi SDP Answer trả về cho Guest
//    - Chỉ nhận answer cho offer đang chờ (không thể "bơm" answer cho peerId tùy ý)
//    - Answer đầu tiên thắng, các answer sau bị từ chối (tránh bị ghi đè)
app.post('/api/rtc-signal/answer', rateLimit('write', RATE_LIMIT_WRITE), (req, res) => {
  const body = (req.body || {}) as Record<string, unknown>;
  const roomId = normalizeRoomId(body.roomId);
  const peerId = normalizePeerId(body.peerId);
  const answer = parseSdp(body.answer, 'answer');
  if (!roomId || !peerId || !answer) {
    res.status(400).json({ error: 'Invalid roomId, peerId, or answer' });
    return;
  }

  pruneExpiredSignals();
  const offers = roomOffers.get(roomId);
  if (!offers || !offers.has(peerId)) {
    res.status(409).json({ error: 'No pending offer for this peer (expired or already answered)' });
    return;
  }

  let answers = roomAnswers.get(roomId);
  if (!answers) {
    answers = new Map();
    roomAnswers.set(roomId, answers);
  }
  if (answers.size >= MAX_ANSWERS_PER_ROOM) {
    res.status(429).json({ error: 'Too many pending answers for this room' });
    return;
  }

  offers.delete(peerId);
  if (offers.size === 0) roomOffers.delete(roomId);
  answers.set(peerId, { answer, createdAt: Date.now() });
  res.json({ ok: true });
});

// 4. Guest lấy SDP Answer từ Host.
//    Answer KHÔNG bị xóa khi đọc: nếu response bị mất giữa đường, guest vẫn lấy lại được ở lần poll sau.
//    Answer tự hết hạn theo TTL.
app.get('/api/rtc-signal/answer', rateLimit('read', RATE_LIMIT_READ), (req, res) => {
  const roomId = normalizeRoomId(req.query.roomId);
  const peerId = normalizePeerId(req.query.peerId);
  if (!roomId || !peerId) {
    res.json({ answer: null });
    return;
  }
  pruneExpiredSignals();
  const entry = roomAnswers.get(roomId)?.get(peerId);
  res.json({ answer: entry ? entry.answer : null });
});

// 5a. Guest rời đi: xóa offer của mình để host không xử lý offer đã chết
app.delete('/api/rtc-signal/offer', rateLimit('write', RATE_LIMIT_WRITE), (req, res) => {
  const roomId = normalizeRoomId(req.query.roomId);
  const peerId = normalizePeerId(req.query.peerId);
  if (roomId && peerId) {
    const offers = roomOffers.get(roomId);
    offers?.delete(peerId);
    if (offers && offers.size === 0) roomOffers.delete(roomId);
    const answers = roomAnswers.get(roomId);
    answers?.delete(peerId);
    if (answers && answers.size === 0) roomAnswers.delete(roomId);
  }
  res.json({ ok: true });
});

// 5b. Dọn dẹp phòng khi Host đóng phòng
app.delete('/api/rtc-signal/room', rateLimit('write', RATE_LIMIT_WRITE), (req, res) => {
  const roomId = normalizeRoomId(req.query.roomId);
  if (roomId) {
    roomOffers.delete(roomId);
    roomAnswers.delete(roomId);
  }
  res.json({ ok: true });
});

// Mọi đường dẫn /api/* không khớp -> JSON 404 (không rơi vào index.html của SPA)
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

// Lỗi (JSON sai cú pháp, body quá lớn...) -> luôn trả JSON
app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const status =
    typeof err === 'object' && err && 'status' in err && typeof (err as { status: unknown }).status === 'number'
      ? (err as { status: number }).status
      : 500;
  const message = status === 413 ? 'Payload too large' : status === 400 ? 'Invalid JSON body' : 'Internal error';
  res.status(status >= 400 && status < 600 ? status : 500).json({ error: message });
});

// Dọn định kỳ để bộ nhớ không phình ra khi không có request
const cleanupTimer = setInterval(() => {
  pruneExpiredSignals();
  pruneRateBuckets();
}, 15_000);
cleanupTimer.unref();

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
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Monopoly Vietnam app server running on http://0.0.0.0:${PORT} (WebRTC P2P mode)`);
  });

  const shutdown = (signal: string) => {
    console.log(`${signal} received, shutting down...`);
    clearInterval(cleanupTimer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
});
