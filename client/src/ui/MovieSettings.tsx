import { useEffect, useState } from "react";
import type { PlaybackState, SampleVideo } from "../net/types";

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Movie settings panel — opened with E / left-click in front of the screen.
 * Duration bar, play/pause, seek, captions, volume, switch movie.
 */
export function MovieSettings({
  playback,
  isHost,
  video,
  catalog,
  onPlay,
  onPause,
  onSeek,
  onSwitchMovie,
  onClose,
  onToast,
}: {
  playback: PlaybackState;
  isHost: boolean;
  video: HTMLVideoElement | null;
  catalog: SampleVideo[];
  onPlay: () => void;
  onPause: () => void;
  onSeek: (pos: number) => void;
  onSwitchMovie: () => void;
  onClose: () => void;
  onToast: (msg: string) => void;
}) {
  const [scrubbing, setScrubbing] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const [captionsOn, setCaptionsOn] = useState(false);
  const [volume, setVolume] = useState(() => video?.volume ?? 1);

  // Live-updating clock while the panel is open.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 500);
    return () => clearInterval(id);
  }, []);
  void tick;

  const elapsed =
    playback.status === "playing"
      ? playback.position + (Date.now() - playback.updatedAt) / 1000
      : playback.position;
  const videoDuration = video && Number.isFinite(video.duration) ? video.duration : 0;
  const catalogEntry = playback.videoId ? catalog.find((v) => v.id === playback.videoId) : undefined;
  const duration = Math.max(videoDuration, catalogEntry?.duration ?? 0, elapsed + 1, 60);
  const display = scrubbing ?? elapsed;

  const toggleCaptions = () => {
    if (!video) {
      onToast("No movie is playing.");
      return;
    }
    if (!video.textTracks || video.textTracks.length === 0) {
      onToast("No captions available for this title.");
      return;
    }
    const track = video.textTracks[0];
    const next = track.mode !== "showing";
    track.mode = next ? "showing" : "hidden";
    setCaptionsOn(next);
    onToast(next ? "Captions on" : "Captions off");
  };

  const commitSeek = (value: number) => {
    onSeek(value);
    setScrubbing(null);
  };

  return (
    <div className="mc-modal-overlay" onClick={onClose}>
      <div className="mc-modal mc-settings" onClick={(e) => e.stopPropagation()}>
        <div className="mc-modal-title">Movie Settings</div>

        {playback.videoUrl ? (
          <>
            <div className="mc-settings-nowplaying">
              <span className="mc-settings-title">{playback.title ?? "Untitled"}</span>
              <span className="mc-settings-status">
                {playback.status === "playing" ? "▶ Playing" : playback.status === "paused" ? "⏸ Paused" : "■ Idle"}
              </span>
            </div>

            {/* Duration bar */}
            <div className="mc-settings-progress">
              <span className="mc-settings-time">{fmt(display)}</span>
              <input
                type="range"
                min={0}
                max={duration}
                step={1}
                value={Math.min(display, duration)}
                disabled={!isHost}
                onChange={(e) => setScrubbing(Number(e.target.value))}
                onMouseUp={() => scrubbing !== null && commitSeek(scrubbing)}
                onTouchEnd={() => scrubbing !== null && commitSeek(scrubbing)}
              />
              <span className="mc-settings-time">{fmt(duration)}</span>
            </div>

            {/* Playback transport */}
            <div className="mc-settings-row">
              {playback.status === "playing" ? (
                <button className="mc-btn mc-btn-small" disabled={!isHost} onClick={onPause}>
                  Pause
                </button>
              ) : (
                <button className="mc-btn mc-btn-small mc-btn-primary" disabled={!isHost} onClick={onPlay}>
                  Play
                </button>
              )}
              <button className="mc-btn mc-btn-small" disabled={!isHost} onClick={() => onSeek(Math.max(0, display - 10))}>
                -10s
              </button>
              <button className="mc-btn mc-btn-small" disabled={!isHost} onClick={() => onSeek(display + 10)}>
                +10s
              </button>
              <button className="mc-btn mc-btn-small" onClick={toggleCaptions}>
                CC {captionsOn ? "On" : "Off"}
              </button>
            </div>

            {/* Volume */}
            <div className="mc-settings-row mc-settings-volume">
              <span>Volume</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={volume}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setVolume(v);
                  if (video) video.volume = v;
                }}
              />
            </div>

            {!isHost && <div className="mc-modal-note">Only the host can control playback.</div>}
          </>
        ) : (
          <div className="mc-modal-empty">No movie selected yet.</div>
        )}

        <div className="mc-modal-actions">
          <button className="mc-btn mc-btn-small" disabled={!isHost} onClick={onSwitchMovie}>
            Switch movie…
          </button>
          <button className="mc-btn mc-btn-small mc-btn-primary" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="mc-modal-note">Esc or click outside to close.</div>
      </div>
    </div>
  );
}
