import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyUrl,
  detectDrmManifest,
  mapYtdlpError,
  pageReferer,
  rewriteDashManifest,
  rewriteHlsManifest,
  titleFromUrl,
  toProxyUrl,
  validateMediaUrl,
} from "../src/sources.js";

test("classifyUrl detects source kinds", () => {
  assert.equal(classifyUrl("https://example.com/movie.mp4"), "direct");
  assert.equal(classifyUrl("https://example.com/movie.webm"), "direct");
  assert.equal(classifyUrl("https://example.com/clip.MOV?tok=1"), "direct");
  assert.equal(classifyUrl("https://example.com/master.m3u8"), "hls");
  assert.equal(classifyUrl("https://example.com/manifest.mpd"), "dash");
  assert.equal(classifyUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "youtube");
  assert.equal(classifyUrl("https://youtu.be/dQw4w9WgXcQ"), "youtube");
  assert.equal(classifyUrl("https://vimeo.com/123456789"), "vimeo");
  assert.equal(classifyUrl("https://player.vimeo.com/video/123456789"), "vimeo");
  assert.equal(classifyUrl("https://blog.example.com/watch?v=1"), "page");
  assert.equal(classifyUrl("ftp://example.com/v.mp4"), "invalid");
  assert.equal(classifyUrl(""), "invalid");
});

test("classifyUrl understands our proxy paths via the inner URL", () => {
  const hls = `/api/stream?u=${encodeURIComponent("https://x.com/a.m3u8")}`;
  const dash = `/api/stream?u=${encodeURIComponent("https://x.com/a.mpd")}`;
  const file = `/api/stream?u=${encodeURIComponent("https://x.com/a.mp4")}`;
  const page = `/api/stream?u=${encodeURIComponent("https://x.com/watch")}`;
  assert.equal(classifyUrl(hls), "hls");
  assert.equal(classifyUrl(dash), "dash");
  assert.equal(classifyUrl(file), "direct");
  assert.equal(classifyUrl(page), "page");
  assert.equal(classifyUrl("/api/youtube/stream?videoId=abc"), "page");
});

test("titleFromUrl derives a readable title", () => {
  assert.equal(titleFromUrl("https://example.com/videos/My%20Movie.mp4"), "My Movie");
  assert.equal(titleFromUrl("https://example.com/"), "example.com");
  assert.equal(titleFromUrl("nonsense"), "Video link");
});

test("validateMediaUrl accepts public http(s) links", async () => {
  // Public IP literal — shape-checked without needing DNS.
  const ok = await validateMediaUrl("https://93.184.216.34/videos/clip.mp4");
  assert.ok(ok.ok);
  if (ok.ok) assert.equal(ok.url, "https://93.184.216.34/videos/clip.mp4");
});

test("validateMediaUrl rejects unsafe or malformed links", async () => {
  const cases: Array<[string, RegExp]> = [
    ["", /paste/i],
    ["not a link", /valid/i],
    ["ftp://example.com/v.mp4", /http/i],
    ["http://localhost:8080/v.mp4", /blocked/i],
    ["http://localhost./v.mp4", /blocked/i],
    ["http://127.0.0.1/v.mp4", /blocked/i],
    ["http://10.0.0.5/v.mp4", /blocked/i],
    ["http://192.168.1.10/v.mp4", /blocked/i],
    ["http://172.16.4.4/v.mp4", /blocked/i],
    ["http://169.254.169.254/latest/meta-data", /blocked/i],
    ["http://[::1]/v.mp4", /blocked/i],
    ["http://user:pass@example.com/v.mp4", /credentials/i],
    [`https://${"a".repeat(3000)}.example.com/`, /long/i],
  ];
  for (const [input, needle] of cases) {
    const r = await validateMediaUrl(input);
    assert.equal(r.ok, false, `expected rejection for ${JSON.stringify(input.slice(0, 60))}`);
    if (!r.ok) assert.match(r.error, needle);
  }
});

test("mapYtdlpError turns stderr into actionable messages", () => {
  assert.match(
    mapYtdlpError("ERROR: Unsupported URL: https://example.com/"),
    /isn't supported/i
  );
  assert.match(mapYtdlpError("ERROR: This video is DRM protected"), /DRM/i);
  assert.match(
    mapYtdlpError("ERROR: [vimeo] 123: The web client only works when logged-in."),
    /sign-in/i
  );
  assert.match(mapYtdlpError("ERROR: Video unavailable"), /unavailable/i);
  assert.match(mapYtdlpError("HTTP Error 403: Forbidden"), /download|blocked|resolve/i);
  assert.match(mapYtdlpError("some unexplained failure"), /resolve/i);
});

test("pageReferer derives the page origin for hotlink-sensitive hosts", () => {
  assert.equal(pageReferer("https://www.animegg.org/barakamon-episode-7"), "https://www.animegg.org/");
  assert.equal(pageReferer("http://example.com:8080/watch?v=1"), "http://example.com:8080/");
  assert.equal(pageReferer("not a url"), undefined);
  assert.equal(pageReferer("ftp://example.com/f"), undefined);
});

test("toProxyUrl resolves relative URLs and never re-proxies ours", () => {
  const base = "https://cdn.example.com/hls/master.m3u8";
  assert.equal(toProxyUrl("/api/seg?u=x", base), "/api/seg?u=x");
  assert.equal(toProxyUrl("javascript:alert(1)", base), "javascript:alert(1)");
  assert.match(
    toProxyUrl("720p.m3u8", base),
    /^\/api\/seg\?u=https%3A%2F%2Fcdn\.example\.com%2Fhls%2F720p\.m3u8$/
  );
  assert.match(toProxyUrl("../other/seg.ts", base), /%2Fother%2Fseg\.ts$/);
});

test("rewriteHlsManifest routes every playlist URI through the proxy", () => {
  const base = "https://cdn.example.com/hls/master.m3u8";
  const src = [
    "#EXTM3U",
    "#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=1280x720",
    "720p.m3u8",
    "",
    "#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"",
    "/absolute/seg.ts",
    "https://other.example.com/seg2.ts",
    "/api/seg?u=https%3A%2F%2Falready.example.com%2Fx.ts",
  ].join("\n");
  const out = rewriteHlsManifest(src, base);
  assert.ok(out.includes("#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=1280x720"));
  assert.ok(out.includes("/api/seg?u=https%3A%2F%2Fcdn.example.com%2Fhls%2F720p.m3u8"));
  assert.ok(out.includes("URI=\"/api/seg?u="), "key URI proxied");
  assert.ok(out.includes("https%3A%2F%2Fcdn.example.com%2Fabsolute%2Fseg.ts"));
  assert.ok(out.includes("other.example.com%2Fseg2.ts"));
  assert.ok(out.includes("/api/seg?u=https%3A%2F%2Falready.example.com%2Fx.ts"));
  assert.ok(out.includes("#EXT-X-KEY:METHOD=AES-128"), "key tag intact");
});

test("rewriteDashManifest proxies BaseURL/templates and keeps $…$ tokens", () => {
  const base = "https://dash.example.com/vod/manifest.mpd";
  const xml =
    `<MPD mediaPresentationDuration="PT193S"><Period><AdaptationSet>` +
    `<BaseURL>https://alt.example.com/media/</BaseURL>` +
    `<SegmentTemplate initialization="$RepresentationID$-Header.m4s" media="$RepresentationID$-seg-$Number$.m4s"/>` +
    `<SegmentBase sourceURL="init.mp4" indexRange="0-999"/>` +
    `</AdaptationSet></Period></MPD>`;
  const out = rewriteDashManifest(xml, base);

  // Template variables survive so dash.js can substitute them later.
  assert.ok(out.includes("$RepresentationID$-seg-$Number$"), "media template intact");
  assert.ok(out.includes("mediaPresentationDuration=\"PT193S\""), "unrelated attr untouched");
  assert.ok(out.includes("indexRange=\"0-999\""), "range attr untouched");

  assert.ok(
    out.includes(
      `initialization="/api/seg?u=https%3A%2F%2Fdash.example.com%2Fvod%2F$RepresentationID$-Header.m4s"`
    ),
    "initialization proxied against manifest origin"
  );
  assert.ok(
    out.includes(
      "<BaseURL>/api/seg?u=https%3A%2F%2Falt.example.com%2Fmedia%2F</BaseURL>"
    ),
    "BaseURL proxied"
  );
  assert.ok(
    out.includes(`sourceURL="/api/seg?u=https%3A%2F%2Fdash.example.com%2Fvod%2Finit.mp4"`),
    "sourceURL resolved against manifest origin"
  );
});

test("rewriteDashManifest leaves urn scheme values alone", () => {
  const out = rewriteDashManifest(
    `<x schemeIdUri="urn:mpeg:dash:scheme:2011" media="seg.m4s"/>`,
    "https://d.example.com/m/manifest.mpd"
  );
  assert.ok(out.includes(`schemeIdUri="urn:mpeg:dash:scheme:2011"`));
  assert.ok(out.includes(`media="/api/seg?u=`));
});

test("detectDrmManifest flags FairPlay/Widevine/PlayReady, allows clear streams", () => {
  const fairplay = `#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://drm",KEYFORMAT="com.apple.streamingkeydelivery"
#EXTINF:6.0,
seg.m4s`;
  assert.match(String(detectDrmManifest(fairplay)), /DRM-protected/);

  const widevine = `#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="data:text/plain;base64,",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"
#EXTINF:4.0,seg`;
  assert.match(String(detectDrmManifest(widevine)), /DRM-protected/);

  const clearAes = `#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example.com/key.bin"
#EXTINF:6.0,
seg.ts`;
  assert.equal(detectDrmManifest(clearAes), null);

  const noKey = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1000
url_0/720.m3u8`;
  assert.equal(detectDrmManifest(noKey), null);

  const keyNone = `#EXTM3U
#EXT-X-KEY:METHOD=NONE
#EXTINF:6.0,seg.ts`;
  assert.equal(detectDrmManifest(keyNone), null);

  const dashWidevine = `<MPD><Period><AdaptationSet>
<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>
</AdaptationSet></Period></MPD>`;
  assert.match(String(detectDrmManifest(dashWidevine)), /DRM-protected/);

  const dashKid = `<MPD><AdaptationSet>
<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" cenc:default_KID="abcd"/>
</AdaptationSet></MPD>`;
  assert.match(String(detectDrmManifest(dashKid)), /DRM-protected/);

  const clearDash = `<MPD mediaPresentationDuration="PT193S"><Period>
<AdaptationSet mimeType="video/mp4"><Representation bandwidth="500000">
<BaseURL>media/</BaseURL></Representation></AdaptationSet></Period></MPD>`;
  assert.equal(detectDrmManifest(clearDash), null);
});
