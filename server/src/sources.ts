import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import net from "node:net";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** Browser-ish UA for upstream media requests (some CDNs reject others). */
export const MEDIA_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const MAX_URL_LEN = 2048;
const RESOLVE_TTL = 30 * 60 * 1000;

export type SourceKind = "youtube" | "vimeo" | "hls" | "dash" | "direct" | "page" | "invalid";

const DIRECT_EXTS = new Set([
  ".mp4", ".m4v", ".webm", ".ogv", ".ogg", ".mov", ".mkv", ".flv", ".avi",
  ".mp3", ".m4a", ".wav", ".oga",
]);

/**
 * Classify what a link is: direct file, HLS playlist, DASH manifest, a
 * YouTube/Vimeo page, or an arbitrary page (resolved server-side later).
 * Also understands our own proxy paths — `/api/stream?u=…` classifies by the
 * inner URL, since that's what actually plays.
 */
export function classifyUrl(input: string, depth = 0): SourceKind {
  const s = (input ?? "").trim();
  if (!s || depth > 3) return s ? "page" : "invalid";
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    try {
      u = new URL(s, "http://cinevox.local");
    } catch {
      return "invalid";
    }
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "invalid";

  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  if (
    host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com") ||
    host === "youtube-nocookie.com" || host.endsWith(".youtube-nocookie.com")
  ) {
    return "youtube";
  }
  if (host === "vimeo.com" || host.endsWith(".vimeo.com") || host === "player.vimeo.com") {
    return "vimeo";
  }

  // Our own proxy endpoints: look at what's inside.
  if (u.pathname === "/api/stream" || u.pathname.startsWith("/api/stream/")) {
    const inner = u.searchParams.get("u");
    return inner ? classifyUrl(inner, depth + 1) : "page";
  }

  const m = /\.([a-z0-9]+)$/i.exec(u.pathname);
  const ext = m ? `.${m[1].toLowerCase()}` : "";
  if (ext === ".m3u8") return "hls";
  if (ext === ".mpd") return "dash";
  if (DIRECT_EXTS.has(ext)) return "direct";
  return "page";
}

/** Friendly title derived from the link itself (direct files / fallback). */
export function titleFromUrl(raw: string): string {
  try {
    const u = new URL(raw);
    let base = u.pathname.split("/").filter(Boolean).pop() ?? "";
    try {
      base = decodeURIComponent(base);
    } catch {
      // malformed escapes — keep raw
    }
    const noExt = base.replace(/\.[a-z0-9]+$/i, "");
    return (noExt || u.hostname).slice(0, 120);
  } catch {
    return "Video link";
  }
}

// --- SSRF guard: never let a pasted link or manifest point the server at
// --- loopback/private/link-local space (cloud metadata included).

function isPublicIPv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = p;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 169 && b === 254) return false; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF / TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a >= 224) return false; // multicast / reserved / broadcast
  return true;
}

function isPublicIPv6(ip: string): boolean {
  const h = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "::" || h === "::1") return false;
  if (/^fe[89ab]/.test(h)) return false; // link-local fe80::/10
  if (/^f[cd]/.test(h)) return false; // unique local fc00::/7
  if (h.startsWith("ff")) return false; // multicast
  const v4 = /:ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  if (v4) return isPublicIPv4(v4[1]);
  return true;
}

function isPublicAddress(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) return isPublicIPv4(ip);
  if (v === 6) return isPublicIPv6(ip);
  return false;
}

const hostSafety = new Map<string, { safe: boolean; until: number }>();

async function isPublicHost(hostname: string): Promise<boolean> {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const cached = hostSafety.get(h);
  if (cached && cached.until > Date.now()) return cached.safe;

  let safe = false;
  if (
    h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") ||
    h.endsWith(".internal") || h.endsWith(".localdomain")
  ) {
    safe = false;
  } else if (net.isIP(h) !== 0) {
    safe = isPublicAddress(h);
  } else {
    try {
      const addrs = await lookup(h, { all: true, verbatim: true });
      safe = addrs.length > 0 && addrs.every((a) => isPublicAddress(a.address));
    } catch {
      safe = false;
    }
  }
  hostSafety.set(h, { safe, until: Date.now() + 10 * 60 * 1000 });
  return safe;
}

export type ValidateResult = { ok: true; url: string } | { ok: false; error: string };

/** Shape + reachability-policy check for a user-supplied link. */
export async function validateMediaUrl(raw: string): Promise<ValidateResult> {
  const s = (raw ?? "").trim();
  if (!s) return { ok: false, error: "Paste a video link first." };
  if (s.length > MAX_URL_LEN) return { ok: false, error: "That link is too long." };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: "That doesn't look like a valid link." };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, error: "Only http and https links are supported." };
  }
  if (u.username || u.password) {
    return { ok: false, error: "Links with embedded credentials aren't supported." };
  }
  if (!(await isPublicHost(u.hostname))) {
    return { ok: false, error: "That link points at a blocked (private) address." };
  }
  return { ok: true, url: u.toString() };
}

// --- Resolution: turn any supported link into a playable media URL.

/** Deterministic resolution failure with a message safe to show a user. */
export class SourceError extends Error {
  constructor(public userMessage: string) {
    super(userMessage);
  }
}

interface Resolved {
  title: string;
  mediaUrl: string;
}

const resolveCache = new Map<string, { res: Resolved; expires: number }>();
const inflight = new Map<string, Promise<Resolved>>();

/** Drop a cached resolution (expired signatures, 401/403 upstreams). */
export function invalidateSource(pageUrl: string): void {
  resolveCache.delete(pageUrl);
}

/**
 * A segment 403 means its signed URL went stale — drop any cached resolution
 * whose media URL shares that origin so the next manifest fetch re-resolves.
 */
export function invalidateBySegment(segUrl: string): void {
  let origin: string;
  try {
    origin = new URL(segUrl).origin;
  } catch {
    return;
  }
  for (const [key, entry] of resolveCache) {
    try {
      if (new URL(entry.res.mediaUrl).origin === origin) resolveCache.delete(key);
    } catch {
      resolveCache.delete(key);
    }
  }
}

/** Cap cache lifetime at the upstream signature expiry when it publishes one. */
function urlExpiry(mediaUrl: string): number {
  const yt = /\/expire\/(\d{10})\//.exec(mediaUrl);
  if (yt) return Number(yt[1]) * 1000 - 5 * 60 * 1000;
  const exp = /[?&]exp=(\d{10})/.exec(mediaUrl);
  if (exp) return Number(exp[1]) * 1000 - 5 * 60 * 1000;
  // Netflix CDN style: ?…&e=<unix-epoch>
  const ed = /[?&]e=(\d{10})(?:&|$)/.exec(mediaUrl);
  if (ed) return Number(ed[1]) * 1000 - 5 * 60 * 1000;
  return Date.now() + RESOLVE_TTL;
}

// --- DRM refusal: encrypted streams (FairPlay / Widevine / PlayReady) can't
// --- be decoded by MSE browsers — refuse early with a clear message instead
// --- of a silently stalled video. Clear AES-128 HLS stays allowed (hls.js
// --- decrypts it itself).

const DRM_MSG =
  "This video is DRM-protected and can't be played here — try a source without DRM.";
const DRM_KEYFORMAT =
  /com\.apple\.streamingkeydelivery|urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed|urn:uuid:9a04f079-97ad-4de2-b1f4-8b0f4c1c9f1a/i;

/** DRM markers in an HLS playlist or DASH manifest; null when playable. */
export function detectDrmManifest(text: string): string | null {
  const keys = /#EXT-X-KEY:([^\r\n]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = keys.exec(text))) {
    const attrs = m[1];
    const method = /METHOD=([^,\s]+)/.exec(attrs)?.[1] ?? "";
    if (!method || method === "NONE") continue;
    const keyformat = /KEYFORMAT="?([^",\s]+)"?/i.exec(attrs)?.[1] ?? "";
    const drmFormat = DRM_KEYFORMAT.test(keyformat);
    if (method === "AES-128" && !drmFormat) continue; // clear HLS encryption
    if (method.startsWith("SAMPLE-AES") || drmFormat) return DRM_MSG;
    return DRM_MSG; // unknown encryption method — assume DRM
  }
  const protections = /<ContentProtection\b[^>]*>/gi;
  while ((m = protections.exec(text))) {
    if (/urn:uuid:/i.test(m[0]) || /cenc:default_KID=/i.test(m[0])) return DRM_MSG;
  }
  return null;
}

/** `<origin>/` for absolute http(s) URLs — a sensible hotlink Referer. */
export function pageReferer(pageUrl: string): string | undefined {
  try {
    const u = new URL(pageUrl);
    if (u.protocol === "http:" || u.protocol === "https:") return `${u.origin}/`;
  } catch {
    // not a URL — no referer
  }
  return undefined;
}

/**
 * Fetch upstream, retrying once with `referer` when the plain request fails:
 * some handoff CDNs answer 500/403 to hotlinks that arrive without one.
 * Plain-first keeps referer-sensitive hosts that already worked unchanged.
 */
export async function fetchWithReferer(
  url: string,
  init: RequestInit & { referer?: string }
): Promise<Response> {
  const { referer, ...rest } = init;
  let r = await fetch(url, rest);
  if (r.ok || !referer) return r;
  await r.body?.cancel().catch(() => {});
  const headers = new Headers(rest.headers);
  headers.set("referer", referer);
  return fetch(url, { ...rest, headers });
}

async function fetchManifestText(url: string, referer?: string): Promise<string> {
  let r: Response;
  try {
    r = await fetchWithReferer(url, {
      headers: { "user-agent": MEDIA_UA },
      signal: AbortSignal.timeout(12_000),
      referer,
    });
  } catch {
    throw new SourceError("Couldn't load that stream's playlist — the link may be dead.");
  }
  if (!r.ok) throw new SourceError(`Couldn't load that stream's playlist (HTTP ${r.status}).`);
  return r.text();
}

/** First media variant (`.m3u8` line) in a master playlist, absolute URL. */
function firstVariantUrl(manifestText: string, baseUrl: string): string | null {
  for (const raw of manifestText.split("\n")) {
    const t = raw.trim();
    if (!t || t.startsWith("#") || !/\.m3u8(\?|#|$)/i.test(t)) continue;
    try {
      return new URL(t, baseUrl).toString();
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Read-time DRM gate: parse the playlist and — for HLS — peek into the first
 * variant, where FairPlay key tags often live. Throws SourceError on DRM or
 * an unreadable playlist so `movie:select` can fail with a friendly toast.
 */
async function assertPlayableManifest(pageUrl: string, kind: "hls" | "dash"): Promise<void> {
  const referer = pageReferer(pageUrl);
  const text = await fetchManifestText(pageUrl, referer);
  let drm = detectDrmManifest(text);
  if (!drm && kind === "hls") {
    const variant = firstVariantUrl(text, pageUrl);
    if (variant) {
      try {
        if (await isPublicHost(new URL(variant).hostname)) {
          const vt = await fetchManifestText(variant, referer).catch(() => null);
          drm = vt ? detectDrmManifest(vt) : null;
        }
      } catch {
        // Malformed variant URL — let serve-time errors handle it.
      }
    }
  }
  if (drm) throw new SourceError(drm);
}

/**
 * Resolve any supported link to `{ title, mediaUrl }`.
 * Direct files/playlists pass through; Vimeo uses the official player config
 * endpoint; everything else goes through yt-dlp (YouTube included).
 * Throws SourceError with a user-facing message on failure.
 */
export async function resolveSource(pageUrl: string): Promise<Resolved> {
  const kind = classifyUrl(pageUrl);
  if (kind === "direct") {
    return { title: titleFromUrl(pageUrl), mediaUrl: pageUrl };
  }
  if (kind === "hls" || kind === "dash") {
    await assertPlayableManifest(pageUrl, kind);
    return { title: titleFromUrl(pageUrl), mediaUrl: pageUrl };
  }

  const cached = resolveCache.get(pageUrl);
  if (cached && cached.expires > Date.now()) return cached.res;

  const pending = inflight.get(pageUrl);
  if (pending) return pending;

  const job = (async (): Promise<Resolved> => {
    const res = kind === "vimeo" ? await resolveVimeo(pageUrl) : await resolveYtdlp(pageUrl);
    let host: string;
    try {
      host = new URL(res.mediaUrl).hostname;
    } catch {
      throw new SourceError("That link resolved to an invalid stream address.");
    }
    if (!(await isPublicHost(host))) {
      throw new SourceError("That video resolves to a blocked address.");
    }
    // Page/video links that resolve to HLS/DASH get the same DRM gate.
    const resKind = classifyUrl(res.mediaUrl);
    if (resKind === "hls" || resKind === "dash") {
      await assertPlayableManifest(res.mediaUrl, resKind);
    }
    resolveCache.set(pageUrl, {
      res,
      expires: Math.min(Date.now() + RESOLVE_TTL, urlExpiry(res.mediaUrl)),
    });
    return res;
  })();

  inflight.set(pageUrl, job);
  try {
    return await job;
  } finally {
    inflight.delete(pageUrl);
  }
}

/** Map yt-dlp stderr to a message that tells the user what to do next. */
export function mapYtdlpError(stderr: string): string {
  const s = String(stderr ?? "");
  if (/unsupported url/i.test(s)) {
    return "That site isn't supported yet — try a direct video link (MP4/HLS/DASH).";
  }
  if (/\bdrm\b|encrypted/i.test(s)) {
    return "That video is DRM-protected, so it can't be played.";
  }
  if (/logged-in|log in|sign in|cookies|credentials|netrc|password|private video/i.test(s)) {
    return "That video needs a sign-in (or is private), so it can't be played.";
  }
  if (/unavailable|removed|does not exist|404|no video/i.test(s)) {
    return "That video is unavailable.";
  }
  if (/unable to download|http error|urlopen error|connection|timed? ?out/i.test(s)) {
    return "Couldn't download that video's stream.";
  }
  return "Couldn't resolve that link.";
}

function parseVimeoId(pageUrl: string): string | null {
  try {
    const u = new URL(pageUrl);
    const m = /(\d{6,12})/.exec(u.pathname);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Vimeo via the official player config endpoint (the same JSON the official
 * embed player loads). Public videos only — private/age-gated configs fail
 * with a clear error, which we surface instead of working around.
 */
async function resolveVimeo(pageUrl: string): Promise<Resolved> {
  const id = parseVimeoId(pageUrl);
  if (!id) throw new SourceError("That doesn't look like a Vimeo link.");

  let data: any;
  try {
    const r = await fetch(`https://player.vimeo.com/video/${id}/config`, {
      headers: { "user-agent": MEDIA_UA, referer: `https://vimeo.com/${id}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (r.status === 401 || r.status === 403) {
      throw new SourceError("That Vimeo video is private or needs sign-in.");
    }
    if (r.status === 404) throw new SourceError("Couldn't find that Vimeo video.");
    if (!r.ok) throw new SourceError("Couldn't reach Vimeo right now.");
    data = await r.json();
  } catch (err) {
    if (err instanceof SourceError) throw err;
    throw new SourceError("Couldn't reach Vimeo right now.");
  }

  const title = String(data?.video?.title ?? "").trim().slice(0, 120) || `Vimeo · ${id}`;
  const files = data?.request?.files ?? {};

  const progressive = Array.isArray(files.progressive) ? files.progressive : [];
  const best = progressive
    .filter((p: any) => typeof p?.url === "string")
    .sort((a: any, b: any) => (b.height ?? 0) - (a.height ?? 0))[0];
  if (best) return { title, mediaUrl: String(best.url) };

  const hls = files.hls ?? {};
  const cdns = hls.cdns ?? {};
  const cdn = cdns[hls.default_cdn] ?? Object.values(cdns)[0];
  const hlsUrl = cdn && (cdn.avc_url || cdn.url);
  if (typeof hlsUrl === "string" && hlsUrl.startsWith("http")) {
    return { title, mediaUrl: hlsUrl };
  }
  throw new SourceError("That Vimeo video has no playable stream.");
}

/** Property/name attribute value from the first matching <meta> tag. */
function metaTagValue(html: string, prop: string): string | null {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']` +
      `|<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`,
    "i"
  );
  const m = re.exec(html);
  return (m && (m[1] || m[2])) || null;
}

const AD_EMBED =
  /doubleclick|googlesyndication|adservice|adnxs|taboola|outbrain|scorecardresearch|facebook\.net/i;

interface EmbedCandidate {
  url: string;
  title?: string;
}

/**
 * Watch pages that only embed their player in an iframe (animegg-style sites)
 * read as "Unsupported URL" to yt-dlp. Scrape the page for og:video and
 * player iframes so those links still resolve; ads are skipped and every
 * candidate is SSRF-checked. Returns at most 3 candidates, best first.
 */
async function discoverEmbedCandidates(pageUrl: string): Promise<EmbedCandidate[]> {
  let html: string;
  try {
    const r = await fetch(pageUrl, {
      headers: { "user-agent": MEDIA_UA },
      signal: AbortSignal.timeout(12_000),
    });
    if (!r.ok) return [];
    html = (await r.text()).slice(0, 1_000_000);
  } catch {
    return [];
  }
  const ogTitle = metaTagValue(html, "og:title") ?? undefined;
  const ogVideo =
    metaTagValue(html, "og:video:secure_url") ??
    metaTagValue(html, "og:video:url") ??
    metaTagValue(html, "og:video");
  const raws: string[] = ogVideo ? [ogVideo] : [];
  for (const m of html.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)) raws.push(m[1]);

  const out: EmbedCandidate[] = [];
  for (const raw of raws) {
    if (out.length >= 3) break;
    const t = raw.trim();
    if (!t || /^(javascript|about|data):/i.test(t) || AD_EMBED.test(t)) continue;
    let abs: string;
    try {
      abs = new URL(t, pageUrl).toString();
    } catch {
      continue;
    }
    const v = await validateMediaUrl(abs);
    if (!v.ok || out.some((c) => c.url === v.url)) continue;
    out.push({ url: v.url, title: ogTitle });
  }
  return out;
}

async function resolveYtdlp(pageUrl: string, depth = 0): Promise<Resolved> {
  let stdout: string;
  try {
    const r = await execFileP(
      "yt-dlp",
      ["--no-playlist", "--no-warnings", "-f", "b", "--get-title", "--get-url", "--", pageUrl],
      { timeout: 45_000, maxBuffer: 4 << 20 }
    );
    stdout = r.stdout;
  } catch (err) {
    const e = err as { stderr?: string; killed?: boolean; code?: string | number };
    const stderr = String(e.stderr ?? "");
    if (e.killed || e.code === "ETIMEDOUT" || /timed out|timeout/i.test(stderr)) {
      throw new SourceError("Looking up that link took too long.");
    }
    if (depth === 0 && /unsupported url/i.test(stderr)) {
      // Page URL with the player behind an og:video tag or an iframe:
      // try each embed directly (one level only — embeds don't nest).
      for (const cand of await discoverEmbedCandidates(pageUrl)) {
        const k = classifyUrl(cand.url);
        if (k === "direct" || k === "hls" || k === "dash") {
          return { title: (cand.title || titleFromUrl(cand.url)).slice(0, 120), mediaUrl: cand.url };
        }
        try {
          return k === "vimeo" ? await resolveVimeo(cand.url) : await resolveYtdlp(cand.url, depth + 1);
        } catch {
          // Not the player — try the next embed.
        }
      }
    }
    throw new SourceError(mapYtdlpError(stderr || String(err)));
  }
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const mediaUrl = lines.find((l) => l.startsWith("http"));
  const titles = lines.filter((l) => !l.startsWith("http"));
  if (!mediaUrl) throw new SourceError(mapYtdlpError(stdout));
  // Generic-extractor playlists number every title ("Foo (1)") — drop the index.
  let title = titles[0] || titleFromUrl(pageUrl);
  if (titles.length > 1) title = title.replace(/\s\(\d+\)$/, "");
  return { title: title.slice(0, 120), mediaUrl };
}

// --- Manifest rewriting: every URL inside a playlist/manifest goes through
// --- /api/seg so the browser stays same-origin (WebGL textures need CORS).

/** Encode a URL for our `?u=` param while keeping `$…$` DASH templates intact. */
export function encodeProxyParam(s: string): string {
  return encodeURIComponent(s).replace(/%24/gi, "$").replace(/%2A/gi, "*");
}

/** Resolve `raw` against `baseUrl` and route it through /api/seg. */
export function toProxyUrl(raw: string, baseUrl: string): string {
  const t = (raw ?? "").trim();
  if (!t || t.startsWith("/api/")) return raw;
  try {
    const abs = new URL(t, baseUrl);
    if (abs.protocol !== "http:" && abs.protocol !== "https:") return raw;
    return `/api/seg?u=${encodeProxyParam(abs.toString())}`;
  } catch {
    return raw;
  }
}

/** Rewrite an m3u8 so playlist/key/map/segment URLs go through us. */
export function rewriteHlsManifest(text: string, baseUrl: string): string {
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

/**
 * Rewrite an MPD so BaseURL and segment template/URL attributes resolve
 * against the manifest's own origin — then through /api/seg. `$Number$`-style
 * template variables survive because encodeProxyParam keeps literal `$`.
 */
export function rewriteDashManifest(xml: string, baseUrl: string): string {
  return xml
    .replace(
      /<BaseURL>\s*([^<]+?)\s*<\/BaseURL>/g,
      (_m, u) => `<BaseURL>${toProxyUrl(String(u), baseUrl)}</BaseURL>`
    )
    .replace(/\b(media|initialization|sourceURL)="([^"]*)"/g, (_m, attr, val) => {
      if (/^\s*urn:/.test(String(val))) return `${attr}="${val}"`;
      return `${attr}="${toProxyUrl(String(val), baseUrl)}"`;
    });
}
