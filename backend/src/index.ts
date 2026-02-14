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

/**
 * GET /api/youtube/search?q=query
 * Proxy search to YouTube Data API v3.
 */
app.get("/api/youtube/search", async (c) => {
  const query = c.req.query("q");
  if (!query) {
    return c.json({ error: "Query parameter 'q' is required" }, 400);
  }

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    console.error("[api] YOUTUBE_API_KEY is not set");
    return c.json({ error: "YouTube API key is not configured" }, 500);
  }

  try {
    const url = new URL("https://www.googleapis.com/youtube/v3/search");
    url.searchParams.set("part", "snippet");
    url.searchParams.set("type", "video");
    url.searchParams.set("maxResults", "10");
    url.searchParams.set("q", query);
    url.searchParams.set("key", apiKey);

    const response = await fetch(url.toString());

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(
        `[api] YouTube API error (${response.status}):`,
        errorBody
      );
      return c.json(
        { error: "YouTube API request failed", status: response.status },
        502
      );
    }

    const data = await response.json();

    // Transform into a simpler shape for the frontend
    const results = (data.items ?? []).map(
      (item: {
        id: { videoId: string };
        snippet: {
          title: string;
          thumbnails: { medium?: { url: string }; default?: { url: string } };
          channelTitle: string;
        };
      }) => ({
        youtubeId: item.id.videoId,
        title: item.snippet.title,
        thumbnail:
          item.snippet.thumbnails.medium?.url ??
          item.snippet.thumbnails.default?.url ??
          "",
        channelTitle: item.snippet.channelTitle,
      })
    );

    return c.json({ results });
  } catch (err) {
    console.error("[api] YouTube search error:", err);
    return c.json({ error: "Failed to search YouTube" }, 500);
  }
});

/**
 * GET /api/youtube/video?id=VIDEO_ID
 * Fetch video details by YouTube video ID.
 */
app.get("/api/youtube/video", async (c) => {
  const videoId = c.req.query("id");
  if (!videoId) {
    return c.json({ error: "Query parameter 'id' is required" }, 400);
  }

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    console.error("[api] YOUTUBE_API_KEY is not set");
    return c.json({ error: "YouTube API key is not configured" }, 500);
  }

  try {
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "snippet");
    url.searchParams.set("id", videoId);
    url.searchParams.set("key", apiKey);

    const response = await fetch(url.toString());

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(
        `[api] YouTube API error (${response.status}):`,
        errorBody
      );
      return c.json(
        { error: "YouTube API request failed", status: response.status },
        502
      );
    }

    const data = await response.json();

    if (!data.items || data.items.length === 0) {
      return c.json({ error: "Video not found" }, 404);
    }

    const item = data.items[0];
    const result = {
      youtubeId: item.id,
      title: item.snippet.title,
      thumbnail:
        item.snippet.thumbnails.medium?.url ??
        item.snippet.thumbnails.default?.url ??
        "",
      channelTitle: item.snippet.channelTitle,
    };

    return c.json({ result });
  } catch (err) {
    console.error("[api] YouTube video fetch error:", err);
    return c.json({ error: "Failed to fetch video info" }, 500);
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
