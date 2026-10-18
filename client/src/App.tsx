import { useEffect, useState, useCallback } from "react";
import { Landing } from "./ui/Landing";
import { RoomView } from "./ui/RoomView";
import { getSocket, attachRoomEvents } from "./net/socket";
import type { RoomState } from "./net/types";

export default function App() {
  const [room, setRoom] = useState<RoomState | null>(null);
  const [myId, setMyId] = useState<string>("");

  useEffect(() => {
    const s = getSocket();
    s.on("connect", () => setMyId(s.id ?? ""));
    if (s.connected) setMyId(s.id ?? "");
  }, []);

  useEffect(() => {
    const detach = attachRoomEvents({
      onJoined: (state) => setRoom(state),
      onRoomState: ({ state }) => setRoom(state),
      onPlayerJoin: () => {},
      onPlayerLeave: () => {},
      onPlayerMoved: () => {},
      onPlayerSpeaking: () => {},
      onPlayerEmote: () => {},
      onChat: () => {},
      onMovieState: () => {},
      onLights: ({ lightsOn }) => setRoom((r) => (r ? { ...r, lightsOn } : r)),
      onRooms: () => {},
      onCatalog: () => {},
      onError: () => {},
    });
    return detach;
  }, []);

  const leave = useCallback(() => setRoom(null), []);

  if (!room) return <Landing />;
  return <RoomView initialRoom={room} myId={myId} onLeave={leave} />;
}
