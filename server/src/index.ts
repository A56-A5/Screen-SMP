import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import express from "express";
import { Server } from "socket.io";
import { RoomManager, SAMPLE_VIDEOS } from "./rooms.js";
import {
  MEDIA_UA,
  SourceError,
  classifyUrl,
  detectDrmManifest,
  fetchWithReferer,
  invalidateBySegment,
  invalidateSource,
  pageReferer,
  rewriteDashManifest,
  rewriteHlsManifest,
  resolveSource,
  validateMediaUrl,
  ytCookiesFile,
} from "./sources.js";
import type {
  Appearance,
  ChatSendPayload,
  CreateRoomPayload,
  EmotePayload,
  JoinRoomPayload,
  MovePayload,
  PlaybackCommandPayload,
  SelectVideoPayload,
} from "./types.js";

const PORT = Number(process.env.PORT ?? 4000);
const CLIENT_ORIGIN = (
  process.env.CLIENT_ORIGIN ??
  (process.env.NODE_ENV === "production" ? "" : "http://localhost:5173")
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const app = express();

// Cross-origin API/media access only matters when the client is hosted
// elsewhere (CLIENT_ORIGIN set). Same-origin deploys — we serve the built
// client ourselves below — never send a foreign Origin, so this is skipped.
if (CLIENT_ORIGIN.length) {
  const allowAll = CLIENT_ORIGIN.includes("*");
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (allowAll || CLIENT_ORIGIN.includes(origin))) {
      res.setHeader("access-control-allow-origin", allowAll ? "*" : origin);
      res.setHeader("vary", "Origin");
      res.setHeader("access-control-allow-methods", "GET,HEAD,POST,OPTIONS");
      res.setHeader("access-control-allow-headers", "content-type,range");
      res.setHeader("access-control-expose-headers", "content-range,content-length,accept-ranges");
    }
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });
}
app.get("/health", (_req, res) => {
  res.json({ ok: true, rooms: manager.listPublicRooms().length });
});
app.get("/api/videos", (_req, res) => {
  res.json({ videos: SAMPLE_VIDEOS });
});

// --- YouTube live-stream proxy (pasted YouTube video links) ---
// yt-dlp resolves the stream URL; we proxy the HLS master playlist and its
// segments/variants through this server so the browser stays same-origin.
// The client plays it with hls.js (Chrome has no native HLS).
const execFileP = promisify(execFile);
const YT_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// Optional yt-dlp cookies come from sources.ts (YOUTUBE_COOKIES_B64 env) —
// the official answer when an IP is hard bot-checked.

// bgutil PO-Token server (bundled in the Docker image) — generates the tokens
// YouTube demands from datacenter IPs ("Sign in to confirm you're not a bot").
// No-op on dev machines, which already run their own yt-dlp POT plugin.
const BGUTIL_MAIN = process.env.BGUTIL_MAIN ?? "/opt/bgutil/server/build/main.js";
let bgutilProc: ReturnType<typeof spawn> | undefined;
if (process.env.BGUTIL_DISABLED !== "1" && fs.existsSync(BGUTIL_MAIN)) {
  bgutilProc = spawn(process.execPath, [BGUTIL_MAIN], { stdio: "ignore" });
  bgutilProc.on("error", (err) => console.error("[bgutil] failed to start:", err.message));
  bgutilProc.on("exit", (code) => console.error(`[bgutil] exited (code ${code})`));
}

const ytUrlCache = new Map<string, { url: string; expires: number }>();
const YT_URL_TTL = 30 * 60 * 1000;
// Clients tried in order via the handler's retry loop:
//  - web_embedded: progressive MP4 (itag 18: video+audio in one file) with no
//    PO token — fast path for normal videos on unflagged IPs.
//  - web + PO token (bgutil): survives datacenter-IP bot checks that reject
//    every anonymous request ("Sign in to confirm you're not a bot").
//  - android: fallback for videos with embedding DISABLED — their embedded
//    URLs are issued fine but every fetch 403s (sefc enforcement).
const YT_CLIENTS = ["web_embedded", "web", "android"] as const;
type YTClient = (typeof YT_CLIENTS)[number];

async function resolveYouTube(videoId: string, client: YTClient): Promise<string> {
  const cached = ytUrlCache.get(videoId);
  if (cached && cached.expires > Date.now()) return cached.url;
  const args: string[] = ["--extractor-args", `youtube:player_client=${client}`];
  if (ytCookiesFile) args.push("--cookies", ytCookiesFile);
  args.push("-g", "-f", "b", "--no-playlist", "--", `https://www.youtube.com/watch?v=${videoId}`);
  // 60s: the web+PO-token path generates a token first (a few seconds).
  const { stdout } = await execFileP("yt-dlp", args, { timeout: 60_000, maxBuffer: 1 << 20 });
  const url = stdout.trim().split("\n")[0];
  if (!url?.startsWith("http")) throw new Error("yt-dlp returned no URL");
  // Respect YouTube's own expire/<unix> stamp — never cache past it.
  const expMatch = /\/expire\/(\d{10})\//.exec(url);
  const ytExpiry = expMatch ? Number(expMatch[1]) * 1000 - 5 * 60 * 1000 : Date.now() + YT_URL_TTL;
  ytUrlCache.set(videoId, { url, expires: Math.min(Date.now() + YT_URL_TTL, ytExpiry) });
  return url;
}

/** 401/403 from googlevideo = stale signature → drop cache and retry once. */
function isExpiredStatus(status: number): boolean {
  return status === 401 || status === 403;
}

function isAllowedYouTubeHost(host: string): boolean {
  return host.endsWith(".googlevideo.com") || host.endsWith(".youtube.com") || host === "youtube.com";
}

function toProxyUrl(raw: string, baseUrl: string): string {
  try {
    const abs = new URL(raw, baseUrl);
    if (!isAllowedYouTubeHost(abs.hostname)) return raw;
    return `/api/youtube/seg?u=${encodeURIComponent(abs.toString())}`;
  } catch {
    return raw;
  }
}

/** Rewrite an m3u8 so every playlist/key/map/segment URL goes through us. */
function rewriteManifest(text: string, baseUrl: string): string {
  return text
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith("#")) {
        // EXT-X-KEY / EXT-X-MAP carry URI="..." attributes.
        return line.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${toProxyUrl(uri, baseUrl)}"`);
      }
      return toProxyUrl(t, baseUrl);
    })
    .join("\n");
}

app.get("/api/youtube/stream", async (req, res) => {
  const videoId = String(req.query.videoId ?? "");
  if (!/^[A-Za-z0-9_-]{5,20}$/.test(videoId)) {
    return res.status(400).json({ error: "Invalid videoId." });
  }
  for (let attempt = 0; attempt < YT_CLIENTS.length; attempt++) {
    // Failures below (yt-dlp error, 401/403 sniff, upstream reset) fall
    // through to the next client: bot-checked IPs land on web+PO-token,
    // embed-restricted videos land on android.
    const client = YT_CLIENTS[attempt];
    const lastAttempt = attempt === YT_CLIENTS.length - 1;
    try {
      const url = await resolveYouTube(videoId, client);
      // Sniff with a tiny ranged GET (read first chunk only, then cancel) —
      // never buffer whole media files: they stream through instead.
      const sniff = await fetch(url, {
        headers: { "user-agent": YT_UA, range: "bytes=0-63" },
        signal: AbortSignal.timeout(20_000),
      });
      if (isExpiredStatus(sniff.status)) {
        ytUrlCache.delete(videoId);
        if (!lastAttempt) continue; // re-resolve with a fresh signature
        return res.status(502).json({ error: "YouTube rejected the stream. Re-select the video." });
      }
      if (!sniff.ok) throw new Error(`upstream ${sniff.status}`);
      let first: Uint8Array | undefined;
      const reader = sniff.body?.getReader();
      if (reader) {
        const { value } = await reader.read();
        first = value;
        await reader.cancel().catch(() => {});
      }
      const isM3u8 = Buffer.from(first ?? new Uint8Array(0))
        .toString("latin1")
        .trimStart()
        .startsWith("#EXTM3U");

      // HEAD (the client's type-sniff): answer from the byte probe, no full
      // fetch. googlevideo content-types LIE for HLS playlists — trusting
      // them made the client attach <video> to an m3u8 (Chrome has no native
      // HLS) so "some" links showed a title and never played.
      if (req.method === "HEAD") {
        const ct = sniff.headers.get("content-type");
        if (isM3u8) res.setHeader("content-type", "application/vnd.apple.mpegurl");
        else res.setHeader("content-type", ct ?? "video/mp4");
        const total = sniff.headers.get("content-range")?.split("/")[1];
        if (total && total !== "*") res.setHeader("content-length", total);
        return res.end();
      }

      if (isM3u8) {
        const full = await fetch(url, { headers: { "user-agent": YT_UA }, signal: AbortSignal.timeout(20_000) });
        if (isExpiredStatus(full.status)) {
          ytUrlCache.delete(videoId);
          if (!lastAttempt) continue;
          return res.status(502).json({ error: "YouTube rejected the stream. Re-select the video." });
        }
        if (!full.ok) throw new Error(`upstream ${full.status}`);
        const text = await full.text();
        res.setHeader("content-type", "application/vnd.apple.mpegurl");
        return res.send(rewriteManifest(text, url));
      }

      // Direct media file (VOD): stream through with Range passthrough.
      // NO timeout signal here — it would also abort the body mid-download
      // (that crashed the server before via an unhandled pipe error).
      const upstream = await fetch(url, {
        headers: { "user-agent": YT_UA, ...(req.headers.range ? { range: req.headers.range } : {}) },
      });
      if (isExpiredStatus(upstream.status)) {
        ytUrlCache.delete(videoId);
        if (!lastAttempt) continue;
        return res.status(502).json({ error: "YouTube rejected the stream. Re-select the video." });
      }
      if (!upstream.ok) {
        res.status(upstream.status);
        return res.end();
      }
      res.status(upstream.status);
      for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) {
        const v = upstream.headers.get(h);
        if (v) res.setHeader(h, v);
      }
      if (!upstream.body) return res.end();
      const stream = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream);
      stream.on("error", () => res.destroy()); // never crash the process
      res.on("close", () => stream.destroy());
      stream.pipe(res);
      return;
    } catch (err) {
      if (!lastAttempt) continue; // transient → try the next client
      console.error("[youtube-proxy]", err);
      const stderr = String((err as { stderr?: string }).stderr ?? "");
      const botCheck = /not a bot|Sign in to confirm/i.test(stderr);
      if (!res.headersSent) {
        res.status(502).json({
          error: botCheck
            ? "YouTube is bot-checking this server's IP. Set YOUTUBE_COOKIES_B64 (see README) or try again later."
            : "Could not resolve YouTube stream.",
        });
      }
      return;
    }
  }
});

// Playlist variants, encryption keys, init maps, and media segments.
app.get("/api/youtube/seg", async (req, res) => {
  const raw = String(req.query.u ?? "");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return res.status(400).json({ error: "Bad segment URL." });
  }
  if (!isAllowedYouTubeHost(parsed.hostname)) {
    return res.status(403).json({ error: "Host not allowed." });
  }
  try {
    const upstream = await fetch(parsed, {
      headers: {
        "user-agent": YT_UA,
        ...(req.headers.range ? { range: req.headers.range } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!upstream.ok) {
      if (isExpiredStatus(upstream.status)) {
        // Stale signed segment URL: drop the cached master so the next
        // manifest refresh re-resolves with a fresh signature.
        const idMatch = /\/id\/([A-Za-z0-9_-]{5,20})/.exec(parsed.pathname);
        if (idMatch) ytUrlCache.delete(idMatch[1]);
      }
      res.status(upstream.status);
      return res.end();
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    // Sniff #EXTM3U from bytes — URL/content-type alone are unreliable here.
    if (buf.subarray(0, 16).toString("latin1").trimStart().startsWith("#EXTM3U")) {
      res.setHeader("content-type", "application/vnd.apple.mpegurl");
      return res.send(rewriteManifest(buf.toString("utf8"), parsed.toString()));
    }
    res.setHeader("content-type", upstream.headers.get("content-type") ?? "video/mp2t");
    res.setHeader("accept-ranges", "bytes");
    res.setHeader("content-length", String(buf.length));
    return res.send(buf);
  } catch (err) {
    console.error("[youtube-seg]", err);
    res.status(502).end();
  }
});

// --- Generic media proxy: any pasted link (direct files, HLS, DASH, pages) ---
// The original URL rides in `u`; resolution (yt-dlp / Vimeo config) happens
// here with a cache, so expired signed URLs re-resolve on 401/403 exactly like
// the YouTube path above.
app.get("/api/stream", async (req, res) => {
  const check = await validateMediaUrl(String(req.query.u ?? ""));
  if (!check.ok) return res.status(400).json({ error: check.error });
  const pageUrl = check.url;

  for (let attempt = 0; attempt < 2; attempt++) {
    // 401/403 = stale signed URL: drop cache, re-resolve once, then give up.
    const retryOr502 = (): boolean => {
      if (attempt === 0) return true;
      if (!res.headersSent) {
        res.status(502).json({ error: "The video source rejected the stream. Try selecting it again." });
      }
      return false;
    };
    try {
      const kind = classifyUrl(pageUrl);
      let target = pageUrl;
      if (kind !== "direct" && kind !== "hls" && kind !== "dash") {
        target = (await resolveSource(pageUrl)).mediaUrl;
      }

      // Sniff with a tiny ranged GET (first chunk only) — never buffer whole
      // media files; playlists/manifests get fully fetched below instead.
      const sniff = await fetchWithReferer(target, {
        headers: { "user-agent": MEDIA_UA, range: "bytes=0-63" },
        signal: AbortSignal.timeout(20_000),
        referer: pageReferer(pageUrl),
      });
      if (sniff.status === 401 || sniff.status === 403) {
        invalidateSource(pageUrl);
        if (!retryOr502()) return;
        continue;
      }
      if (!sniff.ok) throw new Error(`upstream ${sniff.status}`);
      const reader = sniff.body?.getReader();
      let first: Uint8Array | undefined;
      if (reader) {
        const { value } = await reader.read();
        first = value;
        await reader.cancel().catch(() => {});
      }
      const head = Buffer.from(first ?? new Uint8Array(0)).toString("latin1").trimStart();
      const isM3u8 = head.startsWith("#EXTM3U");
      const isMpd = head.startsWith("<?xml") || head.startsWith("<MPD") || /\.mpd(\?|$)/i.test(target);

      // The client's type-sniff: answer from the byte probe.
      if (req.method === "HEAD") {
        if (isM3u8) res.setHeader("content-type", "application/vnd.apple.mpegurl");
        else if (isMpd) res.setHeader("content-type", "application/dash+xml");
        else res.setHeader("content-type", sniff.headers.get("content-type") ?? "video/mp4");
        const total = sniff.headers.get("content-range")?.split("/")[1];
        if (total && total !== "*") res.setHeader("content-length", total);
        return res.end();
      }

      if (isM3u8 || isMpd) {
        const full = await fetchWithReferer(target, {
          headers: { "user-agent": MEDIA_UA },
          signal: AbortSignal.timeout(30_000),
          referer: pageReferer(pageUrl),
        });
        if (full.status === 401 || full.status === 403) {
          invalidateSource(pageUrl);
          if (!retryOr502()) return;
          continue;
        }
        if (!full.ok) throw new Error(`upstream ${full.status}`);
        const finalBase = full.url || target;
        const text = await full.text();
        // Serve-time DRM gate (select-time may have missed late key tags).
        const drm = detectDrmManifest(text);
        if (drm) throw new SourceError(drm);
        if (isM3u8) {
          res.setHeader("content-type", "application/vnd.apple.mpegurl");
          return res.send(rewriteHlsManifest(text, finalBase));
        }
        res.setHeader("content-type", "application/dash+xml");
        return res.send(rewriteDashManifest(text, finalBase));
      }

      // Direct media file: stream through with Range passthrough.
      // NO timeout signal on the body — it would abort mid-download (that
      // crashed the server before via an unhandled pipe error).
      const upstream = await fetchWithReferer(target, {
        headers: {
          "user-agent": MEDIA_UA,
          ...(req.headers.range ? { range: req.headers.range } : {}),
        },
        referer: pageReferer(pageUrl),
      });
      if (upstream.status === 401 || upstream.status === 403) {
        invalidateSource(pageUrl);
        if (!retryOr502()) return;
        continue;
      }
      if (!upstream.ok) {
        res.status(upstream.status);
        return res.end();
      }
      res.status(upstream.status);
      for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) {
        const v = upstream.headers.get(h);
        if (v) res.setHeader(h, v);
      }
      if (!upstream.body) return res.end();
      const stream = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream);
      stream.on("error", () => res.destroy()); // never crash the process
      res.on("close", () => stream.destroy());
      stream.pipe(res);
      return;
    } catch (err) {
      if (err instanceof SourceError) {
        // Deterministic (unsupported / DRM / sign-in) — retrying won't help.
        if (!res.headersSent) res.status(422).json({ error: err.userMessage });
        return;
      }
      if (attempt === 0) continue; // transient (timeout / reset) → one retry
      console.error("[stream-proxy]", err);
      if (!res.headersSent) res.status(502).json({ error: "Could not load that video." });
      return;
    }
  }
});

// Playlist variants, encryption keys, init maps, and media segments for the
// generic proxy. Public hosts only (SSRF-guarded); a 401/403 here usually
// means a signed URL expired, so cached resolutions get dropped.
app.get("/api/seg", async (req, res) => {
  const check = await validateMediaUrl(String(req.query.u ?? ""));
  if (!check.ok) return res.status(400).json({ error: check.error });
  try {
    const upstream = await fetch(check.url, {
      headers: {
        "user-agent": MEDIA_UA,
        ...(req.headers.range ? { range: req.headers.range } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!upstream.ok) {
      if (upstream.status === 401 || upstream.status === 403) invalidateBySegment(check.url);
      res.status(upstream.status);
      return res.end();
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    const head = buf.subarray(0, 24).toString("latin1").trimStart();
    const finalBase = upstream.url || check.url;
    if (head.startsWith("#EXTM3U")) {
      const drm = detectDrmManifest(buf.toString("utf8"));
      if (drm) throw new SourceError(drm);
      res.setHeader("content-type", "application/vnd.apple.mpegurl");
      return res.send(rewriteHlsManifest(buf.toString("utf8"), finalBase));
    }
    if (head.startsWith("<?xml") || head.startsWith("<MPD")) {
      const drm = detectDrmManifest(buf.toString("utf8"));
      if (drm) throw new SourceError(drm);
      res.setHeader("content-type", "application/dash+xml");
      return res.send(rewriteDashManifest(buf.toString("utf8"), finalBase));
    }
    res.setHeader("content-type", upstream.headers.get("content-type") ?? "application/octet-stream");
    res.setHeader("accept-ranges", "bytes");
    res.setHeader("content-length", String(buf.length));
    return res.send(buf);
  } catch (err) {
    if (err instanceof SourceError) {
      if (!res.headersSent) res.status(422).json({ error: err.userMessage });
      return;
    }
    console.error("[stream-seg]", err);
    if (!res.headersSent) res.status(502).end();
  }
});

const server = http.createServer(app);
const io = new Server(server, {
  // Empty CLIENT_ORIGIN in production (same-origin deploy) → reflect the
  // requester; dev pins to Vite; split deploys pin via the env.
  cors: { origin: CLIENT_ORIGIN.length ? CLIENT_ORIGIN : true, methods: ["GET", "POST"] },
  maxHttpBufferSize: 1e5, // chat/move payloads only — never file uploads
});

const manager = new RoomManager();

// Advance canonical playback so late joiners get accurate position.
setInterval(() => manager.tickPlayback(), 1000);

// --- Rate limiting ---
interface Bucket {
  count: number;
  resetAt: number;
}
const rateBuckets = new Map<string, Bucket>();

function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}

// Periodically prune rate buckets.
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of rateBuckets) {
    if (now > b.resetAt) rateBuckets.delete(k);
  }
}, 30_000);

function emitError(socket: import("socket.io").Socket, event: string, error: string) {
  socket.emit("error:msg", { event, error });
}

io.on("connection", (socket) => {
  // Send sample catalog on connect.
  socket.emit("videos:catalog", { videos: SAMPLE_VIDEOS });

  socket.on("room:create", (payload: CreateRoomPayload) => {
    if (!rateLimit(`create:${socket.id}`, 5, 60_000)) {
      return emitError(socket, "room:create", "Too many room creations, slow down.");
    }
    if (!payload || typeof payload !== "object") {
      return emitError(socket, "room:create", "Invalid payload.");
    }
    const visibility = payload.visibility === "private" ? "private" : "public";
    const state = manager.createRoom(socket.id, {
      name: String(payload.name ?? ""),
      visibility,
      playerName: String(payload.playerName ?? ""),
      appearance: payload.appearance as Appearance,
    });
    socket.join(state.roomId);
    socket.emit("room:joined", { state });
    socket.broadcast.emit("rooms:updated", { rooms: manager.listPublicRooms() });
  });

  socket.on("room:join", (payload: JoinRoomPayload) => {
    if (!rateLimit(`join:${socket.id}`, 10, 60_000)) {
      return emitError(socket, "room:join", "Too many join attempts, slow down.");
    }
    if (!payload || typeof payload.roomId !== "string") {
      return emitError(socket, "room:join", "Invalid payload.");
    }
    const result = manager.joinRoom(socket.id, {
      roomId: payload.roomId,
      playerName: String(payload.playerName ?? ""),
      appearance: payload.appearance as Appearance,
    });
    if (!result.ok) return emitError(socket, "room:join", result.error);
    socket.join(result.state.roomId);
    socket.emit("room:joined", { state: result.state });
    socket.broadcast.to(result.state.roomId).emit("player:join", {
      player: result.state.players.find((p) => p.id === socket.id),
    });
    socket.broadcast.emit("rooms:updated", { rooms: manager.listPublicRooms() });
  });

  socket.on("room:leave", () => {
    handleLeave(socket);
  });

  socket.on("player:move", (payload: MovePayload) => {
    if (!rateLimit(`move:${socket.id}`, 30, 1000)) return; // 30 moves/sec max
    if (!payload || typeof payload !== "object") return;
    const upd = manager.updatePosition(socket.id, {
      position: payload.position,
      rotationY: payload.rotationY,
      animation: String(payload.animation ?? "idle"),
    });
    if (!upd) return;
    socket.broadcast.to(upd.roomId).emit("player:moved", upd.state);
  });

  socket.on("player:speaking", (payload: { speaking: boolean }) => {
    const upd = manager.setSpeaking(socket.id, Boolean(payload?.speaking));
    if (!upd) return;
    socket.broadcast.to(upd.roomId).emit("player:speaking", upd);
  });

  socket.on("player:emote", (payload: EmotePayload) => {
    if (!rateLimit(`emote:${socket.id}`, 6, 10_000)) return;
    const roomId = manager.getRoomIdForPlayer(socket.id);
    if (!roomId || !payload?.emote) return;
    const emote = String(payload.emote).slice(0, 20);
    socket.broadcast.to(roomId).emit("player:emote", { playerId: socket.id, emote });
  });

  socket.on("chat:send", (payload: ChatSendPayload) => {
    if (!rateLimit(`chat:${socket.id}`, 5, 5000)) {
      return emitError(socket, "chat:send", "You are sending messages too fast.");
    }
    if (!payload || typeof payload.text !== "string") {
      return emitError(socket, "chat:send", "Invalid message.");
    }
    const result = manager.addChat(socket.id, payload.text);
    if (!result.ok) return emitError(socket, "chat:send", result.error);
    io.to(result.roomId).emit("chat:message", result.message);
  });

  socket.on("movie:select", async (payload: SelectVideoPayload) => {
    if (!rateLimit(`select:${socket.id}`, 10, 30_000)) {
      return emitError(socket, "movie:select", "Too many selections, slow down.");
    }
    if (!payload || typeof payload.videoId !== "string") {
      return emitError(socket, "movie:select", "Invalid payload.");
    }
    // YouTube: fetch a friendly title via oEmbed (no API key). Invalid ids
    // get a clear error; network hiccups fall back to a generic title.
    // Arbitrary links: validate (http(s), no private hosts) and resolve NOW —
    // a failed resolve surfaces its friendly error before anything plays.
    let titleHint: string | undefined;
    if (payload.videoId.startsWith("yt:")) {
      const ytId = payload.videoId.slice(3);
      try {
        const watchUrl = `https://www.youtube.com/watch?v=${ytId}`;
        const r = await fetch(
          `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`,
          { signal: AbortSignal.timeout(5000) }
        );
        if (r.status === 400 || r.status === 404 || r.status === 410) {
          return emitError(socket, "movie:select", "Couldn't find that YouTube video.");
        }
        if (r.ok) {
          const info = (await r.json()) as { title?: string };
          titleHint = info.title;
        }
      } catch {
        // timeout / offline — keep going with a fallback title
      }
    } else if (payload.videoId.startsWith("url:")) {
      const encoded = payload.videoId.slice(4);
      let decoded: string;
      try {
        decoded = decodeURIComponent(encoded);
      } catch {
        return emitError(socket, "movie:select", "That link is malformed.");
      }
      const check = await validateMediaUrl(decoded);
      if (!check.ok) return emitError(socket, "movie:select", check.error);
      try {
        titleHint = (await resolveSource(check.url)).title;
      } catch (err) {
        const msg = err instanceof SourceError ? err.userMessage : "Couldn't resolve that link.";
        return emitError(socket, "movie:select", msg);
      }
    }
    const result = manager.selectVideo(socket.id, payload.videoId, titleHint);
    if (!result.ok) return emitError(socket, "movie:select", result.error);
    io.to(result.roomId).emit("movie:state", { playback: result.state });
    io.to(result.roomId).emit("chat:message", {
      id: `sys-${Date.now()}`,
      roomId: result.roomId,
      senderId: "system",
      senderName: "System",
      text: `Now selected: ${result.title}`,
      timestamp: Date.now(),
      kind: "system",
    });
  });

  // Theatre light lever — any player in the room can flip it.
  socket.on("lights:toggle", () => {
    if (!rateLimit(`lights:${socket.id}`, 2, 1_000)) return;
    const result = manager.toggleLights(socket.id);
    if (!result.ok) return;
    io.to(result.roomId).emit("lights:state", { lightsOn: result.lightsOn });
  });

  socket.on("movie:play", () => {
    const result = manager.playbackCommand(socket.id, { action: "play" });
    if (!result.ok) return emitError(socket, "movie:play", result.error);
    io.to(result.roomId).emit("movie:state", { playback: result.state });
  });

  socket.on("movie:pause", () => {
    const result = manager.playbackCommand(socket.id, { action: "pause" });
    if (!result.ok) return emitError(socket, "movie:pause", result.error);
    io.to(result.roomId).emit("movie:state", { playback: result.state });
  });

  socket.on("movie:seek", (payload: PlaybackCommandPayload) => {
    if (!payload || typeof payload.position !== "number") {
      return emitError(socket, "movie:seek", "Invalid position.");
    }
    const result = manager.playbackCommand(socket.id, { action: "seek", position: payload.position });
    if (!result.ok) return emitError(socket, "movie:seek", result.error);
    io.to(result.roomId).emit("movie:state", { playback: result.state });
  });

  socket.on("rooms:list", () => {
    socket.emit("rooms:updated", { rooms: manager.listPublicRooms() });
  });

  socket.on("disconnect", () => {
    handleLeave(socket);
  });

  function handleLeave(socket: import("socket.io").Socket) {
    const result = manager.leaveRoom(socket.id);
    if (!result) return;
    socket.leave(result.roomId);
    socket.to(result.roomId).emit("player:leave", { playerId: socket.id });
    if (result.state) {
      socket.to(result.roomId).emit("room:state", { state: result.state });
    }
    io.emit("rooms:updated", { rooms: manager.listPublicRooms() });
  }
});

// --- Single-origin hosting: serve the built client when it exists ---
// Dev keeps using Vite on :5173; in production (Docker, VPS, Render) this
// same server hands out index.html + hashed assets, so /api and Socket.IO
// are same-origin — no CORS, no separate static host.
const here = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(here, "../../client/dist");
const indexHtml = path.join(clientDist, "index.html");
if (fs.existsSync(indexHtml)) {
  app.use(express.static(clientDist, { index: false, maxAge: "1h" }));
  // SPA fallback: any other GET (not /api, not Socket.IO) gets the app shell.
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api/")) return next();
    res.setHeader("cache-control", "no-cache");
    res.sendFile(indexHtml);
  });
  console.log(`[cinevox] serving client from ${clientDist}`);
}

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[cinevox] port ${PORT} is already in use.\n` +
        `  Another server is still running. Free the port first:\n` +
        `    lsof -ti :4000 | xargs kill -9\n` +
        `  then retry npm run dev.`
    );
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  const corsLabel = CLIENT_ORIGIN.length ? CLIENT_ORIGIN.join(",") : "reflect (same-origin)";
  console.log(`[cinevox] server listening on :${PORT} (cors: ${corsLabel})`);
});

// Always release the port on Ctrl-C / SIGTERM — no lingering listeners.
function shutdown(signal: string): void {
  console.log(`[cinevox] ${signal} — closing server`);
  bgutilProc?.kill();
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Never let a stray async error take the whole server down — log and keep
// serving (clients get 5xx responses from their individual requests).
process.on("unhandledRejection", (reason) => {
  console.error("[cinevox] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[cinevox] uncaughtException:", err);
});
