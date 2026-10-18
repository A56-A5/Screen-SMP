import type { SampleVideo } from "../net/types";

export function MovieBrowser({
  catalog,
  isHost,
  onSelect,
  onClose,
}: {
  catalog: SampleVideo[];
  isHost: boolean;
  onSelect: (videoId: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="mc-modal-overlay" onClick={onClose}>
      <div className="mc-modal" onClick={(e) => e.stopPropagation()}>
        <div className="mc-modal-title">Select a Movie</div>
        {!isHost && (
          <div className="mc-modal-note">Only the host can change the movie.</div>
        )}
        <div className="mc-modal-note">
          All titles are open-license Blender Foundation films — free to watch and share.
        </div>
        {catalog.length === 0 ? (
          <div className="mc-modal-empty">Loading catalog…</div>
        ) : (
          <div className="mc-video-grid">
            {catalog.map((v) => (
              <div
                key={v.id}
                className={`mc-video-card ${isHost ? "" : "disabled"}`}
                onClick={() => isHost && onSelect(v.id)}
                title={isHost ? `Select ${v.title}` : "Only the host can select"}
              >
                <div className="mc-video-thumb">▶</div>
                <div className="mc-video-info">
                  <div className="mc-video-title">{v.title}</div>
                  <div className="mc-video-sub">
                    {Math.round(v.duration / 60)} min · {v.attribution.split("—")[0].trim()}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="mc-modal-actions">
          <button className="mc-btn mc-btn-small" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
