/**
 * Cloudflare Worker - Stateless HTTP WebRTC Signaling Server
 * Triển khai bằng cách dán trực tiếp vào Cloudflare Workers Dashboard
 * hoặc chạy lệnh: npx wrangler deploy worker-rtc-signal.js
 *
 * (Tùy chọn) Nếu muốn đồng bộ tín hiệu toàn cầu giữa nhiều datacenter Cloudflare,
 * có thể bind thêm 1 KV Namespace tên là RTC_KV vào Worker.
 * Nếu không bind KV, Worker tự động dùng bộ nhớ tạm (in-memory) với TTL 60 giây.
 */

const SIGNAL_TTL_MS = 60_000;
const SIGNAL_TTL_SECONDS = 60;

const roomOffers = new Map();
const roomAnswers = new Map();

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
    },
  });
}

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

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    pruneExpiredSignals();

    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const kv = env && env.RTC_KV ? env.RTC_KV : null;

    if (request.method === 'GET' && (pathname === '/' || pathname === '/health' || pathname === '/api/rtc-signal')) {
      return jsonResponse({
        ok: true,
        service: 'monopoly-rtc-signal',
        storage: kv ? 'kv+memory' : 'memory',
      });
    }

    // 1. Guest gửi SDP Offer lên cho Host
    if (request.method === 'POST' && pathname === '/api/rtc-signal/offer') {
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
      }

      const { roomId, peerId, offer } = body || {};
      if (!roomId || !peerId || !offer) {
        return jsonResponse({ error: 'Missing roomId, peerId, or offer' }, 400);
      }

      const normalizedRoomId = String(roomId).trim().toUpperCase();
      const normalizedPeerId = String(peerId);

      let offers = roomOffers.get(normalizedRoomId);
      if (!offers) {
        offers = new Map();
        roomOffers.set(normalizedRoomId, offers);
      }
      offers.set(normalizedPeerId, {
        peerId: normalizedPeerId,
        offer,
        createdAt: Date.now(),
      });

      if (kv) {
        await kv.put(
          `offer:${normalizedRoomId}:${normalizedPeerId}`,
          JSON.stringify({ peerId: normalizedPeerId, offer }),
          { expirationTtl: SIGNAL_TTL_SECONDS }
        );
      }

      return jsonResponse({ ok: true });
    }

    // 2. Host lấy danh sách Offer đang chờ theo roomId
    if (request.method === 'GET' && pathname === '/api/rtc-signal/offers') {
      const roomId = String(url.searchParams.get('roomId') || '').trim().toUpperCase();
      if (!roomId) {
        return jsonResponse({ offers: [] });
      }

      const merged = new Map();
      const memOffers = roomOffers.get(roomId);
      if (memOffers) {
        for (const [peerId, entry] of memOffers.entries()) {
          merged.set(peerId, { peerId: entry.peerId, offer: entry.offer });
        }
      }

      if (kv) {
        const list = await kv.list({ prefix: `offer:${roomId}:` });
        for (const key of list.keys) {
          const val = await kv.get(key.name, 'json');
          if (val && val.peerId && val.offer) {
            merged.set(val.peerId, { peerId: val.peerId, offer: val.offer });
          }
        }
      }

      return jsonResponse({ offers: Array.from(merged.values()) });
    }

    // 3. Host gửi SDP Answer trả về cho Guest
    if (request.method === 'POST' && pathname === '/api/rtc-signal/answer') {
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
      }

      const { roomId, peerId, answer } = body || {};
      if (!roomId || !peerId || !answer) {
        return jsonResponse({ error: 'Missing roomId, peerId, or answer' }, 400);
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

      if (kv) {
        await kv.delete(`offer:${normalizedRoomId}:${normalizedPeerId}`);
        await kv.put(
          `answer:${normalizedRoomId}:${normalizedPeerId}`,
          JSON.stringify(answer),
          { expirationTtl: SIGNAL_TTL_SECONDS }
        );
      }

      return jsonResponse({ ok: true });
    }

    // 4. Guest lấy SDP Answer từ Host
    if (request.method === 'GET' && pathname === '/api/rtc-signal/answer') {
      const roomId = String(url.searchParams.get('roomId') || '').trim().toUpperCase();
      const peerId = String(url.searchParams.get('peerId') || '');
      if (!roomId || !peerId) {
        return jsonResponse({ answer: null });
      }

      const entry = roomAnswers.get(roomId)?.get(peerId);
      if (entry) {
        roomAnswers.get(roomId)?.delete(peerId);
        if (kv) {
          ctx.waitUntil(kv.delete(`answer:${roomId}:${peerId}`));
        }
        return jsonResponse({ answer: entry.answer });
      }

      if (kv) {
        const kvAnswer = await kv.get(`answer:${roomId}:${peerId}`, 'json');
        if (kvAnswer) {
          ctx.waitUntil(kv.delete(`answer:${roomId}:${peerId}`));
          return jsonResponse({ answer: kvAnswer });
        }
      }

      return jsonResponse({ answer: null });
    }

    // 5. Dọn dẹp phòng khi Host đóng phòng
    if (request.method === 'DELETE' && pathname === '/api/rtc-signal/room') {
      const roomId = String(url.searchParams.get('roomId') || '').trim().toUpperCase();
      if (roomId) {
        roomOffers.delete(roomId);
        roomAnswers.delete(roomId);
        if (kv) {
          const offerKeys = await kv.list({ prefix: `offer:${roomId}:` });
          const answerKeys = await kv.list({ prefix: `answer:${roomId}:` });
          ctx.waitUntil(
            Promise.all([
              ...offerKeys.keys.map((k) => kv.delete(k.name)),
              ...answerKeys.keys.map((k) => kv.delete(k.name)),
            ])
          );
        }
      }
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ error: 'Not Found' }, 404);
  },
};
