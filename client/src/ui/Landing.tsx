import { useEffect, useState } from "react";
import { getSocket, createRoom, joinRoom, listRooms } from "../net/socket";
import type { Appearance, RoomSummary } from "../net/types";

const DEFAULT_APPEARANCE: Appearance = {
  bodyColor: "#4f8f4f",
  headColor: "#e8c39e",
  accentColor: "#2f5f9f",
};

export function Landing() {
  const [name, setName] = useState(() => localStorage.getItem("cinevox:name") ?? "");
  const [roomName, setRoomName] = useState("Watch Party");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [joinCode, setJoinCode] = useState("");
  const [publicRooms, setPublicRooms] = useState<RoomSummary[]>([]);
  const [error, setError] = useState("");

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

  const handleCreate = () => {
    if (!name.trim()) return setError("Enter your name first.");
    createRoom(roomName, visibility, name.trim(), DEFAULT_APPEARANCE);
  };
  const handleJoin = () => {
    if (!name.trim()) return setError("Enter your name first.");
    if (!joinCode.trim()) return setError("Enter a room code.");
    joinRoom(joinCode.trim().toUpperCase(), name.trim(), DEFAULT_APPEARANCE);
  };

  return (
    <div className="mc-landing">
      <div className="mc-dirt-bg" />
      <div className="mc-landing-inner">
        <h1 className="mc-title">
          Screen <span>SMP</span>
        </h1>
        <p className="mc-tagline">A voxel world where friends watch movies together.</p>

        <div className="mc-panel">
          <div className="mc-panel-title">Your Name</div>
          <label className="mc-label">What should everyone call you?</label>
          <input
            type="text"
            maxLength={16}
            placeholder="e.g. Steve"
            className="mc-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
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
          <div className="mc-panel-title">Join a Room</div>
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
                    if (!name.trim()) return setError("Enter your name first.");
                    joinRoom(r.id, name.trim(), DEFAULT_APPEARANCE);
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
