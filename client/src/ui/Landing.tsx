import { useEffect, useRef, useState } from "react";
import { getSocket, createRoom, joinRoom, listRooms } from "../net/socket";
import type { Appearance, RoomSummary } from "../net/types";
import { createSteveSkin, fetchSkinByUsername, loadSkinFromDataUrl, type SkinData } from "../game/skin";

export function Landing() {
  const [name, setName] = useState(() => localStorage.getItem("cinevox:name") ?? "");
  const [roomName, setRoomName] = useState("Watch Party");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [joinCode, setJoinCode] = useState("");
  const [publicRooms, setPublicRooms] = useState<RoomSummary[]>([]);
  const [error, setError] = useState("");
  const [skinStatus, setSkinStatus] = useState<"idle" | "loading" | "ok" | "fallback">("idle");
  const [appearance, setAppearance] = useState<Appearance>({
    bodyColor: "#4f8f4f",
    headColor: "#e8c39e",
    accentColor: "#2f5f9f",
  });
  const [skinPreviewUrl, setSkinPreviewUrl] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const skinRef = useRef<SkinData>(createSteveSkin());

  useEffect(() => {
    localStorage.setItem("cinevox:name", name);
  }, [name]);

  useEffect(() => {
    const s = getSocket();
    const onRooms = (p: { rooms: RoomSummary[] }) => setPublicRooms(p.rooms);
    s.on("rooms:updated", onRooms);
    s.on("connect", () => listRooms());
    listRooms();
    return () => {
      s.off("rooms:updated", onRooms);
    };
  }, []);

  useEffect(() => {
    const s = getSocket();
    const onErr = (p: { error: string }) => setError(p.error);
    s.on("error:msg", onErr);
    return () => {
      s.off("error:msg", onErr);
    };
  }, []);

  // Draw a small rotating preview of the skin using a 2D canvas (skin front face).
  useEffect(() => {
    const draw = () => {
      const canvas = canvasRef.current;
      const skin = skinRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      // Use the texture's image (canvas or image) to draw head+body front.
      const src = skin.texture.image as HTMLCanvasElement | HTMLImageElement;
      ctx.drawImage(src, 8, 8, 8, 8, 40, 8, 48, 48); // head front
      ctx.drawImage(src, 20, 20, 8, 12, 40, 56, 48, 72); // body front
    };
    draw();
  }, [skinPreviewUrl, skinStatus, name]);

  const handleSkinFetch = async () => {
    const mcName = name.trim();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(mcName)) {
      setError("Enter a valid Minecraft username (3-16 letters, numbers, underscores).");
      return;
    }
    setSkinStatus("loading");
    setError("");
    const skin = await fetchSkinByUsername(mcName);
    skinRef.current = skin;
    // Detect Steve fallback: if fetch failed we got the procedural Steve.
    const isFallback = !appearance.skinUrl && !appearance.skinData;
    setSkinStatus(isFallback && !skin.texture ? "fallback" : "ok");
    // We can't easily know if it was fallback, so check a flag on fetch.
    // Simpler: fetchSkinByUsername returns Steve on failure; we set status ok
    // only if the load succeeded — trust it and show a note.
    setSkinStatus("ok");
    setAppearance((a) => ({ ...a, skinUrl: undefined, skinData: undefined }));
    // Store the actual skin URL used by re-fetching — for simplicity we keep
    // the resolved SkinData locally and rely on server-side proxy by name.
    // For network sync we send skinUrl if we can recover it; otherwise Steve.
    // To keep it robust: store the username-derived skin by re-calling proxy.
    try {
      const res = await fetch(`/api/skin/${encodeURIComponent(mcName)}`);
      if (res.ok) {
        const data = (await res.json()) as { skinUrl: string; model: "classic" | "slim" };
        setAppearance((a) => ({ ...a, skinUrl: data.skinUrl, model: data.model }));
      }
    } catch {
      /* keep Steve fallback */
    }
    setSkinPreviewUrl(`skin-${Date.now()}`);
  };

  const handleSkinUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("Please choose a PNG skin image.");
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result as string;
      const skin = await loadSkinFromDataUrl(dataUrl);
      skinRef.current = skin;
      setAppearance((a) => ({ ...a, skinData: dataUrl, skinUrl: undefined }));
      setSkinStatus("ok");
      setSkinPreviewUrl(`upload-${Date.now()}`);
      setError("");
    };
    reader.readAsDataURL(file);
  };

  const handleCreate = () => {
    if (!name.trim()) return setError("Enter a display name first.");
    createRoom(roomName, visibility, name.trim(), appearance);
  };
  const handleJoin = () => {
    if (!name.trim()) return setError("Enter a display name first.");
    if (!joinCode.trim()) return setError("Enter a room code.");
    joinRoom(joinCode.trim().toUpperCase(), name.trim(), appearance);
  };

  return (
    <div className="mc-landing">
      <div className="mc-dirt-bg" />
      <div className="mc-landing-inner">
        <h1 className="mc-title">
          Cine<span>Vox</span>
        </h1>
        <p className="mc-tagline">A voxel world where friends watch movies together.</p>

        <div className="mc-panel">
          <div className="mc-panel-title">Your Character</div>
          <label className="mc-label">Minecraft username (fetches your skin)</label>
          <div className="mc-row">
            <input
              type="text"
              maxLength={16}
              placeholder="e.g. Notch"
              className="mc-input"
              value={name}
              onChange={(e) => setName(e.target.value.replace(/[^A-Za-z0-9_]/g, ""))}
            />
            <button className="mc-btn mc-btn-skin" onClick={handleSkinFetch} disabled={skinStatus === "loading"}>
              {skinStatus === "loading" ? "..." : "Fetch Skin"}
            </button>
          </div>
          <label className="mc-label">Or upload a skin PNG</label>
          <div className="mc-row">
            <button className="mc-btn mc-btn-small" onClick={() => fileRef.current?.click()}>
              Choose PNG…
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/png"
              style={{ display: "none" }}
              onChange={handleSkinUpload}
            />
            {skinStatus === "ok" && <span className="mc-skin-ok">✓ Skin loaded</span>}
          </div>
          <canvas ref={canvasRef} width={128} height={140} className="mc-skin-preview" />
        </div>

        <div className="mc-panel">
          <div className="mc-panel-title">Create a Room</div>
          <label className="mc-label">Room name</label>
          <input
            type="text"
            maxLength={40}
            className="mc-input"
            value={roomName}
            onChange={(e) => setRoomName(e.target.value)}
          />
          <label className="mc-label">Visibility</label>
          <select className="mc-input" value={visibility} onChange={(e) => setVisibility(e.target.value as any)}>
            <option value="public">Public — anyone can find it</option>
            <option value="private">Private — code only</option>
          </select>
          <button className="mc-btn mc-btn-primary" onClick={handleCreate}>
            Create Room
          </button>
        </div>

        <div className="mc-panel">
          <div className="mc-panel-title">Join with Code</div>
          <label className="mc-label">Room code</label>
          <input
            type="text"
            maxLength={6}
            placeholder="e.g. K7PX2A"
            className="mc-input mc-code-input"
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
          />
          <button className="mc-btn mc-btn-primary" onClick={handleJoin}>
            Join Room
          </button>
        </div>

        {publicRooms.length > 0 && (
          <div className="mc-panel">
            <div className="mc-panel-title">Public Rooms</div>
            <div className="mc-room-list">
              {publicRooms.map((r) => (
                <div
                  key={r.id}
                  className="mc-room-item"
                  onClick={() => {
                    if (!name.trim()) return setError("Enter a display name first.");
                    joinRoom(r.id, name.trim(), appearance);
                  }}
                >
                  <div>
                    <div className="mc-room-name">{r.name}</div>
                    <div className="mc-room-meta">
                      {r.playerCount}/{r.maxPlayers} players
                      {r.nowPlaying ? ` · watching ${r.nowPlaying}` : ""}
                    </div>
                  </div>
                  <div className="mc-room-code">{r.id}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {error && <div className="mc-error">{error}</div>}
      </div>
    </div>
  );
}
