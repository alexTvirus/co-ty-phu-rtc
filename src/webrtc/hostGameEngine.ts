import {
  GameState,
  Player,
  ClientAction,
  ServerMessage,
  ChatMessage,
  GameEndRule,
  PlayerNetWorth,
} from '../types/monopoly';
import {
  MONOPOLY_SPACES,
  COLOR_GROUPS,
  ROBLOX_AVATARS,
  CHANCE_CARDS,
  CHEST_CARDS,
  getRandomName,
} from '../data/monopolyBoard';

export const DISTINCT_PLAYER_COLORS = [
  '#2563eb', // Blue
  '#dc2626', // Red
  '#16a34a', // Green
  '#eab308', // Gold / Yellow
  '#9333ea', // Purple
  '#db2777', // Pink
  '#0891b2', // Cyan
  '#475569', // Slate
  '#4f46e5', // Indigo
  '#78350f', // Brown
];

export function getPlayerUniqueColor(existingPlayers: Player[]): string {
  const used = new Set(existingPlayers.map((p) => p.color));
  for (const c of DISTINCT_PLAYER_COLORS) {
    if (!used.has(c)) return c;
  }
  return DISTINCT_PLAYER_COLORS[existingPlayers.length % DISTINCT_PLAYER_COLORS.length];
}

export function calculatePlayerNetWorth(player: Player): {
  cash: number;
  propertyValue: number;
  houseValue: number;
  totalNetWorth: number;
} {
  let propertyValue = 0;
  let houseValue = 0;
  for (const prop of player.properties) {
    const space = MONOPOLY_SPACES[prop.spaceId];
    if (space) {
      if (prop.isMortgaged) {
        propertyValue += space.mortgageValue || Math.floor((space.price || 0) / 2);
      } else {
        propertyValue += space.price || 0;
        if (prop.houses > 0) {
          houseValue += prop.houses * (space.houseCost || 50);
        }
      }
    }
  }
  const cash = Math.max(0, player.cash);
  const totalNetWorth = player.isBankrupt ? 0 : cash + propertyValue + houseValue;
  return { cash, propertyValue, houseValue, totalNetWorth };
}

export function generateLeaderboard(players: Player[]): PlayerNetWorth[] {
  const list: PlayerNetWorth[] = players.map((p) => {
    const nw = calculatePlayerNetWorth(p);
    return {
      playerId: p.id,
      name: p.name,
      color: p.color,
      cash: nw.cash,
      propertyValue: nw.propertyValue,
      houseValue: nw.houseValue,
      totalNetWorth: nw.totalNetWorth,
      rank: 1,
    };
  });
  list.sort((a, b) => b.totalNetWorth - a.totalNetWorth);
  list.forEach((item, index) => {
    item.rank = index + 1;
  });
  return list;
}

function createDefaultGameState(roomId: string): GameState {
  return {
    roomId,
    hostId: '',
    maxPlayers: 4,
    startingCash: 1500,
    status: 'lobby',
    players: [],
    currentPlayerIndex: 0,
    turnPhase: 'WAITING_TO_START',
    dice: { die1: 1, die2: 2, isRolling: false, isDouble: false, rollCount: 0 },
    currentTurnTimeLeft: 8,
    turnTimerMax: 8,
    rollDiceTimeLeft: 8,
    rollDiceTimerMax: 8,
    mainTurnTimeLeft: 30,
    mainTurnTimerMax: 30,
    actionTimeLeft: 10,
    actionTimerMax: 10,
    activeCardModal: null,
    auction: null,
    drawnCard: null,
    winnerId: null,
    history: ['Phòng chơi đã được khởi tạo (WebRTC P2P). Sẵn sàng bắt đầu!'],
    endRule: { type: 'max_rolls', value: 90 },
    totalRollsCount: 0,
    gameStartTime: 0,
    gameTimeElapsed: 0,
    leaderboard: [],
  };
}

function calculateRent(spaceId: number, diceTotal: number, state: GameState): number {
  const space = MONOPOLY_SPACES[spaceId];
  if (!space) return 0;

  const owner = state.players.find((p) => p.properties.some((prop) => prop.spaceId === spaceId));
  if (!owner) return 0;
  const propState = owner.properties.find((p) => p.spaceId === spaceId);
  if (!propState || propState.isMortgaged) return 0;

  if (space.type === 'property' && space.rent) {
    if (propState.houses > 0) {
      return space.rent[propState.houses + 1] || space.rent[1];
    }
    const groupSpaces = COLOR_GROUPS[space.colorGroup] || [];
    const ownsAll = groupSpaces.every((sId) =>
      owner.properties.some((p) => p.spaceId === sId && !p.isMortgaged)
    );
    return ownsAll ? space.rent[0] * 2 : space.rent[0];
  }

  if (space.type === 'railroad') {
    const stationSpaces = COLOR_GROUPS.station;
    const ownedStations = owner.properties.filter((p) => stationSpaces.includes(p.spaceId)).length;
    return 25 * Math.pow(2, Math.max(0, ownedStations - 1));
  }

  if (space.type === 'utility') {
    const utilitySpaces = COLOR_GROUPS.utility;
    const ownedUtilities = owner.properties.filter((p) => utilitySpaces.includes(p.spaceId)).length;
    return ownedUtilities === 2 ? diceTotal * 10 : diceTotal * 4;
  }

  return 0;
}

export interface HostEngineCallbacks {
  sendToPlayer: (playerId: string, message: ServerMessage) => void;
  onKickPeer: (playerId: string) => void;
}

export class HostGameEngine {
  public readonly roomId: string;
  public state: GameState;
  private connectedPlayerIds = new Set<string>();
  private timerInterval?: ReturnType<typeof setInterval>;
  private botTimeout?: ReturnType<typeof setTimeout>;
  private pendingTimeouts = new Set<ReturnType<typeof setTimeout>>();
  private callbacks: HostEngineCallbacks;
  private isDestroyed = false;

  constructor(
    config: {
      roomId: string;
      name: string;
      avatarId: string;
      maxPlayers: number;
      mainTurnTimer: number;
      startingCash: number;
      endRule?: GameEndRule;
    },
    callbacks: HostEngineCallbacks
  ) {
    const normalizedRoomId = (config.roomId || `VN${Math.floor(1000 + Math.random() * 9000)}`)
      .trim()
      .toUpperCase();
    this.roomId = normalizedRoomId;
    this.callbacks = callbacks;
    this.state = createDefaultGameState(normalizedRoomId);
    this.initHostRoom(config);
  }

  private scheduleTimeout(fn: () => void, ms: number) {
    const id = setTimeout(() => {
      this.pendingTimeouts.delete(id);
      if (!this.isDestroyed) fn();
    }, ms);
    this.pendingTimeouts.add(id);
    return id;
  }

  private clearAllTimers() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = undefined;
    }
    if (this.botTimeout) {
      clearTimeout(this.botTimeout);
      this.botTimeout = undefined;
    }
    for (const id of this.pendingTimeouts) {
      clearTimeout(id);
    }
    this.pendingTimeouts.clear();
  }

  public destroy() {
    this.isDestroyed = true;
    this.clearAllTimers();
    this.connectedPlayerIds.clear();
  }

  public getHostId(): string {
    return this.state.hostId;
  }

  private initHostRoom(config: {
    roomId?: string;
    name: string;
    avatarId: string;
    maxPlayers: number;
    mainTurnTimer: number;
    startingCash: number;
    endRule?: GameEndRule;
  }) {
    this.state.maxPlayers = Math.max(2, Math.min(10, config.maxPlayers || 4));
    const mainTimer = Math.max(15, Math.min(60, config.mainTurnTimer || 30));
    this.state.mainTurnTimerMax = mainTimer;
    this.state.mainTurnTimeLeft = mainTimer;
    this.state.startingCash = Math.max(500, Math.min(5000, config.startingCash || 1500));
    this.state.endRule = config.endRule || { type: 'max_rolls', value: 90 };
    this.state.totalRollsCount = 0;
    this.state.gameTimeElapsed = 0;
    this.state.gameStartTime = 0;
    this.state.leaderboard = [];

    const avatar = ROBLOX_AVATARS.find((a) => a.id === config.avatarId) || ROBLOX_AVATARS[0];
    const assignedColor = DISTINCT_PLAYER_COLORS[0];
    const hostPlayer: Player = {
      id: `p_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      name: config.name || getRandomName(),
      avatar: { ...avatar, color: assignedColor },
      cash: this.state.startingCash,
      position: 0,
      inJail: false,
      jailTurns: 0,
      getOutOfJailCards: 0,
      isBankrupt: false,
      isDisconnected: false,
      isQuit: false,
      isBot: false,
      isReady: true,
      properties: [],
      color: assignedColor,
    };

    this.state.players = [hostPlayer];
    this.state.hostId = hostPlayer.id;
    this.connectedPlayerIds.add(hostPlayer.id);
  }

  public start() {
    const hostPlayer = this.state.players[0];
    if (hostPlayer) {
      this.broadcastGameEvent(
        `👑 ${hostPlayer.name} đã tạo phòng #${this.roomId} (Cần đủ ${this.state.maxPlayers} người, ${this.state.mainTurnTimerMax}s/lượt, vốn ${this.state.startingCash}$).`,
        '#10b981',
        'Tạo Phòng'
      );
    }
    this.broadcastState();
  }

  private broadcastToRoom(message: ServerMessage, excludePlayerId?: string) {
    for (const pId of this.connectedPlayerIds) {
      if (excludePlayerId && pId === excludePlayerId) continue;
      this.callbacks.sendToPlayer(pId, message);
    }
  }

  private broadcastState() {
    const snapshot = JSON.parse(JSON.stringify(this.state)) as GameState;
    for (const pId of this.connectedPlayerIds) {
      this.callbacks.sendToPlayer(pId, {
        type: 'ROOM_STATE',
        state: snapshot,
        yourPlayerId: pId,
      });
    }
  }

  private broadcastGameEvent(text: string, color: string = '#f59e0b', senderName: string = 'Hệ Thống') {
    this.state.history.unshift(text);
    if (this.state.history.length > 40) this.state.history.pop();
    this.broadcastToRoom({
      type: 'CHAT_MESSAGE',
      message: {
        id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        senderId: 'system',
        senderName,
        senderColor: color,
        text,
        timestamp: Date.now(),
        isSystem: true,
      },
    });
  }

  /**
   * Handle a guest attempting to join via WebRTC DataChannel.
   * Returns assigned playerId if accepted, or { error } if rejected.
   */
  public handleGuestJoin(
    action: Extract<ClientAction, { type: 'JOIN_ROOM' }>,
    onPlayerAssigned?: (playerId: string) => void
  ): { playerId?: string; error?: string } {
    const reqRoomId = (action.roomId || '').trim().toUpperCase();
    if (reqRoomId && reqRoomId !== this.roomId) {
      return { error: `Mã phòng không khớp (${reqRoomId} ≠ ${this.roomId}).` };
    }

    if (this.state.status !== 'lobby') {
      const existing = this.state.players.find(
        (p) => p.name === action.name && (p.isDisconnected || p.isQuit)
      );
      if (existing) {
        existing.isDisconnected = false;
        existing.isQuit = false;
        this.connectedPlayerIds.add(existing.id);
        onPlayerAssigned?.(existing.id);
        this.broadcastGameEvent(`🔌 ${existing.name} đã kết nối lại bàn cờ.`, '#3b82f6', 'Kết Nối');
        this.broadcastState();
        return { playerId: existing.id };
      }
      return { error: 'Ván đấu trong phòng này đã bắt đầu!' };
    }

    if (this.state.players.length >= this.state.maxPlayers) {
      return { error: `Phòng đã đủ ${this.state.maxPlayers} người chơi!` };
    }

    const avatar =
      ROBLOX_AVATARS.find((a) => a.id === action.avatarId) ||
      ROBLOX_AVATARS[this.state.players.length % ROBLOX_AVATARS.length];
    const assignedColor = getPlayerUniqueColor(this.state.players);
    const newPlayer: Player = {
      id: `p_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      name: action.name || getRandomName(),
      avatar: { ...avatar, color: assignedColor },
      cash: this.state.startingCash || 1500,
      position: 0,
      inJail: false,
      jailTurns: 0,
      getOutOfJailCards: 0,
      isBankrupt: false,
      isDisconnected: false,
      isQuit: false,
      isBot: false,
      isReady: false,
      properties: [],
      color: assignedColor,
    };

    this.state.players.push(newPlayer);
    this.connectedPlayerIds.add(newPlayer.id);
    onPlayerAssigned?.(newPlayer.id);
    this.broadcastGameEvent(
      `👋 ${newPlayer.name} đã vào phòng qua WebRTC (${this.state.players.length}/${this.state.maxPlayers}).`,
      '#3b82f6',
      'Tham Gia'
    );
    this.broadcastState();
    return { playerId: newPlayer.id };
  }

  public handlePlayerDisconnect(playerId: string) {
    if (this.isDestroyed || !this.connectedPlayerIds.has(playerId)) return;
    this.connectedPlayerIds.delete(playerId);

    const player = this.state.players.find((p) => p.id === playerId);
    if (!player) return;

    if (this.state.status === 'lobby') {
      this.state.players = this.state.players.filter((p) => p.id !== playerId);
      this.broadcastGameEvent(`🔌 ${player.name} đã rời phòng chờ.`, '#64748b', 'Rời Phòng');
    } else {
      player.isDisconnected = true;
      this.broadcastGameEvent(`🔌 ${player.name} đã mất kết nối WebRTC.`, '#64748b', 'Mất Kết Nối');
      if (!this.checkRemainingActivePlayers()) {
        const curr = this.state.players[this.state.currentPlayerIndex];
        if (curr && curr.id === playerId) {
          this.endPlayerTurn();
        }
      }
    }
    this.broadcastState();
  }

  public handleAction(playerId: string, action: ClientAction) {
    if (this.isDestroyed) return;

    switch (action.type) {
      case 'TOGGLE_READY': {
        const p = this.state.players.find((pl) => pl.id === playerId);
        if (p && this.state.status === 'lobby') {
          p.isReady = !p.isReady;
          this.broadcastGameEvent(
            p.isReady ? `✅ ${p.name} đã SẴN SÀNG!` : `⏳ ${p.name} đã HỦY sẵn sàng!`,
            p.isReady ? '#10b981' : '#f59e0b',
            'Sẵn Sàng'
          );
          this.broadcastState();
        }
        break;
      }

      case 'START_GAME': {
        if (playerId !== this.state.hostId) {
          this.callbacks.sendToPlayer(playerId, {
            type: 'ERROR',
            message: 'Chỉ có Chủ Phòng mới có quyền bắt đầu trò chơi!',
          });
          return;
        }
        if (this.state.players.length !== this.state.maxPlayers) {
          this.callbacks.sendToPlayer(playerId, {
            type: 'ERROR',
            message: `Cần đủ đúng ${this.state.maxPlayers} người chơi (hiện có ${this.state.players.length}). Hãy thêm người hoặc bot!`,
          });
          return;
        }
        const allGuestsReady = this.state.players
          .filter((p) => p.id !== this.state.hostId && !p.isBot)
          .every((p) => p.isReady);
        if (!allGuestsReady) {
          this.callbacks.sendToPlayer(playerId, {
            type: 'ERROR',
            message: 'Tất cả người chơi phải bấm Sẵn Sàng trước khi bắt đầu!',
          });
          return;
        }

        this.state.status = 'playing';
        this.state.currentPlayerIndex = 0;
        this.state.turnPhase = 'ROLL_DICE';
        this.state.rollDiceTimeLeft = 8;
        this.state.currentTurnTimeLeft = 8;
        this.state.mainTurnTimeLeft = this.state.mainTurnTimerMax;
        this.state.gameStartTime = Date.now();
        this.state.totalRollsCount = 0;
        this.state.gameTimeElapsed = 0;
        this.broadcastGameEvent(
          '🎉 Tất cả người chơi đã sẵn sàng! Ván Cờ Tỷ Phú CHÍNH THỨC BẮT ĐẦU!',
          '#10b981',
          'Bắt Đầu'
        );
        this.startRoomTimer();
        this.broadcastState();
        this.handleBotTurn();
        break;
      }

      case 'KICK_PLAYER': {
        if (playerId !== this.state.hostId) return;
        const targetPlayerId = action.playerId;
        if (targetPlayerId === this.state.hostId) return;

        const targetPlayer = this.state.players.find((p) => p.id === targetPlayerId);
        if (!targetPlayer) return;

        this.broadcastGameEvent(`👢 ${targetPlayer.name} đã bị chủ phòng KICK khỏi phòng!`, '#dc2626', 'Kick');

        if (this.connectedPlayerIds.has(targetPlayerId)) {
          this.callbacks.sendToPlayer(targetPlayerId, {
            type: 'KICKED',
            message: 'Bạn đã bị chủ phòng kick khỏi phòng chơi!',
          });
          this.connectedPlayerIds.delete(targetPlayerId);
          this.callbacks.onKickPeer(targetPlayerId);
        }

        if (this.state.status === 'lobby') {
          this.state.players = this.state.players.filter((p) => p.id !== targetPlayerId);
        } else {
          targetPlayer.isDisconnected = true;
          targetPlayer.isQuit = true;
          targetPlayer.isBankrupt = true;
          if (!this.checkRemainingActivePlayers()) {
            const curr = this.state.players[this.state.currentPlayerIndex];
            if (curr && curr.id === targetPlayerId) {
              this.endPlayerTurn();
            }
          }
        }
        this.broadcastState();
        break;
      }

      case 'QUIT_GAME': {
        const player = this.state.players.find((p) => p.id === playerId);
        if (player) {
          this.broadcastGameEvent(`🔌 ${player.name} đã thoát khỏi cuộc chơi.`, '#64748b', 'Rời Game');
          this.connectedPlayerIds.delete(playerId);
          if (this.state.status === 'lobby') {
            this.state.players = this.state.players.filter((p) => p.id !== playerId);
          } else {
            player.isDisconnected = true;
            player.isQuit = true;
            player.isBankrupt = true;
            if (!this.checkRemainingActivePlayers()) {
              const curr = this.state.players[this.state.currentPlayerIndex];
              if (curr && curr.id === playerId) {
                this.endPlayerTurn();
              }
            }
          }
          if (playerId !== this.state.hostId) {
            this.callbacks.onKickPeer(playerId);
          }
          this.broadcastState();
        }
        break;
      }

      case 'ADD_BOT': {
        if (playerId !== this.state.hostId) return;
        if (this.state.players.length >= this.state.maxPlayers || this.state.status !== 'lobby') return;
        const botIdx = this.state.players.length;
        const avatar = ROBLOX_AVATARS[botIdx % ROBLOX_AVATARS.length];
        const botColor = getPlayerUniqueColor(this.state.players);
        const botPlayer: Player = {
          id: `bot_${Date.now()}_${botIdx}`,
          name: `Bot ${getRandomName()}`,
          avatar: { ...avatar, color: botColor },
          cash: this.state.startingCash || 1500,
          position: 0,
          inJail: false,
          jailTurns: 0,
          getOutOfJailCards: 0,
          isBankrupt: false,
          isDisconnected: false,
          isQuit: false,
          isBot: true,
          isReady: true,
          properties: [],
          color: botColor,
        };
        this.state.players.push(botPlayer);
        this.broadcastGameEvent(
          `🤖 Đã thêm Bot: ${botPlayer.name} (${this.state.players.length}/${this.state.maxPlayers})`,
          '#eab308',
          'Thêm Bot'
        );
        this.broadcastState();
        break;
      }

      case 'REMOVE_PLAYER': {
        if (playerId !== this.state.hostId) return;
        if (this.state.status === 'lobby') {
          this.state.players = this.state.players.filter((p) => p.id !== action.playerId);
          this.broadcastState();
        }
        break;
      }

      case 'ROLL_DICE': {
        const currPlayer = this.state.players[this.state.currentPlayerIndex];
        if (currPlayer && currPlayer.id === playerId) {
          this.rollDice(playerId);
        }
        break;
      }

      case 'BUY_PROPERTY': {
        const currPlayer = this.state.players[this.state.currentPlayerIndex];
        if (currPlayer && currPlayer.id === playerId) {
          this.buyProperty(playerId, action.spaceId);
        }
        break;
      }

      case 'PASS_ACTION':
      case 'PASS_PROPERTY': {
        const currPlayer = this.state.players[this.state.currentPlayerIndex];
        if (currPlayer && currPlayer.id === playerId) {
          this.passAction(playerId);
        }
        break;
      }

      case 'BID': {
        this.placeBid(playerId, action.amount);
        break;
      }

      case 'PASS_BID': {
        this.passBid(playerId);
        break;
      }

      case 'END_TURN': {
        const currPlayer = this.state.players[this.state.currentPlayerIndex];
        if (currPlayer && currPlayer.id === playerId) {
          this.broadcastGameEvent(`⏭️ ${currPlayer.name} đã chủ động kết thúc lượt.`, '#94a3b8', 'Hết Lượt');
          this.endPlayerTurn();
        }
        break;
      }

      case 'UPGRADE_PROPERTY': {
        const currPlayer = this.state.players[this.state.currentPlayerIndex];
        if (currPlayer && currPlayer.id === playerId) {
          this.upgradeProperty(playerId, action.spaceId);
        }
        break;
      }

      case 'MORTGAGE_PROPERTY': {
        const currPlayer = this.state.players[this.state.currentPlayerIndex];
        if (currPlayer && currPlayer.id === playerId) {
          this.mortgageProperty(playerId, action.spaceId);
        }
        break;
      }

      case 'UNMORTGAGE_PROPERTY': {
        const currPlayer = this.state.players[this.state.currentPlayerIndex];
        if (currPlayer && currPlayer.id === playerId) {
          this.unmortgageProperty(playerId, action.spaceId);
        }
        break;
      }

      case 'PAY_JAIL_FINE': {
        const currPlayer = this.state.players[this.state.currentPlayerIndex];
        if (currPlayer && currPlayer.id === playerId) {
          this.payJailFine(playerId);
        }
        break;
      }

      case 'USE_JAIL_CARD': {
        const currPlayer = this.state.players[this.state.currentPlayerIndex];
        if (currPlayer && currPlayer.id === playerId) {
          this.useJailCard(playerId);
        }
        break;
      }

      case 'DECLARE_BANKRUPTCY':
        this.declareBankruptcy(playerId);
        break;

      case 'SEND_CHAT': {
        const sender = this.state.players.find((p) => p.id === playerId);
        if (sender && action.text.trim()) {
          const chatMsg: ChatMessage = {
            id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            senderId: sender.id,
            senderName: sender.name,
            senderColor: sender.color,
            text: action.text.trim().substring(0, 200),
            timestamp: Date.now(),
          };
          this.broadcastToRoom({ type: 'CHAT_MESSAGE', message: chatMsg });
        }
        break;
      }
    }
  }

  private triggerGameEndWithReason(reason: string) {
    if (this.state.status === 'ended') return;
    this.state.status = 'ended';
    this.state.turnPhase = 'GAME_OVER';
    this.state.leaderboard = generateLeaderboard(this.state.players);
    this.state.winnerId = this.state.leaderboard[0]?.playerId || null;
    this.state.endReason = reason;
    this.state.currentTurnTimeLeft = 0;
    this.state.rollDiceTimeLeft = 0;
    this.state.mainTurnTimeLeft = 0;
    this.state.actionTimeLeft = 0;
    this.state.turnTimerMax = 0;
    this.state.activeCardModal = null;
    this.state.auction = null;
    this.state.drawnCard = null;

    this.clearAllTimers();

    const winner = this.state.players.find((p) => p.id === this.state.winnerId);
    const winnerName = winner?.name || 'Người chơi';
    const winnerNW = this.state.leaderboard[0]?.totalNetWorth || 0;
    this.broadcastGameEvent(
      `🏁 VÁN ĐẤU KẾT THÚC: ${reason} 🏆 ${winnerName} chiến thắng với tổng tài sản ${winnerNW}$!`,
      '#f59e0b',
      'Kết Thúc'
    );
    this.broadcastState();
  }

  private triggerSinglePlayerWin(winnerPlayer?: Player) {
    if (this.state.status === 'ended') return;
    this.state.status = 'ended';
    this.state.turnPhase = 'GAME_OVER';
    this.state.leaderboard = generateLeaderboard(this.state.players);
    this.state.winnerId = winnerPlayer?.id || this.state.leaderboard[0]?.playerId || null;
    this.state.endReason = 'Tất cả đối thủ đã rời đi hoặc mất kết nối!';
    this.state.currentTurnTimeLeft = 0;
    this.state.rollDiceTimeLeft = 0;
    this.state.mainTurnTimeLeft = 0;
    this.state.actionTimeLeft = 0;
    this.state.turnTimerMax = 0;
    this.state.activeCardModal = null;
    this.state.auction = null;
    this.state.drawnCard = null;

    this.clearAllTimers();

    const winnerName = winnerPlayer?.name || 'Người chơi còn lại';
    this.broadcastGameEvent(
      `🏆 ${winnerName} MẶC ĐỊNH CHIẾN THẮNG! Tất cả đối thủ đã rời đi hoặc mất kết nối. Trò chơi dừng lại!`,
      '#f59e0b',
      'Chiến Thắng'
    );
    this.broadcastState();
  }

  private checkRemainingActivePlayers(): boolean {
    if (this.state.status !== 'playing') return false;
    const activePlayers = this.state.players.filter(
      (p) => !p.isBankrupt && !p.isDisconnected && !p.isQuit
    );
    if (activePlayers.length <= 1) {
      this.triggerSinglePlayerWin(activePlayers[0]);
      return true;
    }
    return false;
  }

  private checkGameEndConditions(): boolean {
    if (this.state.status !== 'playing') return false;
    if (this.checkRemainingActivePlayers()) return true;

    if (this.state.endRule?.type === 'target_cash') {
      const alive = this.state.players.filter(
        (p) => !p.isBankrupt && !p.isDisconnected && !p.isQuit
      );
      for (const p of alive) {
        const nw = calculatePlayerNetWorth(p);
        if (nw.totalNetWorth >= this.state.endRule.value) {
          this.triggerGameEndWithReason(
            `🎯 ${p.name} đã chạm mốc tài sản ${this.state.endRule.value}$!`
          );
          return true;
        }
      }
    }

    if (
      this.state.endRule?.type === 'max_rolls' &&
      this.state.totalRollsCount >= this.state.endRule.value
    ) {
      this.triggerGameEndWithReason(
        `🎲 Đã hoàn thành giới hạn ${this.state.endRule.value} lượt đổ xúc xắc!`
      );
      return true;
    }

    return false;
  }

  private startRoomTimer() {
    if (this.timerInterval) clearInterval(this.timerInterval);

    this.timerInterval = setInterval(() => {
      if (this.isDestroyed || this.state.status !== 'playing') return;

      this.state.gameTimeElapsed = (this.state.gameTimeElapsed || 0) + 1;
      if (this.state.endRule?.type === 'time_limit') {
        const limitSeconds = this.state.endRule.value * 60;
        if (this.state.gameTimeElapsed >= limitSeconds) {
          this.triggerGameEndWithReason(
            `⏰ Đã hết thời gian thi đấu ${this.state.endRule.value} phút!`
          );
          return;
        }
      }

      const currPlayer = this.state.players[this.state.currentPlayerIndex];
      if (!currPlayer) return;

      if (this.state.turnPhase === 'ROLL_DICE') {
        if (this.state.rollDiceTimeLeft > 0) {
          this.state.rollDiceTimeLeft--;
          this.state.currentTurnTimeLeft = this.state.rollDiceTimeLeft;
          this.state.turnTimerMax = this.state.rollDiceTimerMax;
          this.broadcastState();
        } else {
          this.rollDice(currPlayer.id);
        }
      } else if (this.state.turnPhase === 'ACTION_DECISION') {
        if (this.state.actionTimeLeft > 0) {
          this.state.actionTimeLeft--;
          this.state.currentTurnTimeLeft = this.state.actionTimeLeft;
          this.state.turnTimerMax = this.state.actionTimerMax;
          this.broadcastState();
        } else {
          this.passAction(currPlayer.id);
        }
      } else if (this.state.turnPhase === 'MAIN_TURN') {
        if (this.state.mainTurnTimeLeft > 0) {
          this.state.mainTurnTimeLeft--;
          this.state.currentTurnTimeLeft = this.state.mainTurnTimeLeft;
          this.state.turnTimerMax = this.state.mainTurnTimerMax;
          this.broadcastState();
        } else {
          this.endPlayerTurn();
        }
      } else if (this.state.turnPhase === 'AUCTION') {
        if (this.state.auction) {
          if (this.state.auction.timeLeft > 0) {
            this.state.auction.timeLeft--;
            this.broadcastState();
          } else {
            this.passBid(this.state.auction.currentBidderId);
          }
        }
      }
    }, 1000);
  }

  private handleBotTurn() {
    if (this.state.status !== 'playing') return;
    const currPlayer = this.state.players[this.state.currentPlayerIndex];
    if (!currPlayer || !currPlayer.isBot || currPlayer.isBankrupt) return;

    if (this.botTimeout) clearTimeout(this.botTimeout);
    this.botTimeout = setTimeout(() => {
      if (this.isDestroyed || this.state.status !== 'playing') return;
      if (this.state.turnPhase === 'ROLL_DICE') {
        if (currPlayer.inJail) {
          if (currPlayer.cash > 400) {
            this.payJailFine(currPlayer.id);
          } else {
            this.rollDice(currPlayer.id);
          }
        } else {
          this.rollDice(currPlayer.id);
        }
      } else if (this.state.turnPhase === 'ACTION_DECISION') {
        const spaceId = this.state.activeCardModal?.spaceId;
        if (spaceId !== undefined && this.state.activeCardModal?.canAct) {
          const space = MONOPOLY_SPACES[spaceId];
          if (space && space.price && currPlayer.cash >= space.price + 150) {
            this.buyProperty(currPlayer.id, spaceId);
          } else {
            this.passAction(currPlayer.id);
          }
        } else {
          this.passAction(currPlayer.id);
        }
      } else if (this.state.turnPhase === 'MAIN_TURN') {
        this.endPlayerTurn();
      }
    }, 1200);
  }

  private rollDice(playerId: string) {
    const currPlayer = this.state.players[this.state.currentPlayerIndex];
    if (
      !currPlayer ||
      currPlayer.id !== playerId ||
      this.state.turnPhase !== 'ROLL_DICE' ||
      this.state.dice.isRolling
    ) {
      return;
    }

    this.state.totalRollsCount = (this.state.totalRollsCount || 0) + 1;

    const d1 = Math.floor(Math.random() * 6) + 1;
    const d2 = Math.floor(Math.random() * 6) + 1;
    const isDouble = d1 === d2;
    const rollCount = isDouble ? this.state.dice.rollCount + 1 : 0;

    this.state.dice = {
      die1: d1,
      die2: d2,
      isRolling: true,
      isDouble,
      rollCount,
    };
    this.state.history.unshift(`🎲 ${currPlayer.name} đang lắc xúc xắc...`);
    if (this.state.history.length > 40) this.state.history.pop();
    this.broadcastState();

    this.scheduleTimeout(() => {
      if (this.state.status !== 'playing') return;
      this.state.dice.isRolling = false;
      const total = d1 + d2;
      this.broadcastGameEvent(
        `🎲 ${currPlayer.name} gieo được ${d1} và ${d2} (Tổng: ${total})${isDouble ? ' ⭐ ĐỔ KÉP!' : ''}`,
        '#f59e0b',
        'Xúc Xắc'
      );
      this.broadcastState();

      if (currPlayer.inJail) {
        if (isDouble) {
          currPlayer.inJail = false;
          currPlayer.jailTurns = 0;
          this.broadcastGameEvent(
            `🎉 ${currPlayer.name} đổ được xúc xắc kép và được thả tự do!`,
            '#10b981',
            'Ra Tù'
          );
          this.movePlayer(currPlayer, total);
        } else {
          currPlayer.jailTurns++;
          if (currPlayer.jailTurns >= 3) {
            currPlayer.cash -= 50;
            currPlayer.inJail = false;
            currPlayer.jailTurns = 0;
            this.broadcastGameEvent(
              `⛓️ ${currPlayer.name} hết 3 lượt trong tù, nộp phạt 50$ để ra tù.`,
              '#ef4444',
              'Tù'
            );
            this.movePlayer(currPlayer, total);
          } else {
            this.broadcastGameEvent(
              `⛓️ ${currPlayer.name} chưa đổ được kép (lượt ${currPlayer.jailTurns}/3 trong tù).`,
              '#64748b',
              'Tù'
            );
            this.endPlayerTurn();
          }
        }
        return;
      }

      if (rollCount >= 3) {
        this.broadcastGameEvent(
          `🚔 ${currPlayer.name} đổ kép 3 lần liên tiếp! Bị bắt vào tù.`,
          '#dc2626',
          'Tòa Án'
        );
        this.sendPlayerToJail(currPlayer);
        return;
      }

      this.movePlayer(currPlayer, total);
    }, 3500);
  }

  private sendPlayerToJail(player: Player) {
    player.position = 10;
    player.inJail = true;
    player.jailTurns = 0;
    this.state.dice.rollCount = 0;
    this.broadcastGameEvent(`🚨 ${player.name} đã bị áp giải VÀO TÙ!`, '#dc2626', 'Tòa Án');
    this.endPlayerTurn();
  }

  private movePlayer(player: Player, steps: number) {
    this.state.turnPhase = 'MOVING';

    const oldPos = player.position;
    const newPos = (oldPos + steps) % 40;

    const path: number[] = [];
    for (let s = 1; s <= steps; s++) {
      path.push((oldPos + s) % 40);
    }

    if (oldPos + steps >= 40) {
      player.cash += 200;
      this.broadcastGameEvent(
        `💵 ${player.name} đi qua ô Xuất Phát và nhận 200$ lương!`,
        '#10b981',
        'Xuất Phát'
      );
    }

    player.position = newPos;

    this.broadcastToRoom({
      type: 'PLAYER_MOVED',
      playerId: player.id,
      from: oldPos,
      to: newPos,
      path,
    });

    this.scheduleTimeout(() => {
      this.handleLanding(player, newPos, steps);
    }, 1000);
  }

  private handleLanding(player: Player, spaceId: number, diceTotal: number) {
    const space = MONOPOLY_SPACES[spaceId];
    if (!space || this.state.status !== 'playing') return;

    switch (space.type) {
      case 'property':
      case 'railroad':
      case 'utility': {
        const owner = this.state.players.find((p) =>
          p.properties.some((prop) => prop.spaceId === spaceId)
        );
        if (!owner) {
          this.broadcastGameEvent(
            `📍 ${player.name} dừng chân tại [${space.name}] (Giá: ${space.price}$).`,
            '#3b82f6',
            'Dừng Chân'
          );
          this.state.turnPhase = 'ACTION_DECISION';
          this.state.actionTimeLeft = 10;
          this.state.activeCardModal = {
            spaceId,
            canAct: true,
            forcedByLanding: true,
          };
          this.broadcastState();
          this.handleBotTurn();
        } else if (owner.id === player.id) {
          this.broadcastGameEvent(
            `🏠 ${player.name} thăm lại đất của mình tại [${space.name}].`,
            '#10b981',
            'Đất Nhà'
          );
          this.state.turnPhase = 'ACTION_DECISION';
          this.state.actionTimeLeft = 5;
          this.state.activeCardModal = {
            spaceId,
            canAct: false,
            forcedByLanding: true,
          };
          this.broadcastState();
          this.handleBotTurn();
        } else {
          const rent = calculateRent(spaceId, diceTotal, this.state);
          if (rent > 0) {
            player.cash -= rent;
            owner.cash += rent;
            this.broadcastGameEvent(
              `💸 ${player.name} phải trả ${rent}$ tiền thuê cho ${owner.name} tại [${space.name}]!`,
              '#ef4444',
              'Tiền Thuê'
            );
          }
          this.state.turnPhase = 'ACTION_DECISION';
          this.state.actionTimeLeft = 6;
          this.state.activeCardModal = {
            spaceId,
            canAct: false,
            forcedByLanding: true,
          };
          this.broadcastState();
          this.handleBotTurn();
        }
        break;
      }

      case 'tax': {
        const tax = space.taxAmount || 100;
        player.cash -= tax;
        this.broadcastGameEvent(`🏛️ ${player.name} nộp thuế nhà nước ${tax}$!`, '#ef4444', 'Thuế');
        this.checkBankruptcy(player);
        this.endPlayerTurn();
        break;
      }

      case 'go_to_jail': {
        this.sendPlayerToJail(player);
        break;
      }

      case 'chance':
      case 'chest': {
        this.drawCard(player, space.type);
        break;
      }

      case 'go': {
        this.broadcastGameEvent(`🚩 ${player.name} đã dừng đúng ô Xuất Phát!`, '#10b981', 'Xuất Phát');
        this.endPlayerTurn();
        break;
      }
      case 'jail': {
        this.broadcastGameEvent(`👀 ${player.name} chỉ ghé Thăm Tù Nhân.`, '#64748b', 'Thăm Tù');
        this.endPlayerTurn();
        break;
      }
      case 'free_parking': {
        this.broadcastGameEvent(`☕ ${player.name} đang dừng chân nghỉ ngơi thư giãn.`, '#10b981', 'Nghỉ Chân');
        this.endPlayerTurn();
        break;
      }
      default: {
        this.endPlayerTurn();
        break;
      }
    }
  }

  private drawCard(player: Player, cardType: 'chance' | 'chest') {
    const deck = cardType === 'chance' ? CHANCE_CARDS : CHEST_CARDS;
    const card = deck[Math.floor(Math.random() * deck.length)];
    this.state.drawnCard = card;

    const cardDesc = `🃏 [${cardType === 'chance' ? 'CƠ HỘI' : 'KHÍ VẬN'}] ${player.name} rút thẻ: "${card.title}" - ${card.description}`;
    this.state.history.unshift(cardDesc);
    this.broadcastToRoom({
      type: 'CHAT_MESSAGE',
      message: {
        id: `card_${Date.now()}_${Math.random()}`,
        senderId: 'system',
        senderName: cardType === 'chance' ? 'Thẻ Cơ Hội' : 'Thẻ Khí Vận',
        senderColor: cardType === 'chance' ? '#ea580c' : '#2563eb',
        text: `${player.name} rút "${card.title}": ${card.description}`,
        timestamp: Date.now(),
      },
    });

    this.scheduleTimeout(() => {
      if (this.state.status !== 'playing') return;
      switch (card.action) {
        case 'cash':
          if (card.amount) {
            player.cash += card.amount;
          }
          break;
        case 'move_to':
          if (card.targetSpace !== undefined) {
            player.position = card.targetSpace;
            if (card.targetSpace === 0) {
              player.cash += 200;
            }
          }
          break;
        case 'jail':
          this.sendPlayerToJail(player);
          return;
        case 'out_of_jail':
          player.getOutOfJailCards++;
          break;
        case 'repair': {
          const houseCount = player.properties.reduce((sum, p) => sum + p.houses, 0);
          const cost = houseCount * (card.amount || 25);
          player.cash -= cost;
          break;
        }
        case 'collect_from_all': {
          const amount = card.amount || 20;
          for (const other of this.state.players) {
            if (other.id !== player.id && !other.isBankrupt) {
              other.cash -= amount;
              player.cash += amount;
            }
          }
          break;
        }
      }

      this.state.drawnCard = null;
      this.checkBankruptcy(player);
      this.endPlayerTurn();
    }, 2500);

    this.broadcastState();
  }

  private buyProperty(playerId: string, spaceId: number) {
    const player = this.state.players.find((p) => p.id === playerId);
    const space = MONOPOLY_SPACES[spaceId];
    if (!player || !space || !space.price) return;

    const alreadyOwned = this.state.players.some((p) =>
      p.properties.some((pr) => pr.spaceId === spaceId)
    );
    if (alreadyOwned || player.cash < space.price) return;

    player.cash -= space.price;
    player.properties.push({
      spaceId,
      houses: 0,
      isMortgaged: false,
    });

    this.broadcastGameEvent(
      `🏡 ${player.name} đã mua ô [${space.name}] với giá ${space.price}$!`,
      '#10b981',
      'Mua Đất'
    );
    this.state.activeCardModal = null;
    this.state.turnPhase = 'MAIN_TURN';
    this.state.currentTurnTimeLeft = this.state.mainTurnTimeLeft;
    this.state.turnTimerMax = this.state.mainTurnTimerMax;
    this.broadcastState();
    this.handleBotTurn();
  }

  private passAction(playerId: string) {
    const currPlayer = this.state.players[this.state.currentPlayerIndex];
    if (!currPlayer || currPlayer.id !== playerId) return;

    const modal = this.state.activeCardModal;
    this.state.activeCardModal = null;

    if (modal && modal.canAct && modal.forcedByLanding) {
      const space = MONOPOLY_SPACES[modal.spaceId];
      const isOwned = this.state.players.some((p) =>
        p.properties.some((pr) => pr.spaceId === modal.spaceId)
      );
      if (space && space.price && !isOwned) {
        this.broadcastGameEvent(
          `🏷️ ${currPlayer.name} quyết định KHÔNG mua [${space.name}]. Chuyển sang Đấu Giá!`,
          '#eab308',
          'Đấu Giá'
        );
        this.startAuction(modal.spaceId);
        return;
      }
    }

    this.state.turnPhase = 'MAIN_TURN';
    this.state.currentTurnTimeLeft = this.state.mainTurnTimeLeft;
    this.state.turnTimerMax = this.state.mainTurnTimerMax;
    this.broadcastState();
    this.handleBotTurn();
  }

  private startAuction(spaceId: number) {
    const space = MONOPOLY_SPACES[spaceId];
    if (!space) {
      this.endPlayerTurn();
      return;
    }

    const eligiblePlayers = this.state.players.filter(
      (p) => !p.isBankrupt && !p.isDisconnected && !p.isQuit
    );
    if (eligiblePlayers.length === 0) {
      this.endPlayerTurn();
      return;
    }

    this.state.turnPhase = 'AUCTION';
    this.state.activeCardModal = null;
    this.state.auction = {
      spaceId,
      currentBid: 0,
      highestBidderId: null,
      highestBidderName: null,
      currentBidderId: eligiblePlayers[0].id,
      activeBidderIds: eligiblePlayers.map((p) => p.id),
      timeLeft: 10,
      timeMax: 10,
    };

    this.broadcastGameEvent(
      `🔨 Bắt đầu phiên đấu giá [${space.name}] (Giá gốc: ${space.price}$)! Lượt chào giá của ${eligiblePlayers[0].name}.`,
      '#eab308',
      'Đấu Giá'
    );
    this.broadcastState();
    this.handleBotAuctionTurn();
  }

  private placeBid(playerId: string, amount: number) {
    if (this.state.turnPhase !== 'AUCTION' || !this.state.auction) return;
    if (this.state.auction.currentBidderId !== playerId) return;

    const player = this.state.players.find((p) => p.id === playerId);
    if (!player || player.cash < amount || amount <= this.state.auction.currentBid) return;

    this.state.auction.currentBid = amount;
    this.state.auction.highestBidderId = player.id;
    this.state.auction.highestBidderName = player.name;

    const space = MONOPOLY_SPACES[this.state.auction.spaceId];
    this.broadcastGameEvent(
      `💰 ${player.name} đặt giá ${amount}$ cho [${space?.name || 'khu đất'}]!`,
      '#eab308',
      'Đấu Giá'
    );

    this.advanceAuctionBidder();
  }

  private passBid(playerId: string) {
    if (this.state.turnPhase !== 'AUCTION' || !this.state.auction) return;
    if (this.state.auction.currentBidderId !== playerId) return;

    const player = this.state.players.find((p) => p.id === playerId);
    if (player) {
      this.broadcastGameEvent(`❌ ${player.name} đã bỏ qua không chào giá.`, '#64748b', 'Đấu Giá');
    }

    this.state.auction.activeBidderIds = this.state.auction.activeBidderIds.filter(
      (id) => id !== playerId
    );

    const remaining = this.state.auction.activeBidderIds;
    if (
      remaining.length === 0 ||
      (remaining.length === 1 && remaining[0] === this.state.auction.highestBidderId)
    ) {
      this.finishAuction();
      return;
    }

    this.advanceAuctionBidder();
  }

  private advanceAuctionBidder() {
    if (!this.state.auction) return;
    const remaining = this.state.auction.activeBidderIds;
    if (remaining.length === 0) {
      this.finishAuction();
      return;
    }

    const currIdx = remaining.indexOf(this.state.auction.currentBidderId);
    const nextIdx = (currIdx + 1) % remaining.length;
    this.state.auction.currentBidderId = remaining[nextIdx];
    this.state.auction.timeLeft = 10;

    this.broadcastState();
    this.handleBotAuctionTurn();
  }

  private finishAuction() {
    if (!this.state.auction) return;
    const { spaceId, currentBid, highestBidderId } = this.state.auction;
    const space = MONOPOLY_SPACES[spaceId];

    if (highestBidderId && currentBid > 0) {
      const winner = this.state.players.find((p) => p.id === highestBidderId);
      if (winner && space) {
        winner.cash -= currentBid;
        winner.properties.push({
          spaceId,
          houses: 0,
          isMortgaged: false,
        });
        this.broadcastGameEvent(
          `🏆 ${winner.name} đã thắng đấu giá [${space.name}] với giá ${currentBid}$!`,
          '#10b981',
          'Đấu Giá'
        );
      }
    } else {
      this.broadcastGameEvent(
        `⚠️ Không ai mua [${space?.name || 'khu đất'}] trong phiên đấu giá.`,
        '#64748b',
        'Đấu Giá'
      );
    }

    this.state.auction = null;
    this.state.turnPhase = 'RESOLVING';
    this.broadcastState();

    this.scheduleTimeout(() => {
      this.endPlayerTurn();
    }, 1500);
  }

  private handleBotAuctionTurn() {
    if (this.state.turnPhase !== 'AUCTION' || !this.state.auction) return;

    const currentBidder = this.state.players.find(
      (p) => p.id === this.state.auction?.currentBidderId
    );
    if (!currentBidder || !currentBidder.isBot || currentBidder.isBankrupt) return;

    if (this.botTimeout) clearTimeout(this.botTimeout);
    this.botTimeout = setTimeout(() => {
      if (
        this.isDestroyed ||
        !this.state.auction ||
        this.state.auction.currentBidderId !== currentBidder.id
      ) {
        return;
      }
      const space = MONOPOLY_SPACES[this.state.auction.spaceId];
      const minBid = this.state.auction.currentBid + 10;
      const maxBotBid = (space?.price || 200) * 0.85;

      if (minBid <= maxBotBid && currentBidder.cash >= minBid + 150) {
        this.placeBid(currentBidder.id, minBid);
      } else {
        this.passBid(currentBidder.id);
      }
    }, 1400);
  }

  private upgradeProperty(playerId: string, spaceId: number) {
    const player = this.state.players.find((p) => p.id === playerId);
    const space = MONOPOLY_SPACES[spaceId];
    if (!player || !space || !space.houseCost) return;

    const prop = player.properties.find((p) => p.spaceId === spaceId);
    if (!prop || prop.isMortgaged || prop.houses >= 5 || player.cash < space.houseCost) return;

    const groupSpaces = COLOR_GROUPS[space.colorGroup] || [];
    const ownsAll = groupSpaces.every((sId) =>
      player.properties.some((p) => p.spaceId === sId && !p.isMortgaged)
    );
    if (!ownsAll) return;

    player.cash -= space.houseCost;
    prop.houses += 1;

    const typeName = prop.houses === 5 ? 'Khách sạn ⭐' : `Nhà cấp ${prop.houses} 🏠`;
    this.broadcastGameEvent(
      `🏗️ ${player.name} nâng cấp [${space.name}] lên ${typeName}!`,
      '#f59e0b',
      'Xây Dựng'
    );
    this.broadcastState();
  }

  private mortgageProperty(playerId: string, spaceId: number) {
    const player = this.state.players.find((p) => p.id === playerId);
    const space = MONOPOLY_SPACES[spaceId];
    if (!player || !space || !space.mortgageValue) return;

    const prop = player.properties.find((p) => p.spaceId === spaceId);
    if (!prop || prop.isMortgaged || prop.houses > 0) return;

    prop.isMortgaged = true;
    player.cash += space.mortgageValue;
    this.broadcastGameEvent(
      `📜 ${player.name} đã thế chấp [${space.name}] nhận ${space.mortgageValue}$.`,
      '#f97316',
      'Cầm Cố'
    );
    this.broadcastState();
  }

  private unmortgageProperty(playerId: string, spaceId: number) {
    const player = this.state.players.find((p) => p.id === playerId);
    const space = MONOPOLY_SPACES[spaceId];
    if (!player || !space || !space.mortgageValue) return;

    const prop = player.properties.find((p) => p.spaceId === spaceId);
    const cost = Math.round(space.mortgageValue * 1.1);
    if (!prop || !prop.isMortgaged || player.cash < cost) return;

    prop.isMortgaged = false;
    player.cash -= cost;
    this.broadcastGameEvent(
      `🔓 ${player.name} đã chuộc lại [${space.name}] với chi phí ${cost}$.`,
      '#10b981',
      'Chuộc Đất'
    );
    this.broadcastState();
  }

  private payJailFine(playerId: string) {
    const player = this.state.players.find((p) => p.id === playerId);
    if (!player || !player.inJail || player.cash < 50) return;

    player.cash -= 50;
    player.inJail = false;
    player.jailTurns = 0;
    this.broadcastGameEvent(`💸 ${player.name} nộp phạt 50$ để rời khỏi tù.`, '#10b981', 'Ra Tù');
    this.broadcastState();
  }

  private useJailCard(playerId: string) {
    const player = this.state.players.find((p) => p.id === playerId);
    if (!player || !player.inJail || player.getOutOfJailCards <= 0) return;

    player.getOutOfJailCards--;
    player.inJail = false;
    player.jailTurns = 0;
    this.broadcastGameEvent(`🎫 ${player.name} sử dụng Thẻ Ra Tù Miễn Phí.`, '#10b981', 'Ra Tù');
    this.broadcastState();
  }

  private checkBankruptcy(player: Player) {
    if (player.cash >= 0) return;

    const totalAssets = player.properties.reduce((sum, prop) => {
      const s = MONOPOLY_SPACES[prop.spaceId];
      return sum + (s?.mortgageValue || 0);
    }, player.cash);

    if (totalAssets < 0) {
      this.declareBankruptcy(player.id);
    }
  }

  private declareBankruptcy(playerId: string) {
    const player = this.state.players.find((p) => p.id === playerId);
    if (!player || player.isBankrupt) return;

    player.isBankrupt = true;
    player.properties = [];
    player.cash = 0;
    this.broadcastGameEvent(
      `💥 ${player.name} ĐÃ PHÁ SẢN VÀ RỜI KHỎI VÁN ĐẤU!`,
      '#dc2626',
      'Phá Sản'
    );

    if (this.checkRemainingActivePlayers()) return;
    this.endPlayerTurn();
  }

  private endPlayerTurn() {
    if (this.checkGameEndConditions()) return;

    const curr = this.state.players[this.state.currentPlayerIndex];
    if (
      this.state.dice.isDouble &&
      this.state.dice.rollCount > 0 &&
      curr &&
      !curr.inJail &&
      !curr.isBankrupt &&
      !curr.isDisconnected &&
      !curr.isQuit
    ) {
      this.state.turnPhase = 'ROLL_DICE';
      this.state.rollDiceTimeLeft = 8;
      this.state.rollDiceTimerMax = 8;
      this.state.mainTurnTimeLeft = this.state.mainTurnTimerMax;
      this.state.actionTimeLeft = 10;
      this.state.actionTimerMax = 10;
      this.state.currentTurnTimeLeft = 8;
      this.state.turnTimerMax = 8;
      this.state.activeCardModal = null;
      this.broadcastState();
      this.handleBotTurn();
      return;
    }

    this.state.dice.rollCount = 0;
    let nextIdx = (this.state.currentPlayerIndex + 1) % this.state.players.length;
    let loops = 0;
    while (
      (this.state.players[nextIdx]?.isBankrupt ||
        this.state.players[nextIdx]?.isDisconnected ||
        this.state.players[nextIdx]?.isQuit) &&
      loops < this.state.players.length
    ) {
      nextIdx = (nextIdx + 1) % this.state.players.length;
      loops++;
    }

    if (this.checkRemainingActivePlayers()) return;

    this.state.currentPlayerIndex = nextIdx;
    this.state.turnPhase = 'ROLL_DICE';
    this.state.rollDiceTimeLeft = 8;
    this.state.rollDiceTimerMax = 8;
    this.state.mainTurnTimeLeft = this.state.mainTurnTimerMax;
    this.state.actionTimeLeft = 10;
    this.state.actionTimerMax = 10;
    this.state.currentTurnTimeLeft = 8;
    this.state.turnTimerMax = 8;
    this.state.activeCardModal = null;

    const nextPlayer = this.state.players[nextIdx];
    if (nextPlayer) {
      this.broadcastGameEvent(
        `👉 Đến lượt của ${nextPlayer.name}!`,
        nextPlayer.color || '#3b82f6',
        'Chuyển Lượt'
      );
    }

    this.broadcastState();
    this.handleBotTurn();
  }
}
