export interface RoomPlayer {
  id: string;
  name: string;
  isHost: boolean;
  isReady: boolean;
}

export type RoomStatus = "lobby" | "discussion" | "voting";

export interface GameRoom {
  code: string;
  players: RoomPlayer[];
  createdAt: number;
  status: RoomStatus;
}

const rooms = new Map<string, GameRoom>();

function generateRoomCode(): string {
  const characters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";

  do {
    code = Array.from(
      { length: 6 },
      () => characters[Math.floor(Math.random() * characters.length)],
    ).join("");
  } while (rooms.has(code));

  return code;
}

export function createRoom(playerId: string, playerName: string): GameRoom {
  const code = generateRoomCode();

  const room: GameRoom = {
    code,
    players: [{ id: playerId, name: playerName, isHost: true, isReady: true }],
    createdAt: Date.now(),
    status: "lobby",
  };

  rooms.set(code, room);
  return room;
}

export function joinRoom(
  code: string,
  playerId: string,
  playerName: string,
): { success: boolean; room?: GameRoom; message?: string } {
  const normalizedCode = code.trim().toUpperCase();
  const room = rooms.get(normalizedCode);

  if (!room) return { success: false, message: "Room not found." };
  if (room.status !== "lobby") {
    return { success: false, message: "This game has already started." };
  }
  if (room.players.length >= 4) {
    return { success: false, message: "This room is full." };
  }
  if (room.players.some((player) => player.id === playerId)) {
    return { success: false, message: "You are already in this room." };
  }

  room.players.push({
    id: playerId,
    name: playerName,
    isHost: false,
    isReady: false,
  });

  return { success: true, room };
}

export function getRoom(code: string): GameRoom | undefined {
  return rooms.get(code.trim().toUpperCase());
}

export function removePlayerFromRoom(
  code: string,
  playerId: string,
): GameRoom | null {
  const normalizedCode = code.trim().toUpperCase();
  const room = rooms.get(normalizedCode);
  if (!room) return null;

  room.players = room.players.filter((player) => player.id !== playerId);

  if (room.players.length === 0) {
    rooms.delete(normalizedCode);
    return null;
  }

  if (!room.players.some((player) => player.isHost)) {
    room.players[0].isHost = true;
  }

  return room;
}

export function setPlayerReady(
  code: string,
  playerId: string,
  isReady: boolean,
): GameRoom | null {
  const room = getRoom(code);
  if (!room || room.status !== "lobby") return null;

  const player = room.players.find((item) => item.id === playerId);
  if (!player) return null;

  player.isReady = isReady;
  return room;
}

export function deleteRoom(code: string): void {
  rooms.delete(code.trim().toUpperCase());
}
