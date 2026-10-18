import { useState } from "react";
import type { PlaybackState } from "../net/types";

function fmt(sec: number): string {
  if (!Number.isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function TheaterControls({
  playback,
  isHost,
  onPlay,
  onPause,
  onSeek,
  title,
}: {
  playback: PlaybackState;
  isHost: boolean;
  onPlay: () => void;
  onPause: () => void;
  onSeek: (pos: number) => void;
  title: string;
}) {
  const [scrubbing, setScrubbing] = useState<number | null>(null);

  const elapsed =
    playback.status === "playing"
      ? playback.position + (Date.now() - playback.updatedAt) / 1000
      : playback.position;
  const display = scrubbing ?? elapsed;

  return (
    <div className="mc-theater">
      <div className="mc-theater-title">
        <span>{title}</span>
        <span className="mc-theater-hint">
          {isHost ? "You are the host" : "Host-controlled"}
        </span>
      </div>
      <div className="mc-theater-progress">
        <span>{fmt(display)}</span>
        <input
          type="range"
          min={0}
          max={Math.max(playback.position + 60, 60)}
          step={1}
          value={display}
          disabled={!isHost}
          onChange={(e) => setScrubbing(Number(e.target.value))}
          onMouseUp={() => {
            if (scrubbing !== null) {
              onSeek(scrubbing);
              setScrubbing(null);
            }
          }}
          onTouchEnd={() => {
            if (scrubbing !== null) {
              onSeek(scrubbing);
              setScrubbing(null);
            }
          }}
        />
      </div>
      <div className="mc-theater-buttons">
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
      </div>
      {!isHost && (
        <div className="mc-theater-note">Only the host can play, pause, or seek.</div>
      )}
    </div>
  );
}
