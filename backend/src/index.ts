import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { v4 as uuidv4 } from "uuid";
import { prisma } from "./db.js";
import { handleMessage, handleDisconnect } from "./websocket.js";

// ---------------------------------------------------------------------------
// App & WebSocket setup
// ---------------------------------------------------------------------------

const app = new Hono();

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------

/**
 * POST /api/rooms
 * Create a new room with a random 6-character code.
 */
app.post("/api/rooms", async (c) => {
  try {
    const code = generateRoomCode();

    const room = await prisma.room.create({
      data: {
        id: uuidv4(),
        code,
      },
    });

    return c.json({ room }, 201);
  } catch (err) {
    console.error("[api] Failed to create room:", err);
    return c.json({ error: "Failed to create room" }, 500);
  }
});

/**
 * GET /api/rooms/:code
 * Fetch room info by its 6-char code, including playlist.
 */
app.get("/api/rooms/:code", async (c) => {
  try {
    const code = c.req.param("code");

    const room = await prisma.room.findUnique({
      where: { code },
      include: {
        videos: {
          orderBy: { order: "asc" },
        },
      },
    });

    if (!room) {
      return c.json({ error: "Room not found" }, 404);
    }

    return c.json({ room });
  } catch (err) {
    console.error("[api] Failed to fetch room:", err);
    return c.json({ error: "Failed to fetch room" }, 500);
  }
});

// ---------------------------------------------------------------------------
// Invidious API helper (APIキー不要)
// ---------------------------------------------------------------------------

const INVIDIOUS_INSTANCES = [
  "https://inv.vern.cc",
  "https://invidious.f5.si",
  "https://invidious.reallyaweso.me",
  "https://invidious.materialio.us",
];

/**
 * 複数の Invidious インスタンスにフォールバックしながら fetch する。
 */
async function invidiousFetch(path: string): Promise<Response> {
  const instances = process.env.INVIDIOUS_INSTANCES
    ? process.env.INVIDIOUS_INSTANCES.split(",").map((s) => s.trim())
    : INVIDIOUS_INSTANCES;

  let lastError: unknown;
  for (const base of instances) {
    try {
      const res = await fetch(`${base}${path}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) return res;
      console.warn(`[invidious] ${base} returned ${res.status}`);
    } catch (err) {
      console.warn(`[invidious] ${base} failed:`, err);
      lastError = err;
    }
  }
  throw lastError ?? new Error("All Invidious instances failed");
}

/**
 * GET /api/youtube/search?q=query
 * Invidious API 経由で動画検索 (APIキー不要)。
 */
app.get("/api/youtube/search", async (c) => {
  const query = c.req.query("q");
  if (!query) {
    return c.json({ error: "Query parameter 'q' is required" }, 400);
  }

  try {
    const params = new URLSearchParams({
      q: query,
      type: "video",
    });
    const res = await invidiousFetch(`/api/v1/search?${params}`);
    const data: Array<{
      type: string;
      videoId: string;
      title: string;
      author: string;
      videoThumbnails: Array<{ quality: string; url: string }>;
    }> = await res.json();

    const results = data
      .filter((item) => item.type === "video")
      .slice(0, 10)
      .map((item) => ({
        youtubeId: item.videoId,
        title: item.title,
        thumbnail:
          item.videoThumbnails?.find((t) => t.quality === "medium")?.url ??
          item.videoThumbnails?.[0]?.url ??
          "",
        channelTitle: item.author,
      }));

    return c.json({ results });
  } catch (err) {
    console.error("[api] YouTube search error:", err);
    return c.json({ error: "Failed to search YouTube" }, 500);
  }
});

/**
 * YouTube oEmbed API フォールバック (Invidious /videos/ が不安定なため)
 */
async function fetchViaOEmbed(videoId: string) {
  const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&format=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`oEmbed returned ${res.status}`);
  const data: { title: string; author_name: string; thumbnail_url: string } =
    await res.json();
  return {
    youtubeId: videoId,
    title: data.title,
    thumbnail: data.thumbnail_url,
    channelTitle: data.author_name,
  };
}

/**
 * GET /api/youtube/video?id=VIDEO_ID
 * Invidious API 経由で動画情報を取得。失敗時は YouTube oEmbed にフォールバック。
 */
app.get("/api/youtube/video", async (c) => {
  const videoId = c.req.query("id");
  if (!videoId) {
    return c.json({ error: "Query parameter 'id' is required" }, 400);
  }

  // 1) Invidious を試す
  try {
    const res = await invidiousFetch(`/api/v1/videos/${encodeURIComponent(videoId)}`);
    const item: {
      videoId: string;
      title: string;
      author: string;
      videoThumbnails: Array<{ quality: string; url: string }>;
    } = await res.json();

    const result = {
      youtubeId: item.videoId,
      title: item.title,
      thumbnail:
        item.videoThumbnails?.find((t) => t.quality === "medium")?.url ??
        item.videoThumbnails?.[0]?.url ??
        "",
      channelTitle: item.author,
    };

    return c.json({ result });
  } catch (invidiousErr) {
    console.warn("[api] Invidious video fetch failed, trying oEmbed fallback:", invidiousErr);
  }

  // 2) oEmbed フォールバック
  try {
    const result = await fetchViaOEmbed(videoId);
    return c.json({ result });
  } catch (err) {
    console.error("[api] YouTube video fetch error (all methods failed):", err);
    return c.json({ error: "Failed to fetch video info" }, 500);
  }
});

/**
 * GET /api/youtube/playlist?id=PLAYLIST_ID
 * Invidious API 経由でプレイリスト情報と動画一覧を取得（ページネーション対応、最大1000件）。
 */
app.get("/api/youtube/playlist", async (c) => {
  const playlistId = c.req.query("id");
  if (!playlistId) {
    return c.json({ error: "Query parameter 'id' is required" }, 400);
  }

  try {
    const allVideos: Array<{ youtubeId: string; title: string; thumbnail: string }> = [];
    let playlistTitle = "";
    let totalVideoCount = 0;
    const MAX_PAGES = 10;

    for (let page = 1; page <= MAX_PAGES; page++) {
      const params = new URLSearchParams({ page: String(page) });
      const res = await invidiousFetch(
        `/api/v1/playlists/${encodeURIComponent(playlistId)}?${params}`
      );
      const data: {
        title: string;
        videoCount: number;
        videos: Array<{
          videoId: string;
          title: string;
          videoThumbnails: Array<{ quality: string; url: string }>;
        }>;
      } = await res.json();

      if (page === 1) {
        playlistTitle = data.title;
        totalVideoCount = data.videoCount;
      }

      if (!data.videos || data.videos.length === 0) break;

      for (const v of data.videos) {
        // 削除済み・非公開動画はスキップ
        if (!v.videoId || !v.title) continue;

        const thumb =
          v.videoThumbnails?.find((t) => t.quality === "medium")?.url ??
          v.videoThumbnails?.[0]?.url ??
          `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`;
        allVideos.push({
          youtubeId: v.videoId,
          title: v.title,
          thumbnail: thumb,
        });
      }

      // Invidious returns ~100 per page; stop if we got them all
      if (allVideos.length >= totalVideoCount) break;
    }

    return c.json({
      playlistId,
      title: playlistTitle,
      videoCount: totalVideoCount,
      videos: allVideos,
    });
  } catch (err) {
    console.error("[api] YouTube playlist fetch error:", err);
    return c.json({ error: "Failed to fetch playlist" }, 500);
  }
});

// ---------------------------------------------------------------------------
// WebSocket endpoint
// ---------------------------------------------------------------------------

app.get(
  "/ws",
  upgradeWebSocket(() => ({
    onOpen(_event, ws) {
      console.log("[ws] New connection opened");
    },

    onMessage(event, ws) {
      const data =
        typeof event.data === "string"
          ? event.data
          : event.data instanceof ArrayBuffer
            ? event.data
            : String(event.data);

      handleMessage(ws, data).catch((err) => {
        console.error("[ws] Unhandled error in message handler:", err);
      });
    },

    onClose(_event, ws) {
      console.log("[ws] Connection closed");
      handleDisconnect(ws);
    },

    onError(event, ws) {
      console.error("[ws] WebSocket error:", event);
      handleDisconnect(ws);
    },
  }))
);

// ---------------------------------------------------------------------------
// Server start
// ---------------------------------------------------------------------------

const port = Number(process.env.PORT) || 3000;

const server = serve(
  {
    fetch: app.fetch,
    port,
  },
  (info) => {
    console.log(`[server] DriveSync Tube backend running on port ${info.port}`);
  }
);

injectWebSocket(server);

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Generate a random 6-character alphanumeric room code (uppercase).
 */
function generateRoomCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // Omit confusing chars (0/O, 1/I)
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}
