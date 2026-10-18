import { useEffect, useRef, useState, useCallback } from "react";
import { Game } from "../game/engine";
import {
  attachRoomEvents,
  leaveRoom,
  sendChat,
  sendMove,
  sendSpeaking,
  sendEmote,
  selectVideo,
  playMovie,
  pauseMovie,
  seekMovie,
} from "../net/socket";
import type { ChatMessage, PlaybackState, RoomState, SampleVideo, PlayerState } from "../net/types";
import { isYouTubeSource } from "../net/youtube";
import Hls from "hls.js";
import { ChatPanel } from "./ChatPanel";
import { MovieBrowser } from "./MovieBrowser";
import { MovieSettings } from "./MovieSettings";

/** Ambient test video shown on the cinema screen whenever no movie is selected. */
const TEST_YT_VIDEO_ID = "rFZHOHl-L8A";

export function RoomView({
  initialRoom,
  myId,
  onLeave,
}: {
  initialRoom: RoomState;
  myId: string;
  onLeave: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Game | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);

  const [room, setRoom] = useState<RoomState>(initialRoom);
  const [players, setPlayers] = useState<PlayerState[]>(initialRoom.players);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [showBrowser, setShowBrowser] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [chatHidden, setChatHidden] = useState(false);
  const [copied, setCopied] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // F: movie-only view — video fills the window, all chrome hides.
  const [theater, setTheater] = useState(false);
  const [playback, setPlayback] = useState<PlaybackState>(initialRoom.playback);
  const [catalog, setCatalog] = useState<SampleVideo[]>([]);
  const [showTabList, setShowTabList] = useState(false);
  const [firstPerson, setFirstPerson] = useState(true);
  // YT pick = "watch now": auto-press play once the selection round-trips.
  const [pendingAutoPlay, setPendingAutoPlay] = useState<string | null>(null);

  const isHost = myId === room.hostId;

  // Init game engine once
  useEffect(() => {
    if (!containerRef.current || gameRef.current) return;
    const game = new Game(
      containerRef.current,
      "You",
      initialRoom.players.find((p) => p.id === myId)?.appearance ?? {
        bodyColor: "#4f8f4f",
        headColor: "#e8c39e",
        accentColor: "#2f5f9f",
      },
      {
        onMove: (pos, rot, anim) => sendMove(pos, rot, anim),
        onInteract: () => setShowSettings(true),
        onFirstPersonChange: (fp) => setFirstPerson(fp),
        onPunch: () => sendEmote("punch"),
      }
    );
    gameRef.current = game;
    // Dev/QA hook (production builds strip this via the DEV guard) — lets
    // automated checks read player position/sitting state.
    if (import.meta.env.DEV) (window as unknown as { __game?: Game }).__game = game;
    return () => {
      game.dispose();
      gameRef.current = null;
      if (import.meta.env.DEV) delete (window as unknown as { __game?: Game }).__game;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Attach socket events
  useEffect(() => {
    const detach = attachRoomEvents({
      onJoined: () => {},
      onRoomState: ({ state }) => {
        setRoom(state);
        setPlayers(state.players);
        setPlayback(state.playback);
        gameRef.current?.syncRemoteList(state.players, myId);
      },
      onPlayerJoin: (p) => {
        if (!p) return;
        setPlayers((prev) => [...prev.filter((x) => x.id !== p.id), p]);
        gameRef.current?.addRemote(p);
      },
      onPlayerLeave: (playerId) => {
        setPlayers((prev) => prev.filter((p) => p.id !== playerId));
        gameRef.current?.removeRemote(playerId);
      },
      onPlayerMoved: (s) => {
        setPlayers((prev) =>
          prev.map((p) =>
            p.id === s.id
              ? { ...p, position: s.position, rotationY: s.rotationY, animation: s.animation as any }
              : p
          )
        );
        gameRef.current?.moveRemote(s.id, s.position, s.rotationY, s.animation);
      },
      onPlayerSpeaking: ({ playerId, speaking }) => {
        setPlayers((prev) => prev.map((p) => (p.id === playerId ? { ...p, speaking } : p)));
        gameRef.current?.setRemoteSpeaking(playerId, speaking);
      },
      onPlayerEmote: ({ playerId, emote }) => {
        if (emote === "wave") gameRef.current?.waveRemote(playerId);
        if (emote === "punch") gameRef.current?.punchRemote(playerId);
        const name = players.find((p) => p.id === playerId)?.name ?? "Someone";
        const verb = emote === "punch" ? "throws a punch!" : "waves!";
        setChat((c) => [
          ...c.slice(-99),
          {
            id: `emote-${Date.now()}`,
            roomId: room.roomId,
            senderId: "system",
            senderName: "System",
            text: `${name} ${verb}`,
            timestamp: Date.now(),
            kind: "emote" as const,
          },
        ]);
      },
      onChat: (msg) => setChat((c) => [...c.slice(-99), msg]),
      onMovieState: ({ playback: pb }) => setPlayback(pb),
      onRooms: () => {},
      onCatalog: (videos) => setCatalog(videos),
      onError: ({ error }) => {
        setToast(error);
        setTimeout(() => setToast(null), 3000);
      },
    });
    return detach;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myId, players]);

  useEffect(() => {
    gameRef.current?.syncRemoteList(players, myId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myId]);

  // Attach video element to 3D screen.
  // - No movie selected: ambient test live stream (muted, looping, local).
  // - YouTube selection: live → HLS via hls.js, VOD → proxied mp4 via <video>.
  // - Catalog movie: plain proxied URL (unchanged).
  useEffect(() => {
    const v = videoRef.current;
    const g = gameRef.current;
    if (!v || !g) return;

    // Fully stop whatever played before — hls.destroy() alone lets the
    // element keep playing buffered audio (the "lofi keeps going" bug).
    const stopMedia = () => {
      hlsRef.current?.destroy();
      hlsRef.current = null;
      const el = videoRef.current;
      if (!el) return;
      el.pause();
      el.removeAttribute("src");
      el.load();
    };

    stopMedia();
    let cancelled = false;

    const attachHls = (src: string, reload = 0) => {
      v.removeAttribute("src");
      v.load();
      const hls = new Hls({ enableWorker: true });
      hls.loadSource(src);
      hls.attachMedia(v);
      let mediaRetries = 0;
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (!data.fatal) return;
        // Expired signed URLs / transient network: re-attach (server drops
        // its stale cache on 403, so a reload gets fresh signatures).
        if (reload < 3 && data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          console.warn("[hls] network error, reloading:", data.details);
          setTimeout(() => {
            if (cancelled) return;
            stopMedia();
            attachHls(src, reload + 1);
          }, 2000);
          return;
        }
        // Decoder hiccups on odd streams: hls.js can recover in place.
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRetries < 2) {
          mediaRetries++;
          console.warn("[hls] media error, recovering:", data.details);
          setTimeout(() => {
            if (!cancelled) hls.recoverMediaError();
          }, 1000);
          return;
        }
        console.warn("[hls] fatal:", data.details);
      });
      hlsRef.current = hls;
    };

    const setup = async () => {
      const url = playback.videoUrl;
      if (!url) {
        const src = `/api/youtube/stream?videoId=${TEST_YT_VIDEO_ID}`;
        v.loop = true;
        v.muted = true;
        if (Hls.isSupported()) attachHls(src);
        else v.src = src; // Safari: native HLS
        v.play().catch(() => {});
        return;
      }
      v.loop = false;
      v.muted = false;
      if (isYouTubeSource(url)) {
        try {
          const head = await fetch(url, { method: "HEAD" });
          if (cancelled) return;
          const ct = head.headers.get("content-type") ?? "";
          if (ct.includes("mpegurl") && Hls.isSupported()) {
            attachHls(url);
          } else {
            v.src = url; // VOD: direct media through the proxy
          }
        } catch {
          if (!cancelled) v.src = url;
        }
      } else {
        v.src = url;
      }
      // Play/pause is governed by the sync effect below.
    };

    setup();
    g.attachVideo(v);

    // Some links resolve but the media request still fails (expired
    // signature, slow yt-dlp, odd stream). Re-run setup a few times — every
    // request re-checks the server-side cache and can re-resolve.
    let retries = 0;
    const onMediaError = () => {
      const el = videoRef.current;
      if (cancelled || !el || !el.error || !el.currentSrc) return;
      if (retries >= 3) {
        if (playback.videoUrl) {
          setToast("Video failed to load — try selecting it again.");
          setTimeout(() => setToast(null), 4000);
        }
        return;
      }
      retries++;
      setTimeout(() => {
        if (cancelled) return;
        stopMedia();
        setup();
      }, 2500);
    };
    v.addEventListener("error", onMediaError);

    return () => {
      cancelled = true;
      v.removeEventListener("error", onMediaError);
      stopMedia();
    };
  }, [playback.videoUrl]);

  // Playback sync. Live streams (duration === Infinity) only follow
  // play/pause — their position can't be meaningfully time-corrected.
  const playbackRef = useRef(playback);
  playbackRef.current = playback;

  const applyPlaybackSync = useCallback(() => {
    const v = videoRef.current;
    const pb = playbackRef.current;
    if (!v || !pb.videoUrl) return;
    const live = v.duration === Infinity;
    if (!live && v.readyState >= 1) {
      const elapsed = pb.status === "playing" ? (Date.now() - pb.updatedAt) / 1000 : 0;
      const expected = pb.position + elapsed;
      if (Math.abs(v.currentTime - expected) > 1.5) {
        v.currentTime = expected;
      }
    }
    if (pb.status === "playing" && v.paused) {
      v.play().catch(() => {});
    } else if (pb.status === "paused" && !v.paused) {
      v.pause();
    }
  }, []);

  // On every movie:state event...
  useEffect(() => {
    applyPlaybackSync();
  }, [playback, applyPlaybackSync]);

  // ...and on a timer: a late joiner finishes loading their video AFTER the
  // last state event, so without this interval nobody would ever snap them
  // to the room's current timestamp.
  useEffect(() => {
    if (!playback.videoUrl) return;
    const id = setInterval(applyPlaybackSync, 750);
    return () => clearInterval(id);
  }, [playback.videoUrl, applyPlaybackSync]);

  // F: full-screen video — the movie fills the whole window (plus real
  // browser fullscreen when allowed) and every piece of HUD/chat/crosshair
  // chrome hides. F or Escape brings the world back. Ignored while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "KeyF") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const next = !theater;
      setTheater(next);
      if (next) document.documentElement.requestFullscreen().catch(() => {});
      else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [theater]);

  // The browser swallows the FIRST Escape while in native fullscreen —
  // listen for the resulting fullscreenchange so one Escape always leaves
  // theater mode too.
  useEffect(() => {
    const onFs = () => {
      if (!document.fullscreenElement) setTheater(false);
    };
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // Auto-play after a YouTube pick: once the server confirms the selection
  // (status "paused" + matching id), press play for everyone.
  useEffect(() => {
    if (!pendingAutoPlay) return;
    if (playback.videoId === pendingAutoPlay && playback.videoUrl && playback.status === "paused") {
      setPendingAutoPlay(null);
      playMovie();
    }
  }, [pendingAutoPlay, playback]);

  const handlePlayYouTube = useCallback((ytId: string) => {
    selectVideo(`yt:${ytId}`);
    setPendingAutoPlay(`yt:${ytId}`);
  }, []);

  // Speaking indicator via mic level
  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let audioCtx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let lastSent = false;

    const start = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioCtx = new AudioContext();
        const src = audioCtx.createMediaStreamSource(stream);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        src.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          if (!analyser) return;
          analyser.getByteFrequencyData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) sum += data[i];
          const avg = sum / data.length;
          const speaking = avg > 12;
          if (speaking !== lastSent) {
            lastSent = speaking;
            sendSpeaking(speaking);
            gameRef.current?.setSpeaking(speaking);
          }
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch {
        // Mic denied — indicators just won't fire.
      }
    };
    start();
    return () => {
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      audioCtx?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tab player list (hold Tab to show, like Minecraft multiplayer)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Tab") {
        e.preventDefault();
        setShowTabList(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Tab") {
        setShowTabList(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  // Escape: theater mode first (movie-only view), then the topmost panel
  // (movie settings / movie browser).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Escape") return;
      if (theater) {
        setTheater(false);
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        return;
      }
      if (showBrowser) setShowBrowser(false);
      else if (showSettings) setShowSettings(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showBrowser, showSettings, theater]);

  const handleSend = useCallback(
    (text: string) => {
      // Handle /commands
      if (text === "/wave") gameRef.current?.wave();
      else if (text === "/sit") gameRef.current?.toggleSit();
      else if (text === "/help") {
        setChat((c) => [
          ...c,
          {
            id: `help-${Date.now()}`,
            roomId: room.roomId,
            senderId: "system",
            senderName: "System",
            text: "Commands: /help /sit /wave — look at a chair + E to sit, E elsewhere = movie settings, RMB punch, Shift crouch, double-tap W run, T chat, F5 view, F full-screen video, hold Tab for players.",
            timestamp: Date.now(),
            kind: "system" as const,
          },
        ]);
        return;
      }
      sendChat(text);
    },
    [room.roomId]
  );

  const copyInvite = () => {
    const url = `${window.location.origin}/?room=${room.roomId}`;
    navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleLeave = () => {
    leaveRoom();
    onLeave();
  };

  return (
    <div className={theater ? "app-root theater" : "app-root"}>
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />

      {/* Hidden normally (feeds the 3D screen texture). Theater mode: the
          video itself becomes the entire screen. */}
      <video
        ref={videoRef}
        crossOrigin="anonymous"
        playsInline
        style={
          theater
            ? {
                position: "fixed",
                inset: 0,
                width: "100%",
                height: "100%",
                objectFit: "contain",
                background: "#000",
                zIndex: 45,
              }
            : { display: "none" }
        }
      />

      {/* Crosshair (first person) */}
      {firstPerson && (
        <div className="mc-crosshair">
          <div className="mc-crosshair-h" />
          <div className="mc-crosshair-v" />
        </div>
      )}

      {/* HUD */}
      <div className="mc-hud">
        {/* Top-left: room info */}
        <div className="mc-hud-topleft">
          <div className="mc-room-badge">
            <div className="mc-room-badge-name">{room.name}</div>
            <div className="mc-room-badge-code">
              <span>{room.roomId}</span>
              <button className="mc-btn-micro" onClick={copyInvite}>
                {copied ? "Copied!" : "Copy invite"}
              </button>
            </div>
          </div>
        </div>

        {/* Top-right: player count, movies, leave */}
        <div className="mc-hud-topright">
          <span className="mc-player-count">
            {players.length}/{room.maxPlayers}
          </span>
          <button className="mc-btn mc-btn-small" onClick={() => setShowBrowser(true)}>
            Movies
          </button>
          <button className="mc-btn mc-btn-small mc-btn-danger" onClick={handleLeave}>
            Leave
          </button>
        </div>

        {/* Chat */}
        <ChatPanel messages={chat} onSend={handleSend} hidden={chatHidden} onToggleHidden={() => setChatHidden((h) => !h)} />

        {/* Playback controls live only inside movie settings (E);
            bottom hint bar removed — /help covers the controls. */}
      </div>

      {/* Tab player list (Minecraft multiplayer style) */}
      {showTabList && (
        <div className="mc-tab-list">
          <div className="mc-tab-list-title">
            {room.name} — {players.length}/{room.maxPlayers}
          </div>
          <div className="mc-tab-list-rows">
            {players.map((p) => (
              <div key={p.id} className="mc-tab-list-row">
                <span
                  className="mc-tab-skin-chip"
                  style={{ background: p.appearance.bodyColor }}
                />
                <span>{p.id === myId ? `${p.name} (you)` : p.name}</span>
                {p.id === room.hostId && <span className="mc-tab-host">HOST</span>}
                {p.speaking && <span className="mc-tab-speaking">♪</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {showBrowser && (
        <MovieBrowser
          catalog={catalog}
          isHost={isHost}
          onSelect={(id) => {
            selectVideo(id);
            setShowBrowser(false);
          }}
          onClose={() => setShowBrowser(false)}
        />
      )}

      {showSettings && (
        <MovieSettings
          playback={playback}
          isHost={isHost}
          video={videoRef.current}
          catalog={catalog}
          onPlay={playMovie}
          onPause={pauseMovie}
          onSeek={seekMovie}
          onSwitchMovie={() => {
            setShowSettings(false);
            setShowBrowser(true);
          }}
          onPlayYouTube={handlePlayYouTube}
          onClose={() => setShowSettings(false)}
          onToast={(m) => {
            setToast(m);
            setTimeout(() => setToast(null), 3000);
          }}
        />
      )}

      {toast && <div className="mc-toast">{toast}</div>}
    </div>
  );
}
