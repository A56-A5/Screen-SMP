import { io, Socket } from "socket.io-client";
import type {
  Appearance,
  ChatMessage,
  PlaybackState,
  RoomState,
  RoomSummary,
  SampleVideo,
} from "./types";

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    const url = import.meta.env.VITE_SOCKET_URL ?? "/";
    socket = io(url, { transports: ["websocket", "polling"] });
  }
  return socket;
}

export interface RoomEvents {
  onJoined: (state: RoomState) => void;
  onPlayerJoin: (player: RoomState["players"][0]) => void;
  onPlayerLeave: (playerId: string) => void;
  onPlayerMoved: (s: { id: string; position: any; rotationY: number; animation: string }) => void;
  onPlayerSpeaking: (s: { playerId: string; speaking: boolean }) => void;
  onPlayerEmote: (s: { playerId: string; emote: string }) => void;
  onChat: (msg: ChatMessage) => void;
  onMovieState: (p: { playback: PlaybackState }) => void;
  onRooms: (rooms: RoomSummary[]) => void;
  onCatalog: (videos: SampleVideo[]) => void;
  onError: (e: { event: string; error: string }) => void;
  onRoomState: (s: { state: RoomState }) => void;
}

export function attachRoomEvents(h: RoomEvents): () => void {
  const s = getSocket();
  const wrap = (fn: (...args: any[]) => void) => (...args: any[]) => fn(...args);

  s.on("room:joined", wrap((p: any) => h.onJoined(p.state)));
  s.on("player:join", wrap((p: any) => h.onPlayerJoin(p.player)));
  s.on("player:leave", wrap((p: any) => h.onPlayerLeave(p.playerId)));
  s.on("player:moved", wrap((p: any) => h.onPlayerMoved(p)));
  s.on("player:speaking", wrap((p: any) => h.onPlayerSpeaking(p)));
  s.on("player:emote", wrap((p: any) => h.onPlayerEmote(p)));
  s.on("chat:message", wrap((p: any) => h.onChat(p)));
  s.on("movie:state", wrap((p: any) => h.onMovieState(p)));
  s.on("rooms:updated", wrap((p: any) => h.onRooms(p.rooms)));
  s.on("videos:catalog", wrap((p: any) => h.onCatalog(p.videos)));
  s.on("error:msg", wrap((p: any) => h.onError(p)));
  s.on("room:state", wrap((p: any) => h.onRoomState(p)));

  return () => {
    s.off("room:joined");
    s.off("player:join");
    s.off("player:leave");
    s.off("player:moved");
    s.off("player:speaking");
    s.off("player:emote");
    s.off("chat:message");
    s.off("movie:state");
    s.off("rooms:updated");
    s.off("videos:catalog");
    s.off("error:msg");
    s.off("room:state");
  };
}

export function createRoom(name: string, visibility: "public" | "private", playerName: string, appearance: Appearance) {
  getSocket().emit("room:create", { name, visibility, playerName, appearance });
}
export function joinRoom(roomId: string, playerName: string, appearance: Appearance) {
  getSocket().emit("room:join", { roomId, playerName, appearance });
}
export function leaveRoom() {
  getSocket().emit("room:leave");
}
export function sendMove(position: any, rotationY: number, animation: string) {
  getSocket().emit("player:move", { position, rotationY, animation });
}
export function sendSpeaking(speaking: boolean) {
  getSocket().emit("player:speaking", { speaking });
}
export function sendEmote(emote: string) {
  getSocket().emit("player:emote", { emote });
}
export function sendChat(text: string) {
  getSocket().emit("chat:send", { text });
}
export function selectVideo(videoId: string) {
  getSocket().emit("movie:select", { videoId });
}
export function playMovie() {
  getSocket().emit("movie:play");
}
export function pauseMovie() {
  getSocket().emit("movie:pause");
}
export function seekMovie(position: number) {
  getSocket().emit("movie:seek", { position });
}
export function listRooms() {
  getSocket().emit("rooms:list");
}
