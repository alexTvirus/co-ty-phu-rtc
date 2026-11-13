import { ClientAction, GameEndRule, ServerMessage } from '../types/monopoly';
import { HostGameEngine } from './hostGameEngine';

const SIGNAL_CHANNEL_NAME = 'monopoly_vietnam_rtc_signal_v1';

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],
};

interface SignalOfferPayload {
  kind: 'OFFER';
  roomId: string;
  peerId: string;
  offer: RTCSessionDescriptionInit;
}

interface SignalAnswerPayload {
  kind: 'ANSWER';
  roomId: string;
  peerId: string;
  answer: RTCSessionDescriptionInit;
}

type SignalBroadcastMsg = SignalOfferPayload | SignalAnswerPayload;

export function encodeSignal(data: SignalOfferPayload | SignalAnswerPayload): string {
  const json = JSON.stringify(data);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function decodeSignal<T>(code: string): T | null {
  try {
    const clean = code.trim();
    if (!clean) return null;
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const json = new TextDecoder().decode(bytes);
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

function waitForIceGathering(pc: RTCPeerConnection, timeoutMs = 1800): Promise<void> {
  if (pc.iceGatheringState === 'complete') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      pc.removeEventListener('icegatheringstatechange', onStateChange);
      pc.removeEventListener('icecandidate', onCandidate);
      clearTimeout(timer);
      resolve();
    };
    const onStateChange = () => {
      if (pc.iceGatheringState === 'complete') {
        finish();
      }
    };
    const onCandidate = (ev: RTCPeerConnectionIceEvent) => {
      if (!ev.candidate) {
        finish();
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    pc.addEventListener('icegatheringstatechange', onStateChange);
    pc.addEventListener('icecandidate', onCandidate);
  });
}

interface PeerRecord {
  peerId: string;
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  playerId: string | null;
}

function normalizeSignalBaseUrl(signalUrl?: string): string {
  const clean = (signalUrl || '').trim().replace(/\/+$/, '');
  if (!clean) return '/api/rtc-signal';
  if (clean.endsWith('/api/rtc-signal')) return clean;
  return `${clean}/api/rtc-signal`;
}

export class MonopolyHostRTC {
  public readonly engine: HostGameEngine;
  public readonly roomId: string;
  private readonly signalBaseUrl: string;
  private peers = new Map<string, PeerRecord>();
  private playerToPeer = new Map<string, string>();
  private processedOffers = new Set<string>();
  private bc: BroadcastChannel | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private onLocalMessage: (msg: ServerMessage) => void;
  private destroyed = false;

  constructor(
    config: {
      roomId?: string;
      name: string;
      avatarId: string;
      maxPlayers: number;
      mainTurnTimer: number;
      startingCash: number;
      endRule?: GameEndRule;
      signalUrl?: string;
    },
    onLocalMessage: (msg: ServerMessage) => void
  ) {
    this.onLocalMessage = onLocalMessage;
    this.signalBaseUrl = normalizeSignalBaseUrl(config.signalUrl);
    const normalizedRoomId = (config.roomId || `VN${Math.floor(1000 + Math.random() * 9000)}`)
      .trim()
      .toUpperCase();
    this.roomId = normalizedRoomId;

    this.engine = new HostGameEngine(
      { ...config, roomId: normalizedRoomId },
      {
        sendToPlayer: (playerId, msg) => this.sendToPlayer(playerId, msg),
        onKickPeer: (playerId) => this.disconnectPlayerPeer(playerId),
      }
    );

    this.engine.start();
    this.startSignalingListeners();
  }

  private startSignalingListeners() {
    if (typeof BroadcastChannel !== 'undefined') {
      this.bc = new BroadcastChannel(SIGNAL_CHANNEL_NAME);
      this.bc.onmessage = (ev: MessageEvent<SignalBroadcastMsg>) => {
        const data = ev.data;
        if (!data || data.kind !== 'OFFER' || data.roomId !== this.roomId) return;
        void this.handleIncomingOffer(data.peerId, data.offer, true);
      };
    }

    const shouldPollOffers = () => {
      if (this.destroyed) return false;
      const { status, players, maxPlayers } = this.engine.state;
      if (status === 'lobby') {
        return players.length < maxPlayers;
      }
      if (status === 'playing') {
        return players.some((p) => !p.isBot && p.isDisconnected && !p.isQuit);
      }
      return false;
    };

    // Poll lightweight stateless HTTP signaling endpoint only while waiting for players/reconnects
    const pollOffers = async () => {
      if (this.destroyed) return;
      if (this.engine.state.status === 'ended' && this.pollInterval) {
        clearInterval(this.pollInterval);
        this.pollInterval = null;
        return;
      }
      if (!shouldPollOffers()) return;
      try {
        const res = await fetch(
          `${this.signalBaseUrl}/offers?roomId=${encodeURIComponent(this.roomId)}`,
          { cache: 'no-store' }
        );
        const contentType = res.headers.get('content-type') || '';
        if (res.status === 404 || !contentType.includes('application/json')) {
          if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
          }
          return;
        }
        if (!res.ok) return;
        const data = (await res.json()) as {
          offers?: Array<{ peerId: string; offer: RTCSessionDescriptionInit }>;
        };
        if (Array.isArray(data.offers)) {
          for (const item of data.offers) {
            if (item.peerId && item.offer) {
              void this.handleIncomingOffer(item.peerId, item.offer, true);
            }
          }
        }
      } catch {
        // Ignore when running purely static without backend HTTP signaling
      }
    };

    void pollOffers();
    this.pollInterval = setInterval(() => {
      void pollOffers();
    }, 1000);
  }

  private async handleIncomingOffer(
    peerId: string,
    offer: RTCSessionDescriptionInit,
    publishAutoAnswer: boolean
  ): Promise<string | null> {
    if (this.destroyed) return null;
    if (this.processedOffers.has(peerId)) {
      return null;
    }
    this.processedOffers.add(peerId);

    const pc = new RTCPeerConnection(RTC_CONFIG);
    const record: PeerRecord = { peerId, pc, dc: null, playerId: null };
    this.peers.set(peerId, record);

    pc.ondatachannel = (ev) => {
      this.attachDataChannel(record, ev.channel);
    };

    pc.onconnectionstatechange = () => {
      if (
        pc.connectionState === 'disconnected' ||
        pc.connectionState === 'failed' ||
        pc.connectionState === 'closed'
      ) {
        this.cleanupPeer(peerId);
      }
    };

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitForIceGathering(pc, 1800);

      const finalAnswer = pc.localDescription;
      if (!finalAnswer) return null;

      const payload: SignalAnswerPayload = {
        kind: 'ANSWER',
        roomId: this.roomId,
        peerId,
        answer: { type: finalAnswer.type, sdp: finalAnswer.sdp },
      };

      if (publishAutoAnswer) {
        this.bc?.postMessage(payload);
        try {
          await fetch(`${this.signalBaseUrl}/answer`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
        } catch {
          // Ignore if static hosting
        }
      }

      return encodeSignal(payload);
    } catch (err) {
      console.error('WebRTC Host error handling offer:', err);
      this.cleanupPeer(peerId);
      return null;
    }
  }

  public async acceptManualOffer(offerCode: string): Promise<{ answerCode?: string; error?: string }> {
    const parsed = decodeSignal<SignalOfferPayload>(offerCode);
    if (!parsed || parsed.kind !== 'OFFER' || !parsed.peerId || !parsed.offer) {
      return { error: 'Mã Offer WebRTC không hợp lệ!' };
    }
    if (parsed.roomId && parsed.roomId !== this.roomId) {
      return { error: `Mã Offer này dành cho phòng #${parsed.roomId}, không phải #${this.roomId}.` };
    }
    // Allow re-processing if user pastes manually
    this.processedOffers.delete(parsed.peerId);
    const answerCode = await this.handleIncomingOffer(parsed.peerId, parsed.offer, false);
    if (!answerCode) {
      return { error: 'Không thể tạo mã Answer WebRTC. Vui lòng thử lại!' };
    }
    return { answerCode };
  }

  private attachDataChannel(record: PeerRecord, dc: RTCDataChannel) {
    record.dc = dc;

    dc.onmessage = (ev) => {
      if (this.destroyed) return;
      try {
        const action = JSON.parse(String(ev.data)) as ClientAction;
        if (action.type === 'JOIN_ROOM') {
          const result = this.engine.handleGuestJoin(action, (assignedPlayerId) => {
            record.playerId = assignedPlayerId;
            this.playerToPeer.set(assignedPlayerId, record.peerId);
          });
          if (result.error || !result.playerId) {
            if (dc.readyState === 'open') {
              dc.send(JSON.stringify({ type: 'ERROR', message: result.error || 'Không thể vào phòng!' }));
              setTimeout(() => this.cleanupPeer(record.peerId), 80);
            }
            return;
          }
          return;
        }

        if (record.playerId) {
          this.engine.handleAction(record.playerId, action);
        }
      } catch (err) {
        console.error('Invalid DataChannel message from guest:', err);
      }
    };

    dc.onclose = () => {
      this.cleanupPeer(record.peerId);
    };
  }

  private sendToPlayer(playerId: string, msg: ServerMessage) {
    if (this.destroyed || !this.engine) return;
    if (playerId === this.engine.getHostId()) {
      this.onLocalMessage(msg);
      return;
    }
    const peerId = this.playerToPeer.get(playerId);
    if (!peerId) return;
    const record = this.peers.get(peerId);
    if (record?.dc && record.dc.readyState === 'open') {
      try {
        record.dc.send(JSON.stringify(msg));
      } catch {
        this.cleanupPeer(peerId);
      }
    }
  }

  private disconnectPlayerPeer(playerId: string) {
    const peerId = this.playerToPeer.get(playerId);
    if (!peerId) return;
    setTimeout(() => {
      this.cleanupPeer(peerId);
    }, 60);
  }

  private cleanupPeer(peerId: string) {
    const record = this.peers.get(peerId);
    if (!record) return;
    this.peers.delete(peerId);

    const playerId = record.playerId;
    if (playerId) {
      this.playerToPeer.delete(playerId);
      this.engine.handlePlayerDisconnect(playerId);
    }

    try {
      record.dc?.close();
    } catch {
      // ignore
    }
    try {
      record.pc.close();
    } catch {
      // ignore
    }
  }

  public sendHostAction(action: ClientAction) {
    const hostId = this.engine.getHostId();
    if (hostId) {
      this.engine.handleAction(hostId, action);
    }
  }

  public destroy() {
    if (this.destroyed) return;
    this.destroyed = true;

    for (const record of this.peers.values()) {
      if (record.dc && record.dc.readyState === 'open') {
        try {
          record.dc.send(
            JSON.stringify({
              type: 'ERROR',
              message: 'Chủ phòng đã đóng phòng chơi.',
            } satisfies ServerMessage)
          );
        } catch {
          // ignore
        }
      }
    }

    setTimeout(() => {
      for (const record of this.peers.values()) {
        try {
          record.dc?.close();
          record.pc.close();
        } catch {
          // ignore
        }
      }
      this.peers.clear();
      this.playerToPeer.clear();
    }, 50);

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.bc) {
      this.bc.close();
      this.bc = null;
    }

    try {
      void fetch(`${this.signalBaseUrl}/room?roomId=${encodeURIComponent(this.roomId)}`, {
        method: 'DELETE',
      });
    } catch {
      // ignore
    }

    this.engine.destroy();
  }
}

export class MonopolyGuestRTC {
  public readonly roomId: string;
  public readonly peerId: string;
  private readonly signalBaseUrl: string;
  private pc: RTCPeerConnection;
  private dc: RTCDataChannel;
  private bc: BroadcastChannel | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private answerApplied = false;
  private destroyed = false;
  private hasOpened = false;

  private callbacks: {
    onConnected: () => void;
    onMessage: (msg: ServerMessage) => void;
    onDisconnected: (reason?: string) => void;
    onOfferReady: (offerCode: string) => void;
  };

  constructor(
    params: { roomId: string; name: string; avatarId: string; signalUrl?: string },
    callbacks: {
      onConnected: () => void;
      onMessage: (msg: ServerMessage) => void;
      onDisconnected: (reason?: string) => void;
      onOfferReady: (offerCode: string) => void;
    }
  ) {
    this.roomId = params.roomId.trim().toUpperCase();
    this.peerId = `peer_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    this.signalBaseUrl = normalizeSignalBaseUrl(params.signalUrl);
    this.callbacks = callbacks;

    this.pc = new RTCPeerConnection(RTC_CONFIG);
    this.dc = this.pc.createDataChannel('monopoly', { ordered: true });

    this.dc.onopen = () => {
      if (this.destroyed) return;
      this.hasOpened = true;
      this.stopSignaling();
      this.callbacks.onConnected();
      this.sendAction({
        type: 'JOIN_ROOM',
        roomId: this.roomId,
        name: params.name,
        avatarId: params.avatarId,
      });
    };

    this.dc.onmessage = (ev) => {
      if (this.destroyed) return;
      try {
        const msg = JSON.parse(String(ev.data)) as ServerMessage;
        this.callbacks.onMessage(msg);
      } catch (err) {
        console.error('Error parsing DataChannel message:', err);
      }
    };

    this.dc.onclose = () => {
      if (this.destroyed) return;
      this.callbacks.onDisconnected(
        this.hasOpened ? 'Đã ngắt kết nối WebRTC với chủ phòng.' : 'Không thể thiết lập kênh WebRTC.'
      );
    };

    this.pc.onconnectionstatechange = () => {
      if (this.destroyed) return;
      if (
        this.pc.connectionState === 'failed' ||
        this.pc.connectionState === 'disconnected' ||
        this.pc.connectionState === 'closed'
      ) {
        this.callbacks.onDisconnected('Kết nối WebRTC với chủ phòng đã bị gián đoạn.');
      }
    };

    void this.startOfferAndListen();
  }

  private async startOfferAndListen() {
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      await waitForIceGathering(this.pc, 1800);

      if (this.destroyed || !this.pc.localDescription) return;

      const payload: SignalOfferPayload = {
        kind: 'OFFER',
        roomId: this.roomId,
        peerId: this.peerId,
        offer: {
          type: this.pc.localDescription.type,
          sdp: this.pc.localDescription.sdp,
        },
      };

      this.callbacks.onOfferReady(encodeSignal(payload));

      // 1. BroadcastChannel for same-browser tabs
      if (typeof BroadcastChannel !== 'undefined') {
        this.bc = new BroadcastChannel(SIGNAL_CHANNEL_NAME);
        this.bc.onmessage = (ev: MessageEvent<SignalBroadcastMsg>) => {
          const data = ev.data;
          if (
            data &&
            data.kind === 'ANSWER' &&
            data.roomId === this.roomId &&
            data.peerId === this.peerId
          ) {
            void this.applyAnswer(data.answer);
          }
        };
        this.bc.postMessage(payload);
      }

      // 2. Stateless HTTP signaling for cross-device / cross-browser (zero WebSocket)
      try {
        await fetch(`${this.signalBaseUrl}/offer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } catch {
        // Ignore if running statically
      }

      const pollAnswer = async () => {
        if (this.destroyed || this.answerApplied) return;
        try {
          const res = await fetch(
            `${this.signalBaseUrl}/answer?roomId=${encodeURIComponent(this.roomId)}&peerId=${encodeURIComponent(this.peerId)}`,
            { cache: 'no-store' }
          );
          const contentType = res.headers.get('content-type') || '';
          if (res.status === 404 || !contentType.includes('application/json')) {
            if (this.pollInterval) {
              clearInterval(this.pollInterval);
              this.pollInterval = null;
            }
            return;
          }
          if (!res.ok) return;
          const data = (await res.json()) as { answer?: RTCSessionDescriptionInit };
          if (data.answer) {
            void this.applyAnswer(data.answer);
          }
        } catch {
          // Ignore if static
        }
      };

      void pollAnswer();
      this.pollInterval = setInterval(() => {
        void pollAnswer();
      }, 1000);
    } catch (err) {
      console.error('WebRTC Guest error creating offer:', err);
      this.callbacks.onDisconnected('Không thể khởi tạo kết nối WebRTC.');
    }
  }

  private async applyAnswer(answer: RTCSessionDescriptionInit): Promise<boolean> {
    if (this.destroyed || this.answerApplied) return false;
    this.answerApplied = true;
    try {
      await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
      return true;
    } catch (err) {
      console.error('Error applying WebRTC answer:', err);
      this.answerApplied = false;
      return false;
    }
  }

  public async submitManualAnswer(answerCode: string): Promise<boolean> {
    const parsed = decodeSignal<SignalAnswerPayload>(answerCode);
    if (!parsed || parsed.kind !== 'ANSWER' || !parsed.answer) {
      return false;
    }
    return this.applyAnswer(parsed.answer);
  }

  public sendAction(action: ClientAction) {
    if (!this.destroyed && this.dc.readyState === 'open') {
      this.dc.send(JSON.stringify(action));
    }
  }

  private stopSignaling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.bc) {
      this.bc.close();
      this.bc = null;
    }
  }

  public destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopSignaling();
    try {
      this.dc.close();
    } catch {
      // ignore
    }
    try {
      this.pc.close();
    } catch {
      // ignore
    }
  }
}
