# CineVox — Minecraft-style Multiplayer Watch Party (MVP)

A voxel 3D world where friends gather as blocky characters, walk around a cinema,
sit in seats, chat, and watch open-license movies together with server-synced playback.

## Stack

| Layer    | Tech |
|----------|------|
| Client   | Vite + React 18 + TypeScript + Three.js + socket.io-client |
| Server   | Node.js + Express + Socket.IO + TypeScript |
| State    | Authoritative in-memory room manager on the server (positions, playback, chat) |
| Video    | Blender Foundation open-license films (Big Buck Bunny, Sintel, …), streamed directly by clients from Google's public sample bucket |
| Tests    | `node:test` unit tests + a live two-client socket smoke test |

No database or external API keys are required for the MVP — rooms live in server memory
and the movie catalog is a built-in list of openly licensed sample videos.

## Quick start

```bash
# from the repo root
npm install          # installs root + server + client workspaces

# terminal 1 — game server (http://localhost:4000)
npm run dev -w server

# terminal 2 — web client (http://localhost:5173)
npm run dev -w client
```

Or run both together from the root:

```bash
npm install
npm run dev
```

> Requires `yt-dlp` on PATH (used by the server to resolve the ambient screen's test video).

Then open **http://localhost:5173** in two browser windows (or two different machines
on your network) to see real multiplayer sync.

## How to use

1. Enter your **Minecraft username** and hit **Fetch Skin** — your real skin is pulled from
   Mojang's public API and applied to your character (Steve fallback if the name isn't found).
   Or upload a custom 64×64 skin PNG.
2. **Create a room** (public or private) — you get a 6-character room code and an invite link.
3. Friends join via the code, the public-room list, or the copied link.
4. Controls:
   - **WASD** move · **double-tap W** run · **Shift** crouch (sneak) · **Space** jump · **mouse** look
   - **E** — look at a chair to **sit**, anywhere else it opens **movie settings** (duration bar, play/pause, seek, captions, volume, switch movie)
   - **Right click** punch (syncs to other players) · **F5** toggle first/third person
   - **T** (or **/**) open chat · **hold Tab** player list · **Escape** release mouse / close panels
   - **/sit** sit on the nearest seat (or stand back up) — stadium rows: back rows are raised
5. Walk into the cinema (north end of the map); aim at a seat and press **E** to sit (stadium
   rows: back rows are raised), or press **E** anywhere else to open **movie settings**.
6. When no movie is selected, the cinema screen always loops a **test YouTube live stream**
   (muted, local ambient) — resolved with `yt-dlp` and served same-origin as HLS through the
   server (`/api/youtube/stream` + `/api/youtube/seg`), played via `hls.js`.
7. The **host** (room creator) selects a movie and controls play/pause/seek; everyone stays in sync.
8. Late joiners automatically receive the current playback position and catch up.

### Chat

Chat is Minecraft-style: press **T** to open, messages overlay at the bottom-left and fade
after a few seconds when closed, and a toggle button hides/shows chat entirely.

| Command | Effect |
|---------|--------|
| `/help` | Show available commands |
| `/sit`  | Sit / stand |
| `/wave` | Wave emote |

### Perspective

First-person is the default (with a crosshair and a swinging hand). Press **F5** to swap to
the third-person orbit camera.

## Multiplayer architecture

- The server is **authoritative**: it owns room membership, the host role, player positions
  (clamped to world bounds), chat, and the canonical playback state.
- Clients send movement at 10 Hz (server rate-limits to 30/s) and other clients **interpolate**
  remote players smoothly between updates.
- Playback state carries a server timestamp; clients estimate the expected position and
  **drift-correct** only when they're more than 1.5 s off (no per-frame seeking).
- Host disconnect → playback pauses and the host role transfers to the earliest-joined player.
- Empty rooms are garbage-collected automatically.

## Events (Socket.IO)

Client → Server: `room:create` `room:join` `room:leave` `player:move` `player:speaking`
`player:emote` `chat:send` `movie:select` `movie:play` `movie:pause` `movie:seek` `rooms:list`

Server → Client: `room:joined` `room:state` `player:join` `player:leave` `player:moved`
`player:speaking` `player:emote` `chat:message` `movie:state` `rooms:updated`
`videos:catalog` `error:msg`

## Testing

```bash
# unit tests (room manager: join/leave, host transfer, playback auth, chat limits, …)
npm test -w server

# live multiplayer smoke test (starts real socket clients against a running server)
npm run dev -w server &          # start server first
npm exec -w server tsx test/live-smoke.ts
```

All **16 unit tests** and the **6 live socket assertions** pass (verified in this environment).

## Environment variables

Copy `.env.example`. Defaults work out of the box for local dev.

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `4000` | Game server port |
| `CLIENT_ORIGIN` | `http://localhost:5173` | Allowed CORS origin |
| `VITE_SOCKET_URL` | (dev proxy) | Production socket URL for the client |

## Not yet included (honest MVP limits)

- **Voice chat** — mic-level speaking indicators are wired (WebAudio analyser tints the
  name tag green while you speak), but actual WebRTC voice transport (LiveKit/P2P) is a
  planned next step and is **not** implemented here.
- **Accounts / database** — rooms are ephemeral and in-memory; guest-only, no login.
- **TMDB discovery** — the catalog uses built-in open-license sample films instead, so no
  API key is needed. A TMDB integration would keep keys server-side and clearly separate
  metadata from playable sources.
- **Mobile touch controls** — basic touch-look is in the engine; a virtual joystick UI is pending.

## Minecraft skin integration

- `GET /api/skin/:username` on the game server proxies Mojang's public APIs
  (`api.mojang.com` → `sessionserver.mojang.com`) and returns the skin texture URL + arm
  model (classic/slim). Responses are cached in-memory for 10 minutes.
- Usernames are validated (`[A-Za-z0-9_]{3,16}`) and requests are timeout-guarded.
- Clients UV-map the 64×64 skin onto head/body/arms/legs box geometries with `NearestFilter`.
  Legacy 64×32 skins are upsampled; a procedural Steve is the fallback.
- Custom uploaded skins are sent as a size-capped base64 PNG data-URL (only
  `textures.minecraft.net` URLs and small PNG data-URLs are accepted server-side).
- No Minecraft assets, textures, or branding are bundled — skins are fetched at runtime
  from the user's own Mojang account data.

## License notes

Sample videos are Blender Foundation open movies (CC-BY), served from Google's public
`gtv-videos-bucket`. Character/voxel art is generated procedurally — no Minecraft assets
or branding are used.
