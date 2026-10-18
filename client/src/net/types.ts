export interface Vec3 { x: number; y: number; z: number }
export interface Appearance {
  bodyColor: string;
  headColor: string;
  accentColor: string;
  /** Minecraft skin texture URL (textures.minecraft.net). */
  skinUrl?: string;
  /** Custom uploaded skin as a base64 PNG data-URL. */
  skinData?: string;
  model?: "classic" | "slim";
}
export type AnimationState = "idle" | "walking" | "running" | "jumping" | "sitting" | "crouching";

export interface PlayerState {
  id: string;
  name: string;
  appearance: Appearance;
  position: Vec3;
  rotationY: number;
  animation: AnimationState;
  speaking: boolean;
  muted: boolean;
  joinedAt: number;
}

export interface PlaybackState {
  status: "idle" | "playing" | "paused";
  videoId: string | null;
  videoUrl: string | null;
  title: string | null;
  position: number;
  updatedAt: number;
  hostId: string | null;
  revision: number;
}

export interface RoomState {
  roomId: string;
  name: string;
  visibility: "public" | "private";
  maxPlayers: number;
  players: PlayerState[];
  hostId: string;
  playback: PlaybackState;
  serverTime: number;
}

export interface ChatMessage {
  id: string;
  roomId: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
  kind: "message" | "system" | "emote";
}

export interface SampleVideo {
  id: string;
  title: string;
  url: string;
  duration: number;
  attribution: string;
}

export interface RoomSummary {
  id: string;
  name: string;
  visibility: string;
  playerCount: number;
  maxPlayers: number;
  hostId: string | null;
  nowPlaying: string | null;
}
