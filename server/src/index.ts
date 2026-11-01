import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createServer } from "http";
import { Server, Socket } from "socket.io";

import { getRandomWord } from "./game/wordBank";
import {
  createRoom,
  joinRoom,
  getRoom,
  removePlayerFromRoom,
  setPlayerReady,
} from "./game/roomManager";

dotenv.config();

const app = express();
const httpServer = createServer(app);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:3000";

app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json());

const io = new Server(httpServer, {
  cors: { origin: CLIENT_ORIGIN, methods: ["GET", "POST"] },
});

interface ActiveRound {
  secretWord: string;
  impostorId: string;
  impostorClue: string;
}

interface ChatMessage {
  id: string;
  playerId: string;
  playerName: string;
  message: string;
  timestamp: number;
}

interface VoteResult {
  playerId: string;
  playerName: string;
  voteCount: number;
}

interface ScoreEntry {
  playerId: string;
  playerName: string;
  score: number;
}

interface MatchState {
  roundNumber: number;
  maxRounds: number;
  scores: Map<string, ScoreEntry>;
  previousImpostorId: string | null;
  awaitingGuess: boolean;
  roundFinished: boolean;
  finalGuessResolved: boolean;
}

type Ack = (response: { success: boolean; message?: string }) => void;

const activeRounds = new Map<string, ActiveRound>();
const matches = new Map<string, MatchState>();
const discussionTimers = new Map<string, NodeJS.Timeout>();
const votingTimers = new Map<string, NodeJS.Timeout>();
const guessTimers = new Map<string, NodeJS.Timeout>();
const chatMessages = new Map<string, ChatMessage[]>();
const lastChatAt = new Map<string, number>();
const roomVotes = new Map<string, Map<string, string>>();
const revoteCandidates = new Map<string, string[]>();

const DISCUSSION_DURATION = 60;
const VOTING_DURATION = 30;
const REVOTE_DURATION = 15;
const GUESS_DURATION = 30;
const MAX_ROUNDS = 5;

app.get("/api/health", (_req, res) => {
  res.json({ success: true, message: "FIND THE IMPOSTOR server is running!" });
});

function emitRoomUpdate(roomCode: string) {
  const room = getRoom(roomCode);
  if (!room) return;
  io.to(roomCode).emit("room:updated", {
    code: room.code,
    players: room.players,
  });
}

function clearTimer(map: Map<string, NodeJS.Timeout>, roomCode: string) {
  const timer = map.get(roomCode);
  if (timer) clearInterval(timer);
  map.delete(roomCode);
}

function cleanupRoom(roomCode: string) {
  clearTimer(discussionTimers, roomCode);
  clearTimer(votingTimers, roomCode);
  clearTimer(guessTimers, roomCode);
  activeRounds.delete(roomCode);
  matches.delete(roomCode);
  chatMessages.delete(roomCode);
  roomVotes.delete(roomCode);
  revoteCandidates.delete(roomCode);
}

function getScoreboard(roomCode: string): ScoreEntry[] {
  const match = matches.get(roomCode);
  if (!match) return [];
  return [...match.scores.values()].sort(
    (a, b) => b.score - a.score || a.playerName.localeCompare(b.playerName),
  );
}

function addPoints(roomCode: string, playerId: string, points: number) {
  const match = matches.get(roomCode);
  if (!match) return;

  const entry = match.scores.get(playerId);
  if (entry) entry.score += points;
}

function finishRound(roomCode: string) {
  const match = matches.get(roomCode);
  if (!match || match.roundFinished) return;

  match.awaitingGuess = false;
  match.roundFinished = true;
  clearTimer(guessTimers, roomCode);

  io.to(roomCode).emit("round:scoreboard", {
    roundNumber: match.roundNumber,
    maxRounds: match.maxRounds,
    scores: getScoreboard(roomCode),
    isFinalRound: match.roundNumber >= match.maxRounds,
  });
}

function broadcastVoteProgress(roomCode: string) {
  const room = getRoom(roomCode);
  const votes = roomVotes.get(roomCode);
  if (!room || !votes) return;

  io.to(roomCode).emit("vote:progress", {
    submitted: votes.size,
    total: room.players.length,
  });
}

function startVotingTimer(
  roomCode: string,
  duration: number,
  isRevote: boolean,
) {
  clearTimer(votingTimers, roomCode);
  const endAt = Date.now() + duration * 1000;

  const timer = setInterval(() => {
    const remainingSeconds = Math.max(
      0,
      Math.ceil((endAt - Date.now()) / 1000),
    );

    io.to(roomCode).emit("vote:timer", { remainingSeconds, isRevote });

    if (remainingSeconds <= 0) {
      clearTimer(votingTimers, roomCode);
      finishVoting(roomCode, isRevote);
    }
  }, 1000);

  votingTimers.set(roomCode, timer);
}

function startGuessTimer(roomCode: string) {
  clearTimer(guessTimers, roomCode);
  const endAt = Date.now() + GUESS_DURATION * 1000;

  const timer = setInterval(() => {
    const remainingSeconds = Math.max(
      0,
      Math.ceil((endAt - Date.now()) / 1000),
    );

    io.to(roomCode).emit("guess:timer", { remainingSeconds });

    if (remainingSeconds <= 0) {
      clearTimer(guessTimers, roomCode);
      const match = matches.get(roomCode);
      if (!match || !match.awaitingGuess) return;

      match.awaitingGuess = false;
      match.finalGuessResolved = true;
      io.to(roomCode).emit("guess:result", {
        correct: false,
        reason: "timeout",
      });
      finishRound(roomCode);
    }
  }, 1000);

  guessTimers.set(roomCode, timer);
}

function startDiscussionTimer(roomCode: string) {
  clearTimer(discussionTimers, roomCode);
  const endAt = Date.now() + DISCUSSION_DURATION * 1000;

  io.to(roomCode).emit("discussion:started", {
    duration: DISCUSSION_DURATION,
  });

  const timer = setInterval(() => {
    const remainingSeconds = Math.max(
      0,
      Math.ceil((endAt - Date.now()) / 1000),
    );

    io.to(roomCode).emit("discussion:timer", { remainingSeconds });

    if (remainingSeconds <= 0) {
      clearTimer(discussionTimers, roomCode);
      const room = getRoom(roomCode);
      if (room?.status === "discussion") startVoting(roomCode);
    }
  }, 1000);

  discussionTimers.set(roomCode, timer);
}

function startVoting(roomCode: string) {
  const room = getRoom(roomCode);
  if (!room || room.status !== "discussion") return;

  room.status = "voting";
  roomVotes.set(roomCode, new Map());
  revoteCandidates.delete(roomCode);

  io.to(roomCode).emit("discussion:ended");
  io.to(roomCode).emit("vote:started", {
    duration: VOTING_DURATION,
    players: room.players.map(({ id, name }) => ({ id, name })),
  });

  broadcastVoteProgress(roomCode);
  startVotingTimer(roomCode, VOTING_DURATION, false);
  emitRoomUpdate(roomCode);
}

function finishVoting(roomCode: string, isRevote: boolean) {
  const room = getRoom(roomCode);
  const round = activeRounds.get(roomCode);
  const match = matches.get(roomCode);
  const votes = roomVotes.get(roomCode);

  if (!room || !round || !match || !votes || match.roundFinished) return;

  clearTimer(votingTimers, roomCode);

  const counts = new Map<string, number>();
  votes.forEach((targetId) => {
    counts.set(targetId, (counts.get(targetId) || 0) + 1);
  });

  const results: VoteResult[] = room.players
    .filter((player) => counts.has(player.id))
    .map((player) => ({
      playerId: player.id,
      playerName: player.name,
      voteCount: counts.get(player.id) || 0,
    }))
    .sort((a, b) => b.voteCount - a.voteCount);

  if (results.length === 0) {
    io.to(roomCode).emit("vote:result", {
      outcome: "impostor_escaped",
      reason: "no_votes",
      results: [],
    });
    addPoints(roomCode, round.impostorId, 4);
    roomVotes.delete(roomCode);
    revoteCandidates.delete(roomCode);
    finishRound(roomCode);
    return;
  }

  const highest = results[0].voteCount;
  const tied = results.filter((result) => result.voteCount === highest);

  if (tied.length > 1 && !isRevote) {
    const candidateIds = tied.map((item) => item.playerId);
    revoteCandidates.set(roomCode, candidateIds);
    roomVotes.set(roomCode, new Map());

    io.to(roomCode).emit("vote:revote:start", {
      duration: REVOTE_DURATION,
      candidateIds,
      candidateNames: tied.map((item) => item.playerName),
    });

    broadcastVoteProgress(roomCode);
    startVotingTimer(roomCode, REVOTE_DURATION, true);
    return;
  }

  if (tied.length > 1) {
    io.to(roomCode).emit("vote:result", {
      outcome: "impostor_escaped",
      reason: "revote_tie",
      results,
    });
    addPoints(roomCode, round.impostorId, 4);
    roomVotes.delete(roomCode);
    revoteCandidates.delete(roomCode);
    finishRound(roomCode);
    return;
  }

  const eliminated = tied[0];
  const caught = eliminated.playerId === round.impostorId;

  io.to(roomCode).emit("vote:result", {
    outcome: caught ? "impostor_caught" : "impostor_escaped",
    reason: "vote_completed",
    eliminatedPlayerId: eliminated.playerId,
    eliminatedPlayerName: eliminated.playerName,
    results,
  });

  roomVotes.delete(roomCode);
  revoteCandidates.delete(roomCode);

  if (!caught) {
    addPoints(roomCode, round.impostorId, 4);
    finishRound(roomCode);
    return;
  }

  // A correct vote earns +2. Votes remain private; only the score changes.
  votes.forEach((targetId, voterId) => {
    if (targetId === round.impostorId) addPoints(roomCode, voterId, 2);
  });

  match.awaitingGuess = true;
  match.finalGuessResolved = false;

  io.to(roomCode).emit("guess:started", {
    impostorName: eliminated.playerName,
    duration: GUESS_DURATION,
  });

  io.to(round.impostorId).emit("guess:prompt", {
    duration: GUESS_DURATION,
  });

  startGuessTimer(roomCode);
}

function startRound(roomCode: string, roundNumber: number) {
  const room = getRoom(roomCode);
  const match = matches.get(roomCode);
  if (!room || !match || room.players.length < 2) return;

  const wordEntry = getRandomWord();
  const alternatives = room.players.filter(
    (player) => player.id !== match.previousImpostorId,
  );
  const pool = alternatives.length ? alternatives : room.players;
  const impostor = pool[Math.floor(Math.random() * pool.length)];

  match.roundNumber = roundNumber;
  match.previousImpostorId = impostor.id;
  match.awaitingGuess = false;
  match.roundFinished = false;
  match.finalGuessResolved = false;

  activeRounds.set(roomCode, {
    secretWord: wordEntry.word,
    impostorId: impostor.id,
    impostorClue: wordEntry.impostorClue,
  });

  room.status = "discussion";
  chatMessages.set(roomCode, []);
  roomVotes.delete(roomCode);
  revoteCandidates.delete(roomCode);

  io.to(roomCode).emit("round:started", {
    roundNumber,
    maxRounds: match.maxRounds,
  });

  room.players.forEach((player) => {
    const isImpostor = player.id === impostor.id;
    io.to(player.id).emit("role:reveal", {
      role: isImpostor ? "impostor" : "regular",
      secretWord: isImpostor ? null : wordEntry.word,
      clue: isImpostor ? wordEntry.impostorClue : null,
    });
  });

  startDiscussionTimer(roomCode);
  emitRoomUpdate(roomCode);
}

function startMatch(roomCode: string) {
  const room = getRoom(roomCode);
  if (!room) return;

  matches.set(roomCode, {
    roundNumber: 0,
    maxRounds: MAX_ROUNDS,
    scores: new Map(
      room.players.map((player) => [
        player.id,
        { playerId: player.id, playerName: player.name, score: 0 },
      ]),
    ),
    previousImpostorId: null,
    awaitingGuess: false,
    roundFinished: false,
    finalGuessResolved: false,
  });

  startRound(roomCode, 1);
}

function startNextRound(roomCode: string) {
  const match = matches.get(roomCode);
  if (!match) return;

  if (match.roundNumber >= match.maxRounds) {
    io.to(roomCode).emit("game:finished", {
      scores: getScoreboard(roomCode),
    });
    return;
  }

  startRound(roomCode, match.roundNumber + 1);
}

function isRoomHost(roomCode: string, playerId: string): boolean {
  const room = getRoom(roomCode);
  return Boolean(
    room?.players.some((player) => player.id === playerId && player.isHost),
  );
}

function detachPlayer(socket: Socket, roomCode: string) {
  const updatedRoom = removePlayerFromRoom(roomCode, socket.id);
  socket.leave(roomCode);
  delete socket.data.roomCode;
  lastChatAt.delete(socket.id);

  if (!updatedRoom) {
    cleanupRoom(roomCode);
    io.to(roomCode).emit("room:closed");
    return;
  }

  // A running match cannot safely continue with changed player membership.
  if (matches.has(roomCode)) {
    io.to(roomCode).emit("game:aborted", {
      message: "A player left. The match has been stopped.",
    });
    cleanupRoom(roomCode);
    updatedRoom.status = "lobby";
    updatedRoom.players.forEach((player) => {
      player.isReady = player.id === updatedRoom.players[0].id;
    });
  }

  emitRoomUpdate(roomCode);
}

io.on("connection", (socket) => {
  console.log("Player connected:", socket.id);

  socket.on("room:create", async (data, callback: Ack) => {
    const playerName = String(data?.playerName || "").trim();

    if (!playerName || playerName.length > 16) {
      return callback?.({
        success: false,
        message: "Enter a name (1–16 characters).",
      });
    }
    if (socket.data.roomCode) {
      return callback?.({
        success: false,
        message: "You are already in a room.",
      });
    }

    const room = createRoom(socket.id, playerName);
    await socket.join(room.code);
    socket.data.roomCode = room.code;

    callback?.({ success: true });
    socket.emit("room:joined", {
      roomCode: room.code,
      playerId: socket.id,
      players: room.players,
    });
    emitRoomUpdate(room.code);
  });

  socket.on("room:join", async (data, callback: Ack) => {
    const playerName = String(data?.playerName || "").trim();
    const roomCode = String(data?.roomCode || "")
      .trim()
      .toUpperCase();

    if (!playerName || playerName.length > 16) {
      return callback?.({
        success: false,
        message: "Enter a name (1–16 characters).",
      });
    }
    if (!/^[A-Z0-9]{6}$/.test(roomCode)) {
      return callback?.({
        success: false,
        message: "Enter a valid six-character room code.",
      });
    }
    if (socket.data.roomCode) {
      return callback?.({
        success: false,
        message: "You are already in a room.",
      });
    }

    const result = joinRoom(roomCode, socket.id, playerName);
    if (!result.success || !result.room) {
      return callback?.({
        success: false,
        message: result.message || "Unable to join.",
      });
    }

    await socket.join(roomCode);
    socket.data.roomCode = roomCode;
    callback?.({ success: true });
    socket.emit("room:joined", {
      roomCode,
      playerId: socket.id,
      players: result.room.players,
    });
    emitRoomUpdate(roomCode);
  });

  socket.on("game:start", (callback: Ack) => {
    const roomCode = socket.data.roomCode as string | undefined;
    const room = roomCode ? getRoom(roomCode) : undefined;

    if (!roomCode || !room)
      return callback?.({ success: false, message: "Room not found." });
    if (!isRoomHost(roomCode, socket.id)) {
      return callback?.({
        success: false,
        message: "Only the host can start.",
      });
    }
    if (room.status !== "lobby" || matches.has(roomCode)) {
      return callback?.({
        success: false,
        message: "The game has already started.",
      });
    }
    if (room.players.length < 2) {
      return callback?.({
        success: false,
        message: "At least 2 players are required.",
      });
    }
    if (!room.players.every((player) => player.isReady)) {
      return callback?.({
        success: false,
        message: "All players must be ready.",
      });
    }

    startMatch(roomCode);
    callback?.({ success: true });
  });

  socket.on("player:ready", (data, callback: Ack) => {
    const roomCode = socket.data.roomCode as string | undefined;
    if (!roomCode)
      return callback?.({ success: false, message: "You are not in a room." });

    const isReady = data?.isReady;
    if (typeof isReady !== "boolean") {
      return callback?.({ success: false, message: "Invalid ready status." });
    }

    const room = setPlayerReady(roomCode, socket.id, isReady);
    if (!room)
      return callback?.({
        success: false,
        message: "Ready status cannot be changed now.",
      });

    callback?.({ success: true });
    emitRoomUpdate(roomCode);
  });

  socket.on("chat:send", (data, callback: Ack) => {
    const roomCode = socket.data.roomCode as string | undefined;
    const room = roomCode ? getRoom(roomCode) : undefined;

    if (!roomCode || !room || room.status !== "discussion") {
      return callback?.({
        success: false,
        message: "Chat is only available during discussion.",
      });
    }

    const player = room.players.find((item) => item.id === socket.id);
    const message = String(data?.message || "").trim();

    if (!player)
      return callback?.({ success: false, message: "Player not found." });
    if (!message || message.length > 300) {
      return callback?.({
        success: false,
        message: "Message must contain 1–300 characters.",
      });
    }

    const now = Date.now();
    if (now - (lastChatAt.get(socket.id) || 0) < 800) {
      return callback?.({
        success: false,
        message: "Please wait before sending another message.",
      });
    }

    lastChatAt.set(socket.id, now);
    const chatMessage: ChatMessage = {
      id: `${socket.id}-${now}`,
      playerId: socket.id,
      playerName: player.name,
      message,
      timestamp: now,
    };

    const messages = chatMessages.get(roomCode) || [];
    messages.push(chatMessage);
    chatMessages.set(roomCode, messages.slice(-100));
    io.to(roomCode).emit("chat:message", chatMessage);
    callback?.({ success: true });
  });

  socket.on("vote:cast", (data, callback: Ack) => {
    const roomCode = socket.data.roomCode as string | undefined;
    const room = roomCode ? getRoom(roomCode) : undefined;
    const votes = roomCode ? roomVotes.get(roomCode) : undefined;

    if (!roomCode || !room || room.status !== "voting" || !votes) {
      return callback?.({ success: false, message: "Voting is not active." });
    }

    const targetId = String(data?.targetId || "");
    if (!room.players.some((player) => player.id === socket.id)) {
      return callback?.({
        success: false,
        message: "You are not in this room.",
      });
    }
    if (targetId === socket.id) {
      return callback?.({
        success: false,
        message: "You cannot vote for yourself.",
      });
    }
    if (!room.players.some((player) => player.id === targetId)) {
      return callback?.({
        success: false,
        message: "Invalid player selection.",
      });
    }
    if (votes.has(socket.id)) {
      return callback?.({ success: false, message: "You have already voted." });
    }

    const candidates = revoteCandidates.get(roomCode);
    if (candidates && !candidates.includes(targetId)) {
      return callback?.({
        success: false,
        message: "You can only vote for a tied player.",
      });
    }

    votes.set(socket.id, targetId);
    callback?.({ success: true });
    broadcastVoteProgress(roomCode);

    if (votes.size >= room.players.length) {
      finishVoting(roomCode, Boolean(candidates));
    }
  });

  socket.on("guess:submit", (data, callback: Ack) => {
    const roomCode = socket.data.roomCode as string | undefined;
    const match = roomCode ? matches.get(roomCode) : undefined;
    const round = roomCode ? activeRounds.get(roomCode) : undefined;

    if (!roomCode || !match || !round || !match.awaitingGuess) {
      return callback?.({
        success: false,
        message: "The guessing phase is not active.",
      });
    }
    if (socket.id !== round.impostorId) {
      return callback?.({
        success: false,
        message: "Only the Impostor can guess.",
      });
    }

    const guess = String(data?.guess || "").trim();
    if (!guess || guess.length > 60) {
      return callback?.({
        success: false,
        message: "Enter a guess (1–60 characters).",
      });
    }

    match.awaitingGuess = false;
    match.finalGuessResolved = true;
    clearTimer(guessTimers, roomCode);

    const correct =
      guess.localeCompare(round.secretWord.trim(), undefined, {
        sensitivity: "accent",
      }) === 0;

    if (correct) addPoints(roomCode, socket.id, 2);

    io.to(roomCode).emit("guess:result", {
      correct,
      answer: round.secretWord,
      reason: "submitted",
    });

    callback?.({ success: true });
    finishRound(roomCode);
  });

  socket.on("round:next", (callback: Ack) => {
    const roomCode = socket.data.roomCode as string | undefined;
    const match = roomCode ? matches.get(roomCode) : undefined;

    if (!roomCode || !match || !match.roundFinished) {
      return callback?.({
        success: false,
        message: "The current round is not finished.",
      });
    }
    if (!isRoomHost(roomCode, socket.id)) {
      return callback?.({
        success: false,
        message: "Only the host can continue.",
      });
    }

    if (match.roundNumber >= match.maxRounds) {
      io.to(roomCode).emit("game:finished", {
        scores: getScoreboard(roomCode),
      });
      callback?.({ success: true });
      return;
    }

    startNextRound(roomCode);
    callback?.({ success: true });
  });

  socket.on("room:leave", (callback: Ack) => {
    const roomCode = socket.data.roomCode as string | undefined;
    if (!roomCode)
      return callback?.({ success: false, message: "You are not in a room." });

    detachPlayer(socket, roomCode);
    callback?.({ success: true });
  });

  socket.on("disconnect", () => {
    const roomCode = socket.data.roomCode as string | undefined;
    if (roomCode) detachPlayer(socket, roomCode);
    console.log("Player disconnected:", socket.id);
  });
});

const PORT = Number(process.env.PORT) || 4000;
httpServer.listen(PORT, () => {
  console.log(`Game server running at http://localhost:${PORT}`);
});
