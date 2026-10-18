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
import { ChatPanel } from "./ChatPanel";
import { MovieBrowser } from "./MovieBrowser";
import { MovieSettings } from "./MovieSettings";
import Hls from "hls.js";
import { TheaterControls } from "./TheaterControls";

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
  const [playback, setPlayback] = useState<PlaybackState>(initialRoom.playback);
  const [catalog, setCatalog] = useState<SampleVideo[]>([]);
  const [showTabList, setShowTabList] = useState(false);
  const [firstPerson, setFirstPerson] = useState(true);

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
    return () => {
      game.dispose();
      gameRef.current = null;
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

  // Attach video element to 3D screen. When no movie is selected, the screen
  // always plays a test YouTube live stream (muted ambient, local-only).
  // Live streams are HLS → played via hls.js (Chrome has no native HLS).
  useEffect(() => {
    const v = videoRef.current;
    const g = gameRef.current;
    if (!v || !g) return;
    hlsRef.current?.destroy();
    hlsRef.current = null;
    if (playback.videoUrl) {
      v.src = playback.videoUrl;
      v.loop = false;
      v.muted = false;
    } else {
      const src = `/api/youtube/stream?videoId=${TEST_YT_VIDEO_ID}`;
      v.loop = true;
      v.muted = true;
      if (Hls.isSupported()) {
        v.removeAttribute("src");
        v.load();
        const hls = new Hls({ enableWorker: true });
        hls.loadSource(src);
        hls.attachMedia(v);
        hls.on(Hls.Events.ERROR, (_evt, data) => {
          if (data.fatal) console.warn("[ambient-hls]", data.details);
        });
        hlsRef.current = hls;
      } else {
        v.src = src; // Safari: native HLS
      }
      v.play().catch(() => {});
    }
    g.attachVideo(v);
    return () => {
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
  }, [playback.videoUrl]);

  // Playback sync
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !playback.videoUrl) return;
    const elapsed = playback.status === "playing" ? (Date.now() - playback.updatedAt) / 1000 : 0;
    const expected = playback.position + elapsed;
    if (Math.abs(v.currentTime - expected) > 1.5) {
      v.currentTime = expected;
    }
    if (playback.status === "playing" && v.paused) {
      v.play().catch(() => {});
    } else if (playback.status === "paused" && !v.paused) {
      v.pause();
    }
  }, [playback]);

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

  // Escape closes the topmost panel (movie settings / movie browser).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Escape") return;
      if (showBrowser) setShowBrowser(false);
      else if (showSettings) setShowSettings(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showBrowser, showSettings]);

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
            text: "Commands: /help /sit /wave — look at a chair + E to sit, E elsewhere = movie settings, RMB punch, Shift crouch, double-tap W run, T chat, F5 view, hold Tab for players.",
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
    <div className="app-root">
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />

      <video
        ref={videoRef}
        crossOrigin="anonymous"
        playsInline
        style={{ display: "none" }}
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

        {/* Bottom-center hints */}
        <div className="mc-hints">
          <span>
            <kbd>WASD</kbd> move
          </span>
          <span>
            <kbd>W×2</kbd> run
          </span>
          <span>
            <kbd>Shift</kbd> crouch
          </span>
          <span>
            <kbd>Space</kbd> jump
          </span>
          <span>
            <kbd>RMB</kbd> punch
          </span>
          <span>
            <kbd>E</kbd> sit / settings
          </span>
          <span>
            <kbd>T</kbd> chat
          </span>
          <span>
            <kbd>F5</kbd> view
          </span>
        </div>

        {/* Theater controls */}
        {playback.videoUrl && (
          <TheaterControls
            playback={playback}
            isHost={isHost}
            onPlay={playMovie}
            onPause={pauseMovie}
            onSeek={seekMovie}
            title={playback.title ?? ""}
          />
        )}
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
