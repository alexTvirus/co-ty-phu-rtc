/**
 * Google Apps Script - HTTP WebRTC Signaling Server (thay thế worker-rtc-signal.js)
 *
 * Mục đích giống hệt worker-rtc-signal.js: chỉ trao đổi SDP offer/answer giữa Guest và Host.
 * Dữ liệu game đi thẳng qua WebRTC DataChannel, KHÔNG qua script này.
 *
 * ===== CÁCH TRIỂN KHAI =====
 * 1. Vào https://script.google.com -> "Dự án mới" -> dán toàn bộ file này vào Code.gs
 * 2. Nhấn "Triển khai" (Deploy) -> "Tùy chọn triển khai mới" -> loại "Ứng dụng web" (Web app)
 *      - Thực thi dưới dạng (Execute as): Tôi (Me)
 *      - Ai có quyền truy cập (Who has access): Bất kỳ ai (Anyone)   <-- bắt buộc, KHÔNG phải "Anyone with Google account"
 * 3. Cấp quyền khi được hỏi, rồi copy URL dạng  https://script.google.com/macros/s/AKfy.../exec
 * 4. Dán URL đó vào ô "URL Server RTC-Signal" trong Lobby (hoặc build với VITE_SIGNAL_URL).
 * 5. Mỗi lần sửa code phải "Quản lý bản triển khai" -> chỉnh sửa -> "Phiên bản mới", nếu không URL /exec vẫn chạy code cũ.
 *
 * ===== KHÁC BIỆT SO VỚI CLOUDFLARE WORKER =====
 * - Apps Script không đọc được đường dẫn con, header, hay phương thức DELETE/OPTIONS.
 *   => Định tuyến bằng tham số ?route=..., xóa dữ liệu dùng POST (route=delete-offer / delete-room).
 * - Không đặt được mã trạng thái HTTP: mọi phản hồi là 200, lỗi nằm trong JSON { ok:false, error }.
 * - Không có preflight CORS => client PHẢI gửi POST với Content-Type: text/plain (đã xử lý trong rtcManager.ts).
 * - Dữ liệu lưu trong CacheService (bộ nhớ tạm dùng chung cho mọi lần gọi script, KHÔNG phụ thuộc isolate/datacenter),
 *   nên khắc phục được lỗi "mỗi isolate một bộ nhớ" của Worker. Lưu ý: Google có thể xóa cache sớm hơn TTL (không bảo đảm).
 * - Dùng LockService để ghi tuần tự, tránh hai request ghi đè nhau.
 * - Không lấy được IP người gọi nên không rate limit theo IP; thay vào đó giới hạn dung lượng/số lượng cho mỗi phòng.
 */

// ---------- Cấu hình ----------
var SIGNAL_TTL_SECONDS = 90;          // Offer/answer sống 90s (CacheService cho phép tối đa 21600s)
var SIGNAL_TTL_MS = SIGNAL_TTL_SECONDS * 1000;
var MAX_OFFERS_PER_ROOM = 12;
var MAX_ANSWERS_PER_ROOM = 12;
var MAX_SDP_LENGTH = 16000;
var MAX_BODY_LENGTH = 64000;
// CacheService giới hạn 100KB / key. Chừa dư địa an toàn.
var MAX_ROOM_JSON_LENGTH = 90000;
var LOCK_WAIT_MS = 8000;

var ROOM_ID_RE = /^[\p{L}\p{N}_-]{1,32}$/u; // 1-32 ký tự: chữ, số (kể cả tiếng Việt), _ và -
var PEER_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

// ---------- Điểm vào ----------
function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    var route = String(p.route || 'health');

    if (route === 'health') {
      return json_({ ok: true, service: 'monopoly-rtc-signal', storage: 'apps-script-cache' });
    }
    if (route === 'offers') return getOffers_(p);
    if (route === 'answer') return getAnswer_(p);
    return json_({ ok: false, error: 'Not Found' });
  } catch (err) {
    return json_({ ok: false, error: 'Internal error: ' + err });
  }
}

function doPost(e) {
  try {
    var p = (e && e.parameter) || {};
    var raw = e && e.postData && e.postData.contents ? String(e.postData.contents) : '';
    if (raw.length > MAX_BODY_LENGTH) {
      return json_({ ok: false, error: 'Payload too large' });
    }
    var body = {};
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch (parseErr) {
        return json_({ ok: false, error: 'Invalid JSON body' });
      }
    }
    if (!body || typeof body !== 'object') body = {};

    var route = String(p.route || body.route || '');
    if (route === 'offer') return postOffer_(body);
    if (route === 'answer') return postAnswer_(body);
    if (route === 'delete-offer') return deleteOffer_(body, p);
    if (route === 'delete-room') return deleteRoom_(body, p);
    return json_({ ok: false, error: 'Not Found' });
  } catch (err) {
    return json_({ ok: false, error: 'Internal error: ' + err });
  }
}

// ---------- Các route ----------

// 1. Guest gửi SDP Offer lên cho Host
function postOffer_(body) {
  var roomId = normalizeRoomId_(body.roomId);
  var peerId = normalizePeerId_(body.peerId);
  var offer = parseSdp_(body.offer, 'offer');
  if (!roomId || !peerId || !offer) {
    return json_({ ok: false, error: 'Invalid roomId, peerId, or offer' });
  }

  return withLock_(function () {
    var room = loadRoom_(roomId);
    if (!room.offers[peerId] && countKeys_(room.offers) >= MAX_OFFERS_PER_ROOM) {
      return json_({ ok: false, error: 'Too many pending offers for this room' });
    }
    room.offers[peerId] = { offer: offer, createdAt: Date.now() };
    if (!saveRoom_(roomId, room)) {
      delete room.offers[peerId];
      return json_({ ok: false, error: 'Room data too large' });
    }
    return json_({ ok: true });
  });
}

// 2. Host lấy danh sách Offer đang chờ theo roomId (chỉ đọc, không cần khóa)
function getOffers_(p) {
  var roomId = normalizeRoomId_(p.roomId);
  if (!roomId) return json_({ offers: [] });

  var room = loadRoom_(roomId);
  var result = [];
  for (var peerId in room.offers) {
    result.push({ peerId: peerId, offer: room.offers[peerId].offer });
  }
  return json_({ offers: result });
}

// 3. Host gửi SDP Answer trả về cho Guest
//    - Chỉ nhận answer cho offer đang chờ
//    - Answer đầu tiên thắng, answer sau bị từ chối
function postAnswer_(body) {
  var roomId = normalizeRoomId_(body.roomId);
  var peerId = normalizePeerId_(body.peerId);
  var answer = parseSdp_(body.answer, 'answer');
  if (!roomId || !peerId || !answer) {
    return json_({ ok: false, error: 'Invalid roomId, peerId, or answer' });
  }

  return withLock_(function () {
    var room = loadRoom_(roomId);
    if (!room.offers[peerId]) {
      return json_({ ok: false, error: 'No pending offer for this peer (expired or already answered)' });
    }
    if (countKeys_(room.answers) >= MAX_ANSWERS_PER_ROOM) {
      return json_({ ok: false, error: 'Too many pending answers for this room' });
    }
    var removedOffer = room.offers[peerId];
    delete room.offers[peerId];
    room.answers[peerId] = { answer: answer, createdAt: Date.now() };
    if (!saveRoom_(roomId, room)) {
      delete room.answers[peerId];
      room.offers[peerId] = removedOffer;
      return json_({ ok: false, error: 'Room data too large' });
    }
    return json_({ ok: true });
  });
}

// 4. Guest lấy SDP Answer từ Host (không xóa khi đọc, tự hết hạn theo TTL)
function getAnswer_(p) {
  var roomId = normalizeRoomId_(p.roomId);
  var peerId = normalizePeerId_(p.peerId);
  if (!roomId || !peerId) return json_({ answer: null });

  var room = loadRoom_(roomId);
  var entry = room.answers[peerId];
  return json_({ answer: entry ? entry.answer : null });
}

// 5a. Guest rời đi: xóa offer/answer của mình
function deleteOffer_(body, p) {
  var roomId = normalizeRoomId_(body.roomId || p.roomId);
  var peerId = normalizePeerId_(body.peerId || p.peerId);
  if (!roomId || !peerId) return json_({ ok: true });

  return withLock_(function () {
    var room = loadRoom_(roomId);
    delete room.offers[peerId];
    delete room.answers[peerId];
    saveRoom_(roomId, room);
    return json_({ ok: true });
  });
}

// 5b. Dọn dẹp phòng khi Host đóng phòng
function deleteRoom_(body, p) {
  var roomId = normalizeRoomId_(body.roomId || p.roomId);
  if (!roomId) return json_({ ok: true });

  return withLock_(function () {
    CacheService.getScriptCache().remove(roomKey_(roomId));
    return json_({ ok: true });
  });
}

// ---------- Lưu trữ: mỗi phòng 1 key trong CacheService ----------
// Cấu trúc: { offers: { [peerId]: {offer, createdAt} }, answers: { [peerId]: {answer, createdAt} } }

function roomKey_(roomId) {
  return 'room:' + roomId;
}

function loadRoom_(roomId) {
  var room = { offers: {}, answers: {} };
  var raw = CacheService.getScriptCache().get(roomKey_(roomId));
  if (raw) {
    try {
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        room.offers = parsed.offers || {};
        room.answers = parsed.answers || {};
      }
    } catch (err) {
      // dữ liệu hỏng -> coi như phòng trống
    }
  }
  // Loại bỏ mục đã quá hạn (TTL của key chỉ được làm mới khi ghi, nên phải tự lọc theo createdAt)
  var now = Date.now();
  var id;
  for (id in room.offers) {
    if (now - room.offers[id].createdAt > SIGNAL_TTL_MS) delete room.offers[id];
  }
  for (id in room.answers) {
    if (now - room.answers[id].createdAt > SIGNAL_TTL_MS) delete room.answers[id];
  }
  return room;
}

// Trả về false nếu dữ liệu quá lớn
function saveRoom_(roomId, room) {
  var cache = CacheService.getScriptCache();
  if (countKeys_(room.offers) === 0 && countKeys_(room.answers) === 0) {
    cache.remove(roomKey_(roomId));
    return true;
  }
  var raw = JSON.stringify(room);
  if (raw.length > MAX_ROOM_JSON_LENGTH) return false;
  cache.put(roomKey_(roomId), raw, SIGNAL_TTL_SECONDS);
  return true;
}

// ---------- Tiện ích ----------
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(LOCK_WAIT_MS);
  } catch (err) {
    return json_({ ok: false, error: 'Server is busy, try again' });
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function countKeys_(obj) {
  var n = 0;
  for (var k in obj) n++;
  return n;
}

function normalizeRoomId_(value) {
  if (typeof value !== 'string') return null;
  var id = value.trim().toUpperCase();
  return ROOM_ID_RE.test(id) ? id : null;
}

function normalizePeerId_(value) {
  if (typeof value !== 'string') return null;
  return PEER_ID_RE.test(value) ? value : null;
}

function parseSdp_(value, expectedType) {
  if (!value || typeof value !== 'object') return null;
  if (value.type !== expectedType) return null;
  var sdp = value.sdp;
  if (typeof sdp !== 'string' || sdp.length === 0 || sdp.length > MAX_SDP_LENGTH) return null;
  if (sdp.indexOf('v=0') !== 0) return null;
  return { type: expectedType, sdp: sdp };
}