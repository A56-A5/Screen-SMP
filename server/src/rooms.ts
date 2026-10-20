import { randomUUID } from "node:crypto";
import type {
  Appearance,
  ChatMessage,
  PlaybackState,
  PlayerState,
  RoomState,
  RoomSummary,
  SampleVideo,
  Vec3,
  Visibility,
} from "./types.js";

// Openly licensed sample videos (Blender Foundation via archive.org).
// Served through the generic proxy: same-origin (no CORS needed for WebGL
// textures) and resilient to upstream host changes. The old
// commondatastorage.googleapis.com bucket now returns AccessDenied.
export const SAMPLE_VIDEOS: SampleVideo[] = [
  {
    id: "big-buck-bunny",
    title: "Big Buck Bunny",
    url: `/api/stream?u=${encodeURIComponent(
      "https://archive.org/download/BigBuckBunny_124/Content/big_buck_bunny_720p_surround.mp4"
    )}`,
    duration: 596,
    attribution: "Blender Foundation — Creative Commons Attribution 3.0",
  },
  {
    id: "elephants-dream",
    title: "Elephants Dream",
    url: `/api/stream?u=${encodeURIComponent(
      "https://archive.org/download/ElephantsDream/ed_1024_512kb.mp4"
    )}`,
    duration: 653,
    attribution: "Blender Foundation — Creative Commons Attribution 2.5",
  },
  {
    id: "sintel",
    title: "Sintel",
    url: `/api/stream?u=${encodeURIComponent(
      "https://archive.org/download/Sintel/sintel-2048-surround_512kb.mp4"
    )}`,
    duration: 888,
    attribution: "Blender Foundation — Creative Commons Attribution 3.0",
  },
  {
    id: "tears-of-steel",
    title: "Tears of Steel",
    url: `/api/stream?u=${encodeURIComponent(
      "https://archive.org/download/Tears-of-Steel/tears_of_steel_720p.mp4"
    )}`,
    duration: 734,
    attribution: "Blender Foundation — Creative Commons Attribution 3.0",
  },
];

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_NAME_LENGTH = 24;
const MAX_CHAT_LENGTH = 500;
const MAX_ROOM_NAME_LENGTH = 40;
const POSITION_BOUNDS = { min: -80, max: 80 };
const DRIFT_TOLERANCE = 2.5;

function generateRoomId(): string {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function sanitizeName(name: string): string {
  return name.trim().slice(0, MAX_NAME_LENGTH) || "Guest";
}

function sanitizeAppearance(a: Partial<Appearance> | undefined): Appearance {
  const safeColor = (c: unknown, fallback: string): string =>
    typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c) ? c : fallback;

  return {
    bodyColor: safeColor(a?.bodyColor, "#4f8f4f"),
    headColor: safeColor(a?.headColor, "#e8c39e"),
    accentColor: safeColor(a?.accentColor, "#2f5f9f"),
  };
}

function clampPosition(p: Vec3): Vec3 {
  return {
    x: clamp(Number.isFinite(p.x) ? p.x : 0, POSITION_BOUNDS.min, POSITION_BOUNDS.max),
    y: clamp(Number.isFinite(p.y) ? p.y : 0, -5, 40),
    z: clamp(Number.isFinite(p.z) ? p.z : 0, POSITION_BOUNDS.min, POSITION_BOUNDS.max),
  };
}

function clampRotation(r: number): number {
  const n = Number.isFinite(r) ? r : 0;
  // Normalize to [-PI, PI]
  return Math.atan2(Math.sin(n), Math.cos(n));
}

interface Room {
  id: string;
  name: string;
  visibility: Visibility;
  maxPlayers: number;
  hostId: string;
  players: Map<string, PlayerState>;
  playback: PlaybackState;
  lightsOn: boolean;
  chat: ChatMessage[];
  createdAt: number;
}

export class RoomManager {
  private rooms = new Map<string, Room>();
  private playerRoom = new Map<string, string>();
  private readonly maxChatHistory = 200;

  createRoom(
    ownerSocketId: string,
    opts: { name: string; visibility: Visibility; playerName: string; appearance: Appearance }
  ): RoomState {
    // One room per socket connection for simplicity.
    if (this.playerRoom.has(ownerSocketId)) {
      this.leaveRoom(ownerSocketId);
    }

    let id = generateRoomId();
    while (this.rooms.has(id)) id = generateRoomId();

    const now = Date.now();
    const roomName = opts.name.trim().slice(0, MAX_ROOM_NAME_LENGTH) || "Watch Party";
    const player: PlayerState = {
      id: ownerSocketId,
      name: sanitizeName(opts.playerName),
      appearance: sanitizeAppearance(opts.appearance),
      position: { x: 0, y: 0, z: 12 },
      rotationY: Math.PI,
      animation: "idle",
      speaking: false,
      muted: false,
      joinedAt: now,
    };

    const room: Room = {
      id,
      name: roomName,
      visibility: opts.visibility,
      maxPlayers: 16,
      hostId: ownerSocketId,
      players: new Map([[ownerSocketId, player]]),
      playback: {
        status: "idle",
        videoId: null,
        videoUrl: null,
        title: null,
        position: 0,
        updatedAt: now,
        hostId: ownerSocketId,
        revision: 0,
      },
      chat: [],
      lightsOn: true,
      createdAt: now,
    };

    this.rooms.set(id, room);
    this.playerRoom.set(ownerSocketId, id);
    return this.toRoomState(room);
  }

  joinRoom(
    socketId: string,
    opts: { roomId: string; playerName: string; appearance: Appearance }
  ): { ok: true; state: RoomState } | { ok: false; error: string } {
    const roomId = opts.roomId.trim().toUpperCase();
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, error: "Room not found." };
    if (room.players.size >= room.maxPlayers) return { ok: false, error: "Room is full." };

    if (this.playerRoom.has(socketId)) {
      this.leaveRoom(socketId);
    }

    const now = Date.now();
    const player: PlayerState = {
      id: socketId,
      name: sanitizeName(opts.playerName),
      appearance: sanitizeAppearance(opts.appearance),
      position: { x: 0, y: 0, z: 12 },
      rotationY: Math.PI,
      animation: "idle",
      speaking: false,
      muted: false,
      joinedAt: now,
    };
    room.players.set(socketId, player);
    this.playerRoom.set(socketId, roomId);

    this.addSystemMessage(room, `${player.name} joined the room.`);
    return { ok: true, state: this.toRoomState(room) };
  }

  leaveRoom(socketId: string): { roomId: string; leftName: string; state: RoomState | null } | null {
    const roomId = this.playerRoom.get(socketId);
    if (!roomId) return null;
    const room = this.rooms.get(roomId);
    this.playerRoom.delete(socketId);
    if (!room) return null;

    const player = room.players.get(socketId);
    const leftName = player?.name ?? "Someone";
    room.players.delete(socketId);
    this.addSystemMessage(room, `${leftName} left the room.`);

    if (room.players.size === 0) {
      this.rooms.delete(roomId);
      return { roomId, leftName, state: null };
    }

    if (room.hostId === socketId) {
      // Transfer host to the earliest joined remaining player.
      const nextHost = [...room.players.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
      room.hostId = nextHost.id;
      room.playback.hostId = nextHost.id;
      room.playback.status = "paused";
      room.playback.updatedAt = Date.now();
      room.playback.revision += 1;
      this.addSystemMessage(room, `${nextHost.name} is now the host.`);
    }

    return { roomId, leftName, state: this.toRoomState(room) };
  }

  updatePosition(
    socketId: string,
    data: { position: Vec3; rotationY: number; animation: string }
  ): { roomId: string; state: Partial<PlayerState> } | null {
    const roomId = this.playerRoom.get(socketId);
    if (!roomId) return null;
    const room = this.rooms.get(roomId);
    if (!room) return null;
    const player = room.players.get(socketId);
    if (!player) return null;

    const animation = (["idle", "walking", "running", "jumping", "sitting", "crouching"] as const).includes(
      data.animation as PlayerState["animation"]
    )
      ? (data.animation as PlayerState["animation"])
      : "idle";

    player.position = clampPosition(data.position);
    player.rotationY = clampRotation(data.rotationY);
    player.animation = animation;

    return {
      roomId,
      state: { id: socketId, position: player.position, rotationY: player.rotationY, animation },
    };
  }

  setSpeaking(socketId: string, speaking: boolean): { roomId: string; playerId: string; speaking: boolean } | null {
    const roomId = this.playerRoom.get(socketId);
    if (!roomId) return null;
    const room = this.rooms.get(roomId);
    if (!room) return null;
    const player = room.players.get(socketId);
    if (!player) return null;
    player.speaking = speaking;
    return { roomId, playerId: socketId, speaking };
  }

  addChat(
    socketId: string,
    text: string
  ): { ok: true; message: ChatMessage; roomId: string } | { ok: false; error: string } {
    const roomId = this.playerRoom.get(socketId);
    if (!roomId) return { ok: false, error: "You are not in a room." };
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, error: "Room not found." };
    const player = room.players.get(socketId);
    if (!player) return { ok: false, error: "Player not found." };

    const trimmed = text.trim();
    if (!trimmed) return { ok: false, error: "Empty message." };
    if (trimmed.length > MAX_CHAT_LENGTH) {
      return { ok: false, error: `Message too long (max ${MAX_CHAT_LENGTH} characters).` };
    }

    const message: ChatMessage = {
      id: randomUUID(),
      roomId,
      senderId: socketId,
      senderName: player.name,
      text: trimmed,
      timestamp: Date.now(),
      kind: trimmed.startsWith("/") ? "emote" : "message",
    };
    room.chat.push(message);
    if (room.chat.length > this.maxChatHistory) {
      room.chat.splice(0, room.chat.length - this.maxChatHistory);
    }
    return { ok: true, message, roomId };
  }

  selectVideo(
    socketId: string,
    videoId: string,
    titleHint?: string
  ): { ok: true; state: PlaybackState; roomId: string; title: string } | { ok: false; error: string } {
    const roomId = this.playerRoom.get(socketId);
    if (!roomId) return { ok: false, error: "You are not in a room." };
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, error: "Room not found." };
    if (room.hostId !== socketId) return { ok: false, error: "Only the host can change the video." };
    if (videoId.length > 4096) return { ok: false, error: "That selection is too long." };

    let id: string;
    let url: string;
    let title: string;

    const catalogVideo = SAMPLE_VIDEOS.find((v) => v.id === videoId);
    if (catalogVideo) {
      id = catalogVideo.id;
      url = catalogVideo.url;
      title = catalogVideo.title;
    } else if (videoId.startsWith("yt:")) {
      // YouTube selection: URL is always built server-side from a validated id.
      const ytId = videoId.slice(3);
      if (!/^[A-Za-z0-9_-]{11}$/.test(ytId)) {
        return { ok: false, error: "Invalid YouTube video." };
      }
      id = `yt:${ytId}`;
      url = `/api/youtube/stream?videoId=${ytId}`;
      title = titleHint?.trim() || `YouTube · ${ytId}`;
    } else if (videoId.startsWith("url:")) {
      // Arbitrary link: already validated + resolved by the caller; streams
      // through the generic proxy (which re-resolves on expired signatures).
      id = videoId;
      url = `/api/stream?u=${videoId.slice(4)}`;
      title = titleHint?.trim() || "Video link";
    } else {
      return { ok: false, error: "Unknown video." };
    }

    room.playback = {
      status: "paused",
      videoId: id,
      videoUrl: url,
      title,
      position: 0,
      updatedAt: Date.now(),
      hostId: room.hostId,
      revision: room.playback.revision + 1,
    };
    this.addSystemMessage(room, `Now selected: ${title}`);
    return { ok: true, state: room.playback, roomId, title };
  }

  playbackCommand(
    socketId: string,
    cmd: { action: "play" | "pause" | "seek"; position?: number }
  ): { ok: true; state: PlaybackState; roomId: string } | { ok: false; error: string } {
    const roomId = this.playerRoom.get(socketId);
    if (!roomId) return { ok: false, error: "You are not in a room." };
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, error: "Room not found." };
    if (room.hostId !== socketId) return { ok: false, error: "Only the host can control playback." };
    if (!room.playback.videoUrl) return { ok: false, error: "No video selected." };

    const now = Date.now();

    if (cmd.action === "seek") {
      if (typeof cmd.position !== "number" || !Number.isFinite(cmd.position)) {
        return { ok: false, error: "Invalid seek position." };
      }
      const pos = clamp(cmd.position, 0, 100000);
      room.playback.position = pos;
      room.playback.status = "paused";
    } else if (cmd.action === "play") {
      // Resume from canonical position advanced by elapsed wall-clock time.
      const elapsed = room.playback.status === "playing" ? (now - room.playback.updatedAt) / 1000 : 0;
      room.playback.position = clamp(room.playback.position + elapsed, 0, 100000);
      room.playback.status = "playing";
    } else {
      // pause: freeze current position
      if (room.playback.status === "playing") {
        const elapsed = (now - room.playback.updatedAt) / 1000;
        room.playback.position = clamp(room.playback.position + elapsed, 0, 100000);
      }
      room.playback.status = "paused";
    }

    room.playback.updatedAt = now;
    room.playback.hostId = room.hostId;
    room.playback.revision += 1;
    return { ok: true, state: room.playback, roomId };
  }

  /**
   * Periodically advance the canonical playback position so late joiners get
   * an accurate starting point without clients reporting every frame.
   */
  tickPlayback(): void {
    const now = Date.now();
    for (const room of this.rooms.values()) {
      if (room.playback.status === "playing") {
        const elapsed = (now - room.playback.updatedAt) / 1000;
        room.playback.position = clamp(room.playback.position + elapsed, 0, 100000);
        room.playback.updatedAt = now;
      }
    }
  }

  /** Flip the theatre lights. Any player in the room can use the lever. */
  toggleLights(
    socketId: string
  ): { ok: true; roomId: string; lightsOn: boolean } | { ok: false; error: string } {
    const roomId = this.playerRoom.get(socketId);
    if (!roomId) return { ok: false, error: "You are not in a room." };
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, error: "Room not found." };
    room.lightsOn = !room.lightsOn;
    return { ok: true, roomId, lightsOn: room.lightsOn };
  }

  getRoomState(socketId: string): RoomState | null {
    const roomId = this.playerRoom.get(socketId);
    if (!roomId) return null;
    const room = this.rooms.get(roomId);
    return room ? this.toRoomState(room) : null;
  }

  getRoomIdForPlayer(socketId: string): string | null {
    return this.playerRoom.get(socketId) ?? null;
  }

  listPublicRooms(): RoomSummary[] {
    const out: RoomSummary[] = [];
    for (const room of this.rooms.values()) {
      if (room.visibility !== "public") continue;
      out.push({
        id: room.id,
        name: room.name,
        visibility: room.visibility,
        playerCount: room.players.size,
        maxPlayers: room.maxPlayers,
        hostId: room.hostId,
        nowPlaying: room.playback.title,
      });
    }
    return out.sort((a, b) => b.playerCount - a.playerCount).slice(0, 30);
  }

  getSampleVideos(): SampleVideo[] {
    return SAMPLE_VIDEOS;
  }

  private addSystemMessage(room: Room, text: string): void {
    const message: ChatMessage = {
      id: randomUUID(),
      roomId: room.id,
      senderId: "system",
      senderName: "System",
      text,
      timestamp: Date.now(),
      kind: "system",
    };
    room.chat.push(message);
    if (room.chat.length > this.maxChatHistory) {
      room.chat.splice(0, room.chat.length - this.maxChatHistory);
    }
  }

  private toRoomState(room: Room): RoomState {
    return {
      roomId: room.id,
      name: room.name,
      visibility: room.visibility,
      maxPlayers: room.maxPlayers,
      players: [...room.players.values()],
      hostId: room.hostId,
      playback: { ...room.playback },
      lightsOn: room.lightsOn,
      serverTime: Date.now(),
    };
  }
}

export { DRIFT_TOLERANCE, MAX_CHAT_LENGTH, MAX_NAME_LENGTH };
