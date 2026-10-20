/** Shared helpers for classifying pasted video links (client side). */
import { parseYouTubeId } from "./youtube";

export type SourceKind = "youtube" | "vimeo" | "hls" | "dash" | "direct" | "page" | "invalid";

const DIRECT_EXTS = new Set([
  ".mp4", ".m4v", ".webm", ".ogv", ".ogg", ".mov", ".mkv", ".flv", ".avi",
  ".mp3", ".m4a", ".wav", ".oga",
]);

/**
 * Turn pasted text into an absolute http(s) URL, or null when it can't be one.
 * Accepts bare domains ("example.com/v.mp4") the same way parseYouTubeId does.
 */
export function normalizeMediaUrl(input: string): string | null {
  const s = (input ?? "").trim();
  if (!s) return null;
  try {
    const u = new URL(s.startsWith("http://") || s.startsWith("https://") ? s : `https://${s}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    if (u.toString().length > 2048) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Classify a link for the UI badge and for playback routing:
 * direct file, HLS playlist, DASH manifest, YouTube/Vimeo page, or an
 * arbitrary page (server resolves it). Understands our own proxy paths too —
 * `/api/stream?u=…` classifies by the inner URL.
 */
export function classifySource(input: string, depth = 0): SourceKind {
  const s = (input ?? "").trim();
  if (!s || depth > 3) return s ? "page" : "invalid";
  if (parseYouTubeId(s)) return "youtube";

  let u: URL;
  try {
    u = new URL(s);
  } catch {
    const norm = normalizeMediaUrl(s);
    if (!norm) return "invalid";
    u = new URL(norm);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "invalid";

  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  if (host === "vimeo.com" || host.endsWith(".vimeo.com") || host === "player.vimeo.com") {
    return "vimeo";
  }

  // Our own proxy endpoints: look at what's inside.
  if (u.pathname === "/api/stream" || u.pathname.startsWith("/api/stream/")) {
    const inner = u.searchParams.get("u");
    return inner ? classifySource(inner, depth + 1) : "page";
  }

  const m = /\.([a-z0-9]+)$/i.exec(u.pathname);
  const ext = m ? `.${m[1].toLowerCase()}` : "";
  if (ext === ".m3u8") return "hls";
  if (ext === ".mpd") return "dash";
  if (DIRECT_EXTS.has(ext)) return "direct";
  return "page";
}

/** Short explainer shown under the link field for each kind. */
export function sourceLabel(kind: SourceKind): string {
  switch (kind) {
    case "youtube":
      return "YouTube — plays on the cinema screen.";
    case "vimeo":
      return "Vimeo — plays on the cinema screen.";
    case "hls":
      return "HLS stream (.m3u8).";
    case "dash":
      return "MPEG-DASH stream (.mpd).";
    case "direct":
      return "Direct video file.";
    case "page":
      return "Video page — resolved automatically when you press Play.";
    case "invalid":
      return "That doesn't look like a video link.";
  }
}
