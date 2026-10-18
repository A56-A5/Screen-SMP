export type Visibility = "public" | "private";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Appearance {
  bodyColor: string;
  headColor: string;
  accentColor: string;
  /** Direct URL to a Minecraft skin texture (textures.minecraft.net). */
  skinUrl?: string;
  /** Data-URL PNG for a custom uploaded skin (takes precedence over skinUrl). */
  skinData?: string;
  /** Arm model width. */
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

export interface SampleVideo {
  id: string;
  title: string;
  url: string;
  duration: number;
  poster?: string;
  attribution: string;
}

export type PlaybackStatus = "idle" | "playing" | "paused";

export interface PlaybackState {
  status: PlaybackStatus;
  videoId: string | null;
  videoUrl: string | null;
  title: string | null;
  position: number;
  updatedAt: number;
  hostId: string | null;
  revision: number;
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

export interface RoomSummary {
  id: string;
  name: string;
  visibility: Visibility;
  playerCount: number;
  maxPlayers: number;
  hostId: string | null;
  nowPlaying: string | null;
}

export interface RoomState {
  roomId: string;
  name: string;
  visibility: Visibility;
  maxPlayers: number;
  players: PlayerState[];
  hostId: string;
  playback: PlaybackState;
  serverTime: number;
}

// Client -> Server event payloads
export interface CreateRoomPayload {
  name: string;
  visibility: Visibility;
  playerName: string;
  appearance: Appearance;
}

export interface JoinRoomPayload {
  roomId: string;
  playerName: string;
  appearance: Appearance;
}

export interface MovePayload {
  position: Vec3;
  rotationY: number;
  animation: AnimationState;
}

export interface ChatSendPayload {
  text: string;
}

export interface SelectVideoPayload {
  videoId: string;
}

export interface CustomVideoPayload {
  url: string;
  title: string;
}

export interface PlaybackCommandPayload {
  position?: number;
}

export interface EmotePayload {
  emote: string;
}
