import type { WSContext } from "hono/ws";
import { prisma } from "./db.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Client {
  ws: WSContext;
  userId: string;
  role: "host" | "guest";
}

interface RoomState {
  currentVideoId: string | null;
  isPlaying: boolean;
  currentTime: number;
}

type IncomingMessage =
  | { type: "JOIN"; roomId: string; userId: string; role: "host" | "guest" }
  | {
      type: "ADD_VIDEO";
      roomId: string;
      video: { youtubeId: string; title: string; thumbnail: string };
      userId: string;
    }
  | { type: "PLAY"; roomId: string }
  | { type: "PAUSE"; roomId: string }
  | {
      type: "SYNC_TIME";
      roomId: string;
      currentTime: number;
      isPlaying: boolean;
    }
  | { type: "NEXT_VIDEO"; roomId: string }
  | { type: "REMOVE_VIDEO"; roomId: string; videoId: string }
  | { type: "SELECT_VIDEO"; roomId: string; youtubeId: string }
  | { type: "PING" };

// ---------------------------------------------------------------------------
// State stores (in-memory)
// ---------------------------------------------------------------------------

/** roomId -> Set of connected clients */
const rooms = new Map<string, Set<Client>>();

/** roomId -> current playback state kept in memory for speed */
const roomStates = new Map<string, RoomState>();

/** roomId -> last DB write timestamp (for SYNC_TIME throttle) */
const lastDbWrite = new Map<string, number>();

/** roomId -> PLAY/PAUSE コマンド受信時刻（SYNC_TIME の isPlaying 上書きを防ぐ） */
const playPauseCooldown = new Map<string, number>();

const SYNC_THROTTLE_MS = 5000;
const PLAY_PAUSE_COOLDOWN_MS = 3000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function send(ws: WSContext, data: unknown): void {
  try {
    ws.send(JSON.stringify(data));
  } catch (err) {
    console.error("[ws] Failed to send message:", err);
  }
}

/** Broadcast to everyone in the room EXCEPT the sender. */
function broadcast(roomId: string, data: unknown, senderWs?: WSContext): void {
  const clients = rooms.get(roomId);
  if (!clients) return;
  const payload = JSON.stringify(data);
  for (const client of clients) {
    if (client.ws === senderWs) continue;
    try {
      client.ws.send(payload);
    } catch (err) {
      console.error("[ws] Broadcast send error:", err);
    }
  }
}

/** Broadcast to ALL clients in the room (including sender). */
function broadcastAll(roomId: string, data: unknown): void {
  const clients = rooms.get(roomId);
  if (!clients) {
    console.warn(`[ws] broadcastAll: no clients found for room ${roomId}`);
    return;
  }
  const payload = JSON.stringify(data);
  for (const client of clients) {
    try {
      const readyState = client.ws.readyState;
      console.log(`[ws] broadcastAll -> ${client.role} ${client.userId} (readyState=${readyState}): ${payload}`);
      client.ws.send(payload);
    } catch (err) {
      console.error(`[ws] BroadcastAll send error to ${client.role} ${client.userId}:`, err);
    }
  }
}

/** Fetch playlist from DB for a given room (by Room.id UUID, ordered). */
async function getPlaylist(roomDbId: string) {
  return prisma.video.findMany({
    where: { roomId: roomDbId },
    orderBy: { order: "asc" },
  });
}

/**
 * Resolve the Room DB UUID from a room code.
 * Returns null if the room doesn't exist.
 */
async function resolveRoomId(code: string): Promise<string | null> {
  const room = await prisma.room.findUnique({ where: { code } });
  return room?.id ?? null;
}

/** Build a full SYNC_STATE payload. roomCode is the 6-char code. */
async function buildSyncState(roomCode: string) {
  const state = roomStates.get(roomCode) ?? {
    currentVideoId: null,
    isPlaying: false,
    currentTime: 0,
  };
  const roomDbId = await resolveRoomId(roomCode);
  const playlist = roomDbId ? await getPlaylist(roomDbId) : [];
  return {
    type: "SYNC_STATE" as const,
    currentVideoId: state.currentVideoId,
    isPlaying: state.isPlaying,
    currentTime: state.currentTime,
    playlist,
  };
}

/** Persist the in-memory room state to DB (throttled externally). */
async function persistRoomState(roomId: string): Promise<void> {
  const state = roomStates.get(roomId);
  if (!state) return;
  try {
    // Resolve room DB id from the rooms/clients – we need the Room.id (UUID).
    // The roomId passed around in messages is the Room.code (6-char code).
    const room = await prisma.room.findUnique({ where: { code: roomId } });
    if (!room) return;
    await prisma.room.update({
      where: { id: room.id },
      data: {
        currentVideoId: state.currentVideoId,
        isPlaying: state.isPlaying,
        currentTime: state.currentTime,
      },
    });
  } catch (err) {
    console.error("[db] Failed to persist room state:", err);
  }
}

// ---------------------------------------------------------------------------
// Message Handler
// ---------------------------------------------------------------------------

/**
 * Call this from the WebSocket onMessage callback.
 * `ws` is the WSContext for the connection that sent the message.
 */
export async function handleMessage(
  ws: WSContext,
  raw: string | ArrayBuffer
): Promise<void> {
  let msg: IncomingMessage;
  try {
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    msg = JSON.parse(text) as IncomingMessage;
  } catch {
    console.error("[ws] Invalid JSON received");
    send(ws, { type: "ERROR", message: "Invalid JSON" });
    return;
  }

  try {
    switch (msg.type) {
      // ---------------------------------------------------------------
      // PING / PONG heartbeat
      // ---------------------------------------------------------------
      case "PING": {
        send(ws, { type: "PONG" });
        break;
      }

      // ---------------------------------------------------------------
      // JOIN
      // ---------------------------------------------------------------
      case "JOIN": {
        const { roomId, userId, role } = msg;

        // Verify room exists in DB
        const room = await prisma.room.findUnique({
          where: { code: roomId },
        });
        if (!room) {
          send(ws, { type: "ERROR", message: "Room not found" });
          return;
        }

        // Initialise in-memory structures if needed
        if (!rooms.has(roomId)) {
          rooms.set(roomId, new Set());
        }
        if (!roomStates.has(roomId)) {
          // Seed from DB
          roomStates.set(roomId, {
            currentVideoId: room.currentVideoId,
            isPlaying: room.isPlaying,
            currentTime: room.currentTime,
          });
        }

        // Remove duplicate connection from same userId (e.g. after reconnect)
        const clientSet = rooms.get(roomId)!;
        for (const c of clientSet) {
          if (c.userId === userId) {
            clientSet.delete(c);
            break;
          }
        }

        clientSet.add({ ws, userId, role });

        console.log(
          `[ws] ${role} ${userId} joined room ${roomId} (${clientSet.size} clients)`
        );

        // Send full sync state to the joining client
        const syncState = await buildSyncState(roomId);
        send(ws, syncState);
        break;
      }

      // ---------------------------------------------------------------
      // ADD_VIDEO
      // ---------------------------------------------------------------
      case "ADD_VIDEO": {
        const { roomId, video, userId } = msg;

        const room = await prisma.room.findUnique({
          where: { code: roomId },
        });
        if (!room) {
          send(ws, { type: "ERROR", message: "Room not found" });
          return;
        }

        // Determine order value (append to end)
        const lastVideo = await prisma.video.findFirst({
          where: { roomId: room.id },
          orderBy: { order: "desc" },
        });
        const nextOrder = lastVideo ? lastVideo.order + 1 : 0;

        const created = await prisma.video.create({
          data: {
            youtubeId: video.youtubeId,
            title: video.title,
            thumbnail: video.thumbnail,
            addedBy: userId,
            order: nextOrder,
            roomId: room.id,
          },
        });

        // If nothing is playing, auto-start this video
        const state = roomStates.get(roomId);
        if (state && !state.currentVideoId) {
          state.currentVideoId = created.youtubeId;
          state.isPlaying = true;
          state.currentTime = 0;
          await persistRoomState(roomId);

          broadcastAll(roomId, {
            type: "PLAY_VIDEO",
            videoId: created.youtubeId,
          });
        }

        // Broadcast updated playlist to everyone
        const playlist = await getPlaylist(room.id);
        broadcastAll(roomId, { type: "PLAYLIST_UPDATE", playlist });
        break;
      }

      // ---------------------------------------------------------------
      // PLAY
      // ---------------------------------------------------------------
      case "PLAY": {
        const { roomId } = msg;
        console.log(`[ws] PLAY received for room ${roomId}`);
        const state = roomStates.get(roomId);
        if (state) {
          state.isPlaying = true;
        }
        playPauseCooldown.set(roomId, Date.now());
        broadcastAll(roomId, {
          type: "PLAY",
          videoId: state?.currentVideoId ?? null,
          currentTime: state?.currentTime ?? 0,
        });
        break;
      }

      // ---------------------------------------------------------------
      // PAUSE
      // ---------------------------------------------------------------
      case "PAUSE": {
        const { roomId } = msg;
        console.log(`[ws] PAUSE received for room ${roomId}`);
        const state = roomStates.get(roomId);
        if (state) {
          state.isPlaying = false;
        }
        playPauseCooldown.set(roomId, Date.now());
        broadcastAll(roomId, { type: "PAUSE" });
        break;
      }

      // ---------------------------------------------------------------
      // SYNC_TIME  (sent periodically by the host)
      // ---------------------------------------------------------------
      case "SYNC_TIME": {
        const { roomId, currentTime, isPlaying } = msg;
        const state = roomStates.get(roomId);

        // PLAY/PAUSE コマンド直後はホストの isPlaying 報告を無視し、
        // サーバーが持つ権威状態を維持する（プレイヤーの応答遅延対策）
        const cooldownAt = playPauseCooldown.get(roomId) ?? 0;
        const inCooldown = Date.now() - cooldownAt < PLAY_PAUSE_COOLDOWN_MS;

        if (state) {
          state.currentTime = currentTime;
          if (!inCooldown) {
            state.isPlaying = isPlaying;
          }
        }

        // Throttled DB persistence
        const now = Date.now();
        const lastWrite = lastDbWrite.get(roomId) ?? 0;
        if (now - lastWrite >= SYNC_THROTTLE_MS) {
          lastDbWrite.set(roomId, now);
          persistRoomState(roomId).catch((err) =>
            console.error("[db] Throttled persist error:", err)
          );
        }

        // ゲストにはサーバーの権威状態を送信
        broadcast(
          roomId,
          {
            type: "SYNC_TIME",
            currentTime: state?.currentTime ?? currentTime,
            isPlaying: state?.isPlaying ?? isPlaying,
          },
          ws
        );
        break;
      }

      // ---------------------------------------------------------------
      // NEXT_VIDEO
      // ---------------------------------------------------------------
      case "NEXT_VIDEO": {
        const { roomId } = msg;

        const room = await prisma.room.findUnique({
          where: { code: roomId },
        });
        if (!room) return;

        const state = roomStates.get(roomId);

        // リスト全体を順番に取得
        const allVideos = await prisma.video.findMany({
          where: { roomId: room.id },
          orderBy: { order: "asc" },
        });

        // 現在の動画のインデックスを探し、その次を再生
        const currentIndex = allVideos.findIndex(
          (v) => v.youtubeId === state?.currentVideoId
        );
        const nextVideo = allVideos[currentIndex + 1] ?? null;

        if (nextVideo && state) {
          state.currentVideoId = nextVideo.youtubeId;
          state.isPlaying = true;
          state.currentTime = 0;
          await persistRoomState(roomId);

          broadcastAll(roomId, {
            type: "PLAY_VIDEO",
            videoId: nextVideo.youtubeId,
          });
        } else if (state) {
          // リストの最後 → 停止
          state.currentVideoId = null;
          state.isPlaying = false;
          state.currentTime = 0;
          await persistRoomState(roomId);

          broadcastAll(roomId, {
            type: "PLAY_VIDEO",
            videoId: null,
          });
        }

        // Broadcast updated playlist
        const playlist = await getPlaylist(room.id);
        broadcastAll(roomId, { type: "PLAYLIST_UPDATE", playlist });
        break;
      }

      // ---------------------------------------------------------------
      // REMOVE_VIDEO
      // ---------------------------------------------------------------
      case "REMOVE_VIDEO": {
        const { roomId, videoId } = msg;

        const room = await prisma.room.findUnique({
          where: { code: roomId },
        });
        if (!room) return;

        try {
          await prisma.video.delete({ where: { id: videoId } });
        } catch (err) {
          console.error("[db] Failed to delete video:", err);
          send(ws, { type: "ERROR", message: "Video not found" });
          return;
        }

        // If the removed video was currently playing, advance to next
        const state = roomStates.get(roomId);
        const deletedVideo = state?.currentVideoId;

        // We need to check if the deleted video's youtubeId matches current
        // Since we already deleted it, we rely on the videoId (DB id).
        // To be safe, re-fetch the playlist and check.
        const playlist = await getPlaylist(room.id);

        // Broadcast updated playlist
        broadcastAll(roomId, { type: "PLAYLIST_UPDATE", playlist });
        break;
      }

      // ---------------------------------------------------------------
      // SELECT_VIDEO (プレイリストから曲を選択して再生)
      // ---------------------------------------------------------------
      case "SELECT_VIDEO": {
        const { roomId, youtubeId } = msg;
        console.log(`[ws] SELECT_VIDEO received: ${youtubeId} in room ${roomId}`);

        const state = roomStates.get(roomId);
        if (state) {
          state.currentVideoId = youtubeId;
          state.isPlaying = true;
          state.currentTime = 0;
          await persistRoomState(roomId);
        }

        broadcastAll(roomId, {
          type: "PLAY_VIDEO",
          videoId: youtubeId,
        });
        break;
      }

      default: {
        console.warn("[ws] Unknown message type:", (msg as { type: string }).type);
        send(ws, { type: "ERROR", message: "Unknown message type" });
      }
    }
  } catch (err) {
    console.error("[ws] Error handling message:", err);
    send(ws, { type: "ERROR", message: "Internal server error" });
  }
}

// ---------------------------------------------------------------------------
// Disconnect Handler
// ---------------------------------------------------------------------------

/**
 * Call this from the WebSocket onClose callback.
 */
export function handleDisconnect(ws: WSContext): void {
  for (const [roomId, clients] of rooms) {
    for (const client of clients) {
      if (client.ws === ws) {
        clients.delete(client);
        console.log(
          `[ws] ${client.role} ${client.userId} left room ${roomId} (${clients.size} remaining)`
        );

        // Clean up empty rooms from memory
        if (clients.size === 0) {
          rooms.delete(roomId);
          roomStates.delete(roomId);
          lastDbWrite.delete(roomId);
          console.log(`[ws] Room ${roomId} cleaned up (no clients left)`);
        }
        return;
      }
    }
  }
}
