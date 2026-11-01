"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { socket } from "@/lib/socket";

interface RoomPlayer {
  id: string;
  name: string;
  isHost: boolean;
  isReady: boolean;
}

interface RoomState {
  code: string;
  players: RoomPlayer[];
}

interface RoleInfo {
  role: "impostor" | "regular";
  secretWord: string | null;
  clue: string | null;
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

interface VotingResult {
  outcome: "impostor_caught" | "impostor_escaped";
  reason: string;
  eliminatedPlayerId?: string;
  eliminatedPlayerName?: string;
  results: VoteResult[];
}

interface ScoreEntry {
  playerId: string;
  playerName: string;
  score: number;
}

type GamePhase =
  | "home"
  | "lobby"
  | "discussion"
  | "voting"
  | "revote"
  | "result"
  | "guess"
  | "scoreboard"
  | "finished";

const initialProgress = { submitted: 0, total: 0 };

export default function Home() {
  const [phase, setPhase] = useState<GamePhase>("home");
  const [playerName, setPlayerName] = useState("");
  const [roomCodeInput, setRoomCodeInput] = useState("");
  const [room, setRoom] = useState<RoomState | null>(null);
  const [roleInfo, setRoleInfo] = useState<RoleInfo | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const [remainingSeconds, setRemainingSeconds] = useState(60);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messageInput, setMessageInput] = useState("");
  const [chatError, setChatError] = useState("");

  const [selectedPlayer, setSelectedPlayer] = useState("");
  const [hasVoted, setHasVoted] = useState(false);
  const [voteSubmitting, setVoteSubmitting] = useState(false);
  const [voteError, setVoteError] = useState("");
  const [voteProgress, setVoteProgress] = useState(initialProgress);
  const [voteCandidates, setVoteCandidates] = useState<string[]>([]);
  const [voteResult, setVoteResult] = useState<VotingResult | null>(null);

  const [roundNumber, setRoundNumber] = useState(1);
  const [maxRounds, setMaxRounds] = useState(5);
  const [scoreboard, setScoreboard] = useState<ScoreEntry[]>([]);
  const [isFinalRound, setIsFinalRound] = useState(false);

  const [guessInput, setGuessInput] = useState("");
  const [guessAllowed, setGuessAllowed] = useState(false);
  const [guessSubmitting, setGuessSubmitting] = useState(false);
  const [guessError, setGuessError] = useState("");
  const [guessResult, setGuessResult] = useState<{
    correct: boolean;
    answer?: string;
    reason: string;
  } | null>(null);

  const currentPlayer = useMemo(
    () => room?.players.find((player) => player.id === socket.id),
    [room],
  );
  const isHost = currentPlayer?.isHost ?? false;
  const allReady = room?.players.every((player) => player.isReady) ?? false;

  useEffect(() => {
    const onRoomJoined = (data: {
      roomCode: string;
      players: RoomPlayer[];
    }) => {
      setRoom({ code: data.roomCode, players: data.players });
      setRoomCodeInput(data.roomCode);
      setPhase("lobby");
      setLoading(false);
    };

    const onRoomUpdated = (data: RoomState) => setRoom(data);
    const onRoomClosed = () => {
      resetToHome("The room has been closed.");
    };
    const onGameAborted = (data: { message: string }) => {
      setRoleInfo(null);
      setPhase("lobby");
      setError(data.message);
      setScoreboard([]);
    };
    const onRoleReveal = (data: RoleInfo) => {
      setRoleInfo(data);
      setPhase("discussion");
    };
    const onDiscussionStarted = (data: { duration: number }) => {
      setPhase("discussion");
      setRemainingSeconds(data.duration);
      setMessages([]);
    };
    const onDiscussionTimer = (data: { remainingSeconds: number }) =>
      setRemainingSeconds(data.remainingSeconds);
    const onDiscussionEnded = () => {
      setPhase("voting");
      setRemainingSeconds(30);
      setSelectedPlayer("");
      setHasVoted(false);
      setVoteError("");
    };
    const onChatMessage = (message: ChatMessage) => {
      setMessages((previous) =>
        previous.some((item) => item.id === message.id)
          ? previous
          : [...previous, message].slice(-100),
      );
    };
    const onVoteStarted = (data: {
      duration: number;
      players: { id: string; name: string }[];
    }) => {
      setPhase("voting");
      setRemainingSeconds(data.duration);
      setSelectedPlayer("");
      setHasVoted(false);
      setVoteCandidates([]);
      setVoteResult(null);
      setVoteProgress({ submitted: 0, total: data.players.length });
    };
    const onVoteTimer = (data: { remainingSeconds: number }) =>
      setRemainingSeconds(data.remainingSeconds);
    const onVoteProgress = (data: { submitted: number; total: number }) =>
      setVoteProgress(data);
    const onRevoteStart = (data: {
      duration: number;
      candidateIds: string[];
    }) => {
      setPhase("revote");
      setRemainingSeconds(data.duration);
      setSelectedPlayer("");
      setHasVoted(false);
      setVoteCandidates(data.candidateIds);
      setVoteProgress({ submitted: 0, total: room?.players.length || 0 });
    };
    const onVoteResult = (data: VotingResult) => {
      setVoteResult(data);
      setPhase("result");
      setHasVoted(true);
    };
    const onGuessStarted = (data: { duration: number }) => {
      setPhase("guess");
      setRemainingSeconds(data.duration);
      setGuessInput("");
      setGuessAllowed(false);
      setGuessResult(null);
      setGuessError("");
    };
    const onGuessPrompt = () => setGuessAllowed(true);
    const onGuessTimer = (data: { remainingSeconds: number }) =>
      setRemainingSeconds(data.remainingSeconds);
    const onGuessResult = (data: {
      correct: boolean;
      answer?: string;
      reason: string;
    }) => {
      setGuessResult(data);
      setGuessAllowed(false);
    };
    const onRoundStarted = (data: {
      roundNumber: number;
      maxRounds: number;
    }) => {
      setRoundNumber(data.roundNumber);
      setMaxRounds(data.maxRounds);
      setRoleInfo(null);
      setVoteResult(null);
      setGuessResult(null);
      setPhase("discussion");
    };
    const onRoundScoreboard = (data: {
      roundNumber: number;
      maxRounds: number;
      scores: ScoreEntry[];
      isFinalRound: boolean;
    }) => {
      setRoundNumber(data.roundNumber);
      setMaxRounds(data.maxRounds);
      setScoreboard(data.scores);
      setIsFinalRound(data.isFinalRound);
      setPhase("scoreboard");
    };
    const onGameFinished = (data: { scores: ScoreEntry[] }) => {
      setScoreboard(data.scores);
      setPhase("finished");
    };
    const onConnectError = () => {
      setLoading(false);
      setError("Unable to connect. Check that the backend is running.");
    };

    socket.on("room:joined", onRoomJoined);
    socket.on("room:updated", onRoomUpdated);
    socket.on("room:closed", onRoomClosed);
    socket.on("game:aborted", onGameAborted);
    socket.on("role:reveal", onRoleReveal);
    socket.on("discussion:started", onDiscussionStarted);
    socket.on("discussion:timer", onDiscussionTimer);
    socket.on("discussion:ended", onDiscussionEnded);
    socket.on("chat:message", onChatMessage);
    socket.on("vote:started", onVoteStarted);
    socket.on("vote:timer", onVoteTimer);
    socket.on("vote:progress", onVoteProgress);
    socket.on("vote:revote:start", onRevoteStart);
    socket.on("vote:result", onVoteResult);
    socket.on("guess:started", onGuessStarted);
    socket.on("guess:prompt", onGuessPrompt);
    socket.on("guess:timer", onGuessTimer);
    socket.on("guess:result", onGuessResult);
    socket.on("round:started", onRoundStarted);
    socket.on("round:scoreboard", onRoundScoreboard);
    socket.on("game:finished", onGameFinished);
    socket.on("connect_error", onConnectError);

    return () => {
      socket.off("room:joined", onRoomJoined);
      socket.off("room:updated", onRoomUpdated);
      socket.off("room:closed", onRoomClosed);
      socket.off("game:aborted", onGameAborted);
      socket.off("role:reveal", onRoleReveal);
      socket.off("discussion:started", onDiscussionStarted);
      socket.off("discussion:timer", onDiscussionTimer);
      socket.off("discussion:ended", onDiscussionEnded);
      socket.off("chat:message", onChatMessage);
      socket.off("vote:started", onVoteStarted);
      socket.off("vote:timer", onVoteTimer);
      socket.off("vote:progress", onVoteProgress);
      socket.off("vote:revote:start", onRevoteStart);
      socket.off("vote:result", onVoteResult);
      socket.off("guess:started", onGuessStarted);
      socket.off("guess:prompt", onGuessPrompt);
      socket.off("guess:timer", onGuessTimer);
      socket.off("guess:result", onGuessResult);
      socket.off("round:started", onRoundStarted);
      socket.off("round:scoreboard", onRoundScoreboard);
      socket.off("game:finished", onGameFinished);
      socket.off("connect_error", onConnectError);
    };
    // room length is intentionally not a dependency; listeners are registered once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function resetToHome(message = "") {
    setRoom(null);
    setRoleInfo(null);
    setPhase("home");
    setMessages([]);
    setVoteResult(null);
    setScoreboard([]);
    setError(message);
    setLoading(false);
  }

  function connectAndEmit(
    event: "room:create" | "room:join",
    data: { playerName: string; roomCode?: string },
  ) {
    if (!playerName.trim()) {
      setError("Please enter your player name.");
      return;
    }

    setError("");
    setLoading(true);

    const send = () => {
      socket.emit(
        event,
        data,
        (response: { success: boolean; message?: string }) => {
          if (!response.success) {
            setLoading(false);
            setError(response.message || "Unable to complete the request.");
          }
        },
      );
    };

    if (socket.connected) send();
    else {
      socket.once("connect", send);
      socket.connect();
    }
  }

  function createRoom() {
    connectAndEmit("room:create", { playerName: playerName.trim() });
  }

  function joinRoom() {
    connectAndEmit("room:join", {
      playerName: playerName.trim(),
      roomCode: roomCodeInput.trim().toUpperCase(),
    });
  }

  function leaveRoom() {
    socket.emit("room:leave", () => {
      socket.disconnect();
      resetToHome();
    });
  }

  async function copyRoomCode() {
    if (!room) return;
    try {
      await navigator.clipboard.writeText(room.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("Copy failed. Please copy the code manually.");
    }
  }

  function startGame() {
    socket.emit(
      "game:start",
      (response: { success: boolean; message?: string }) => {
        if (!response.success) setError(response.message || "Unable to start.");
      },
    );
  }

  function toggleReady() {
    if (!currentPlayer) return;
    socket.emit(
      "player:ready",
      { isReady: !currentPlayer.isReady },
      (response: { success: boolean; message?: string }) => {
        if (!response.success)
          setError(response.message || "Unable to update readiness.");
      },
    );
  }

  function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!messageInput.trim()) return;

    socket.emit(
      "chat:send",
      { message: messageInput.trim() },
      (response: { success: boolean; message?: string }) => {
        if (!response.success) {
          setChatError(response.message || "Unable to send message.");
        } else {
          setMessageInput("");
          setChatError("");
        }
      },
    );
  }

  function submitVote() {
    if (!selectedPlayer || hasVoted || voteSubmitting) return;
    setVoteSubmitting(true);
    socket.emit(
      "vote:cast",
      { targetId: selectedPlayer },
      (response: { success: boolean; message?: string }) => {
        setVoteSubmitting(false);
        if (!response.success) {
          setVoteError(response.message || "Unable to submit vote.");
        } else {
          setHasVoted(true);
          setSelectedPlayer("");
        }
      },
    );
  }

  function submitGuess() {
    if (!guessAllowed || !guessInput.trim() || guessSubmitting) return;
    setGuessSubmitting(true);
    socket.emit(
      "guess:submit",
      { guess: guessInput.trim() },
      (response: { success: boolean; message?: string }) => {
        setGuessSubmitting(false);
        if (!response.success)
          setGuessError(response.message || "Unable to submit guess.");
        else setGuessAllowed(false);
      },
    );
  }

  function startNextRound() {
    socket.emit(
      "round:next",
      (response: { success: boolean; message?: string }) => {
        if (!response.success)
          setError(response.message || "Unable to continue.");
      },
    );
  }

  const formatTime = (seconds: number) =>
    `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(
      seconds % 60,
    ).padStart(2, "0")}`;

  const votingPlayers =
    room?.players.filter((player) => {
      if (player.id === socket.id) return false;
      return phase !== "revote" || voteCandidates.includes(player.id);
    }) || [];

  const timerColor =
    remainingSeconds <= 10 ? "text-red-400" : "text-purple-300";

  const card =
    "rounded-3xl border border-white/10 bg-white/[0.04] p-6 shadow-2xl shadow-purple-950/20 backdrop-blur-xl md:p-9";
  const primaryButton =
    "w-full rounded-xl bg-gradient-to-r from-purple-600 to-fuchsia-600 px-5 py-4 font-bold transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40";
  const inputClass =
    "w-full rounded-xl border border-white/10 bg-black/30 px-5 py-4 text-white outline-none placeholder:text-gray-600 focus:border-purple-500";

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#080812] text-white">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -top-40 left-1/4 h-96 w-96 rounded-full bg-purple-700/20 blur-[120px]" />
        <div className="absolute bottom-0 right-0 h-96 w-96 rounded-full bg-red-600/10 blur-[120px]" />
      </div>

      <nav className="relative z-10 flex items-center justify-between border-b border-white/10 px-6 py-5 md:px-16">
        <div>
          <h1 className="text-xl font-black tracking-widest">
            FIND THE <span className="text-purple-400">IMPOSTOR</span>
          </h1>
          <p className="text-[9px] tracking-[0.4em] text-gray-500">
            TRUST NO ONE
          </p>
        </div>
        <span className="hidden text-xs tracking-widest text-gray-500 md:block">
          2–4 PLAYERS · 5 ROUNDS
        </span>
      </nav>

      <section className="relative z-10 mx-auto flex min-h-[85vh] max-w-6xl items-center justify-center px-5 py-10">
        {phase === "home" && (
          <div className="w-full max-w-xl text-center">
            <div className="inline-block rounded-full border border-purple-500/30 bg-purple-500/10 px-5 py-2 text-xs tracking-[0.25em] text-purple-300">
              THE ULTIMATE SOCIAL DEDUCTION GAME
            </div>
            <h2 className="mt-8 text-5xl font-black leading-tight md:text-7xl">
              EVERYONE HAS A
              <span className="block bg-gradient-to-r from-purple-400 via-fuchsia-400 to-red-400 bg-clip-text text-transparent">
                SECRET.
              </span>
              WHO IS LYING?
            </h2>
            <p className="mx-auto mt-6 max-w-lg text-sm leading-7 text-gray-400">
              Read between the lines. Question every answer. One player knows
              nothing. Can you find the Impostor?
            </p>

            <div className="mt-10 text-left">
              <label className="mb-2 block text-xs font-semibold tracking-widest text-gray-400">
                YOUR PLAYER NAME
              </label>
              <input
                value={playerName}
                onChange={(event) => setPlayerName(event.target.value)}
                maxLength={16}
                placeholder="Enter your name..."
                className={inputClass}
              />
            </div>

            <button
              onClick={createRoom}
              disabled={!playerName.trim() || loading}
              className={`${primaryButton} mt-5`}
            >
              {loading ? "CONNECTING..." : "CREATE ROOM"}
            </button>

            <div className="mt-5 rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-left">
              <h3 className="font-bold">JOIN AN EXISTING GAME</h3>
              <input
                value={roomCodeInput}
                onChange={(event) =>
                  setRoomCodeInput(
                    event.target.value
                      .toUpperCase()
                      .replace(/[^A-Z0-9]/g, "")
                      .slice(0, 6),
                  )
                }
                maxLength={6}
                placeholder="SIX-CHARACTER ROOM CODE"
                className={`${inputClass} mt-4 text-center font-bold tracking-[0.4em]`}
              />
              <button
                onClick={joinRoom}
                disabled={
                  !playerName.trim() || roomCodeInput.length !== 6 || loading
                }
                className="mt-4 w-full rounded-xl border border-purple-500/30 bg-purple-500/10 py-3 font-bold text-purple-300 disabled:opacity-40"
              >
                JOIN ROOM
              </button>
            </div>

            {error && <p className="mt-5 text-sm text-red-400">{error}</p>}
          </div>
        )}

        {phase === "lobby" && room && (
          <div className={`${card} w-full max-w-2xl`}>
            <div className="text-center">
              <p className="text-xs font-bold tracking-[0.3em] text-purple-300">
                GAME LOBBY
              </p>
              <h2 className="mt-3 text-4xl font-black">YOUR ROOM IS READY</h2>
              <p className="mt-3 text-sm text-gray-400">
                Share this code with your friends.
              </p>
              <div className="mx-auto mt-6 flex max-w-sm items-center justify-center gap-3 rounded-2xl border border-purple-500/30 bg-purple-500/10 p-4">
                <span className="text-3xl font-black tracking-[0.3em] text-purple-300">
                  {room.code}
                </span>
                <button
                  onClick={copyRoomCode}
                  className="rounded-lg border border-white/10 bg-white/10 px-3 py-2 text-xs font-bold"
                >
                  {copied ? "COPIED" : "COPY"}
                </button>
              </div>
            </div>

            <div className="mt-8 flex justify-between text-sm">
              <h3 className="font-bold tracking-wider">PLAYERS</h3>
              <span className="text-gray-400">{room.players.length}/4</span>
            </div>
            <div className="mt-4 space-y-3">
              {room.players.map((player) => (
                <div
                  key={player.id}
                  className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.04] p-4"
                >
                  <div>
                    <p className="font-semibold">{player.name}</p>
                    <p className="text-xs text-gray-500">
                      {player.isHost ? "ROOM HOST" : "PLAYER"}
                    </p>
                  </div>
                  <span
                    className={
                      player.isReady
                        ? "text-xs font-bold text-green-400"
                        : "text-xs font-bold text-yellow-400"
                    }
                  >
                    {player.isReady ? "READY" : "NOT READY"}
                  </span>
                </div>
              ))}
            </div>

            <button onClick={toggleReady} className={`${primaryButton} mt-7`}>
              {currentPlayer?.isReady ? "I'M NOT READY" : "I'M READY"}
            </button>
            <p className="mt-4 text-center text-sm text-purple-300">
              {allReady ? "EVERYONE IS READY" : "WAITING FOR PLAYERS..."}
            </p>
            {isHost && (
              <button
                onClick={startGame}
                disabled={room.players.length < 2 || !allReady}
                className="mt-5 w-full rounded-xl border border-green-500/30 bg-green-500/10 py-4 font-bold text-green-300 disabled:opacity-30"
              >
                START GAME
              </button>
            )}
            {error && (
              <p className="mt-4 text-center text-sm text-red-400">{error}</p>
            )}
            <button
              onClick={leaveRoom}
              className="mt-5 w-full py-3 text-sm text-red-300"
            >
              LEAVE ROOM
            </button>
          </div>
        )}

        {phase === "discussion" && room && (
          <div className="grid w-full max-w-5xl gap-6 lg:grid-cols-[0.85fr_1.15fr]">
            <div className={card}>
              <p className="text-xs font-bold tracking-[0.3em] text-purple-300">
                ROUND {roundNumber} OF {maxRounds} · YOUR ROLE
              </p>
              <div
                className={`mt-6 rounded-2xl border p-6 text-center ${
                  roleInfo?.role === "impostor"
                    ? "border-red-500/30 bg-red-500/10"
                    : "border-purple-500/30 bg-purple-500/10"
                }`}
              >
                <p className="text-sm text-gray-400">YOU ARE</p>
                <h2
                  className={`mt-3 text-3xl font-black ${
                    roleInfo?.role === "impostor"
                      ? "text-red-400"
                      : "text-purple-300"
                  }`}
                >
                  {roleInfo?.role === "impostor" ? "IMPOSTOR" : "REGULAR"}
                </h2>
                {roleInfo?.role === "impostor" ? (
                  <>
                    <p className="mt-6 text-xs tracking-widest text-gray-400">
                      YOUR CLUE
                    </p>
                    <p className="mt-3 text-xl font-bold text-red-300">
                      {roleInfo.clue}
                    </p>
                    <p className="mt-4 text-sm text-gray-400">
                      Blend in. Do not reveal yourself.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="mt-6 text-xs tracking-widest text-gray-400">
                      SECRET WORD
                    </p>
                    <p className="mt-3 text-3xl font-black">
                      {roleInfo?.secretWord}
                    </p>
                    <p className="mt-4 text-sm text-gray-400">
                      Find the player who does not know this word.
                    </p>
                  </>
                )}
              </div>
              <div className="mt-6 rounded-2xl border border-white/10 bg-black/20 p-5 text-center">
                <p className="text-xs tracking-widest text-gray-400">
                  DISCUSSION ENDS IN
                </p>
                <p
                  className={`mt-3 text-5xl font-black tabular-nums ${timerColor}`}
                >
                  {formatTime(remainingSeconds)}
                </p>
              </div>
              <p className="mt-5 text-xs text-gray-500">
                ROOM CODE · {room.code}
              </p>
            </div>

            <div className={`${card} flex min-h-[520px] flex-col`}>
              <div className="border-b border-white/10 pb-4">
                <h2 className="text-xl font-black">LIVE DISCUSSION</h2>
                <p className="mt-1 text-xs text-gray-500">
                  Talk to your fellow players.
                </p>
              </div>
              <div className="flex-1 space-y-3 overflow-y-auto py-5">
                {messages.length === 0 ? (
                  <p className="py-16 text-center text-sm text-gray-500">
                    No messages yet. Start the discussion.
                  </p>
                ) : (
                  messages.map((message) => (
                    <div
                      key={message.id}
                      className={`flex ${message.playerId === socket.id ? "justify-end" : "justify-start"}`}
                    >
                      <div
                        className={`max-w-[85%] rounded-2xl px-4 py-3 ${message.playerId === socket.id ? "bg-purple-600/30" : "bg-white/[0.06]"}`}
                      >
                        <p className="mb-1 text-xs font-bold text-purple-300">
                          {message.playerName}
                        </p>
                        <p className="break-words text-sm text-gray-200">
                          {message.message}
                        </p>
                      </div>
                    </div>
                  ))
                )}
              </div>
              {chatError && (
                <p className="mb-2 text-xs text-red-400">{chatError}</p>
              )}
              <form
                onSubmit={sendMessage}
                className="flex gap-3 border-t border-white/10 pt-4"
              >
                <input
                  value={messageInput}
                  onChange={(event) => setMessageInput(event.target.value)}
                  maxLength={300}
                  placeholder="Type your message..."
                  className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm outline-none focus:border-purple-500"
                />
                <button
                  type="submit"
                  disabled={!messageInput.trim()}
                  className="rounded-xl bg-purple-600 px-5 py-3 text-sm font-bold disabled:opacity-40"
                >
                  SEND
                </button>
              </form>
            </div>
          </div>
        )}

        {(phase === "voting" || phase === "revote") && (
          <div className={`${card} w-full max-w-3xl`}>
            <div className="text-center">
              <p className="text-xs font-bold tracking-[0.3em] text-purple-300">
                {phase === "revote" ? "FINAL DECISION" : "TIME TO VOTE"}
              </p>
              <h2 className="mt-4 text-4xl font-black">
                {phase === "revote" ? "TIE BREAKER" : "WHO IS THE IMPOSTOR?"}
              </h2>
              <p className="mt-3 text-sm text-gray-400">
                {phase === "revote"
                  ? "Choose between the tied players."
                  : "Choose the player you believe is hiding something."}
              </p>
              <p
                className={`mt-6 text-5xl font-black tabular-nums ${timerColor}`}
              >
                {formatTime(remainingSeconds)}
              </p>
            </div>

            <div className="mt-7">
              <div className="mb-2 flex justify-between text-xs text-gray-400">
                <span>VOTING PROGRESS</span>
                <span>
                  {voteProgress.submitted}/{voteProgress.total} VOTED
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-purple-500 to-fuchsia-500"
                  style={{
                    width: `${voteProgress.total ? (voteProgress.submitted / voteProgress.total) * 100 : 0}%`,
                  }}
                />
              </div>
            </div>

            {!hasVoted ? (
              <>
                <div className="mt-7 grid gap-3 sm:grid-cols-2">
                  {votingPlayers.map((player) => (
                    <button
                      key={player.id}
                      onClick={() => setSelectedPlayer(player.id)}
                      className={`rounded-2xl border p-5 text-left ${
                        selectedPlayer === player.id
                          ? "border-purple-400 bg-purple-500/20"
                          : "border-white/10 bg-white/[0.03] hover:border-purple-500/50"
                      }`}
                    >
                      <span className="font-bold">{player.name}</span>
                      <span className="mt-1 block text-xs text-gray-500">
                        {selectedPlayer === player.id
                          ? "SELECTED"
                          : "SELECT PLAYER"}
                      </span>
                    </button>
                  ))}
                </div>
                {voteError && (
                  <p className="mt-4 text-center text-sm text-red-400">
                    {voteError}
                  </p>
                )}
                <button
                  onClick={submitVote}
                  disabled={!selectedPlayer || voteSubmitting}
                  className={`${primaryButton} mt-7`}
                >
                  {voteSubmitting ? "SUBMITTING..." : "CONFIRM MY VOTE"}
                </button>
              </>
            ) : (
              <div className="mt-8 rounded-2xl border border-green-500/20 bg-green-500/10 p-7 text-center">
                <h3 className="text-2xl font-black text-green-300">
                  VOTE SUBMITTED
                </h3>
                <p className="mt-3 text-sm text-gray-400">
                  Your vote is locked. Waiting for the other players...
                </p>
              </div>
            )}
          </div>
        )}

        {phase === "result" && voteResult && (
          <div className={`${card} w-full max-w-2xl`}>
            <div className="text-center">
              <p className="text-xs font-bold tracking-[0.3em] text-purple-300">
                VOTING COMPLETE
              </p>
              <h2 className="mt-5 text-4xl font-black">
                {voteResult.outcome === "impostor_caught"
                  ? "IMPOSTOR CAUGHT!"
                  : "IMPOSTOR ESCAPED!"}
              </h2>
              <p
                className={`mt-4 font-bold ${voteResult.outcome === "impostor_caught" ? "text-green-400" : "text-red-400"}`}
              >
                {voteResult.outcome === "impostor_caught"
                  ? `${voteResult.eliminatedPlayerName} was the Impostor.`
                  : voteResult.reason === "revote_tie"
                    ? "The revote ended in a tie."
                    : voteResult.reason === "no_votes"
                      ? "Nobody submitted a vote."
                      : `${voteResult.eliminatedPlayerName || "An innocent player"} was eliminated. The Impostor escaped.`}
              </p>
            </div>
            <h3 className="mb-4 mt-8 text-sm font-bold tracking-widest text-gray-400">
              VOTING RESULTS
            </h3>
            <div className="space-y-3">
              {voteResult.results.map((result) => (
                <div
                  key={result.playerId}
                  className="flex items-center justify-between rounded-xl border border-white/10 bg-black/20 p-4"
                >
                  <span className="font-semibold">{result.playerName}</span>
                  <span className="rounded-lg bg-purple-500/10 px-3 py-2 text-sm font-bold text-purple-300">
                    {result.voteCount}{" "}
                    {result.voteCount === 1 ? "VOTE" : "VOTES"}
                  </span>
                </div>
              ))}
            </div>
            <p className="mt-7 text-center text-sm text-gray-400">
              {voteResult.outcome === "impostor_caught"
                ? "The Impostor now has one final chance to guess the secret word."
                : "The Impostor escaped. The round scoreboard is next."}
            </p>
          </div>
        )}

        {phase === "guess" && (
          <div className={`${card} w-full max-w-2xl text-center`}>
            <p className="text-xs tracking-[0.3em] text-red-400">
              IMPOSTOR FINAL CHANCE
            </p>
            <h2 className="mt-5 text-4xl font-black">GUESS THE SECRET WORD</h2>
            <p className="mt-3 text-sm text-gray-400">
              Only the caught Impostor can submit a guess.
            </p>
            <p className={`mt-6 text-5xl font-black ${timerColor}`}>
              {formatTime(remainingSeconds)}
            </p>

            {guessAllowed ? (
              <div className="mt-7">
                <input
                  value={guessInput}
                  onChange={(event) => setGuessInput(event.target.value)}
                  maxLength={60}
                  placeholder="Enter your final guess..."
                  className={inputClass}
                />
                {guessError && (
                  <p className="mt-3 text-sm text-red-400">{guessError}</p>
                )}
                <button
                  onClick={submitGuess}
                  disabled={!guessInput.trim() || guessSubmitting}
                  className={`${primaryButton} mt-4`}
                >
                  {guessSubmitting ? "SUBMITTING..." : "SUBMIT FINAL GUESS"}
                </button>
              </div>
            ) : (
              <p className="mt-8 text-sm text-gray-300">
                {guessResult
                  ? guessResult.correct
                    ? `Correct! The word was ${guessResult.answer}.`
                    : `Incorrect. The word was ${guessResult.answer || "not revealed"}.`
                  : "Waiting for the Impostor to make a guess..."}
              </p>
            )}
          </div>
        )}

        {phase === "scoreboard" && (
          <div className={`${card} w-full max-w-2xl`}>
            <div className="text-center">
              <p className="text-xs tracking-[0.3em] text-purple-300">
                ROUND {roundNumber} OF {maxRounds} COMPLETE
              </p>
              <h2 className="mt-4 text-4xl font-black">LEADERBOARD</h2>
            </div>
            <div className="mt-8 space-y-3">
              {scoreboard.map((entry, index) => (
                <div
                  key={entry.playerId}
                  className="flex items-center justify-between rounded-xl border border-white/10 bg-black/20 p-4"
                >
                  <span className="font-semibold">
                    <span className="mr-3 text-purple-300">#{index + 1}</span>
                    {entry.playerName}
                  </span>
                  <span className="font-black text-purple-300">
                    {entry.score} PTS
                  </span>
                </div>
              ))}
            </div>
            {isHost ? (
              <button
                onClick={startNextRound}
                className={`${primaryButton} mt-8`}
              >
                {isFinalRound ? "SHOW FINAL RESULTS" : "START NEXT ROUND"}
              </button>
            ) : (
              <p className="mt-8 text-center text-sm text-gray-400">
                Waiting for the host to continue...
              </p>
            )}
          </div>
        )}

        {phase === "finished" && (
          <div className={`${card} w-full max-w-2xl text-center`}>
            <p className="text-xs tracking-[0.3em] text-yellow-300">
              FIVE ROUNDS COMPLETE
            </p>
            <h2 className="mt-5 text-5xl font-black">GAME OVER</h2>
            {scoreboard[0] && (
              <div className="mt-8 rounded-2xl border border-yellow-500/20 bg-yellow-500/10 p-6">
                <p className="text-xs tracking-widest text-yellow-300">
                  WINNER
                </p>
                <h3 className="mt-3 text-3xl font-black">
                  {scoreboard[0].playerName}
                </h3>
                <p className="mt-2 text-yellow-300">
                  {scoreboard[0].score} POINTS
                </p>
              </div>
            )}
            <div className="mt-7 space-y-3 text-left">
              {scoreboard.map((entry, index) => (
                <div
                  key={entry.playerId}
                  className="flex justify-between rounded-xl border border-white/10 bg-black/20 p-4"
                >
                  <span>
                    {index + 1}. {entry.playerName}
                  </span>
                  <span className="font-bold text-purple-300">
                    {entry.score} PTS
                  </span>
                </div>
              ))}
            </div>
            <button
              onClick={leaveRoom}
              className="mt-8 w-full rounded-xl border border-red-500/30 bg-red-500/10 py-4 font-bold text-red-300"
            >
              LEAVE GAME
            </button>
          </div>
        )}
      </section>

      <footer className="relative z-10 border-t border-white/10 px-6 py-6 text-center text-xs text-gray-600">
        THINK SMART. TRUST NO ONE. © 2026 FIND THE IMPOSTOR
      </footer>
    </main>
  );
}
