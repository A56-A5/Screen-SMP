import { test } from "node:test";
import assert from "node:assert/strict";
import { RoomManager, SAMPLE_VIDEOS } from "../src/rooms.js";

const appearance = { bodyColor: "#112233", headColor: "#445566", accentColor: "#778899" };

test("create and join room with two clients", () => {
  const m = new RoomManager();
  const room = m.createRoom("sock-a", {
    name: "Test Room",
    visibility: "public",
    playerName: "Alice",
    appearance,
  });
  assert.equal(room.roomId.length, 6);
  assert.equal(room.players.length, 1);
  assert.equal(room.hostId, "sock-a");

  const join = m.joinRoom("sock-b", { roomId: room.roomId, playerName: "Bob", appearance });
  assert.ok(join.ok);
  if (!join.ok) return;
  assert.equal(join.state.players.length, 2);
});

test("join invalid room fails", () => {
  const m = new RoomManager();
  const res = m.joinRoom("sock-a", { roomId: "ZZZZZZ", playerName: "X", appearance });
  assert.ok(!res.ok);
});

test("movement updates position and broadcasts", () => {
  const m = new RoomManager();
  m.createRoom("sock-a", { name: "R", visibility: "private", playerName: "A", appearance });
  const upd = m.updatePosition("sock-a", {
    position: { x: 5, y: 0, z: -3 },
    rotationY: 1.2,
    animation: "walking",
  });
  assert.ok(upd);
  assert.equal(upd?.state.position.x, 5);
  assert.equal(upd?.state.animation, "walking");
});

test("movement position is clamped to world bounds", () => {
  const m = new RoomManager();
  m.createRoom("sock-a", { name: "R", visibility: "private", playerName: "A", appearance });
  const upd = m.updatePosition("sock-a", {
    position: { x: 9999, y: 0, z: -9999 },
    rotationY: 0,
    animation: "idle",
  });
  assert.ok(upd);
  assert.ok((upd?.state.position.x ?? 0) <= 80);
  assert.ok((upd?.state.position.z ?? 0) >= -80);
});

test("player leave removes character and transfers host", () => {
  const m = new RoomManager();
  const room = m.createRoom("sock-a", { name: "R", visibility: "public", playerName: "Alice", appearance });
  m.joinRoom("sock-b", { roomId: room.roomId, playerName: "Bob", appearance });

  const left = m.leaveRoom("sock-a");
  assert.ok(left);
  assert.equal(left?.roomId, room.roomId);

  const state = m.getRoomState("sock-b");
  assert.ok(state);
  assert.equal(state?.players.length, 1);
  assert.equal(state?.hostId, "sock-b");
});

test("empty room is cleaned up", () => {
  const m = new RoomManager();
  m.createRoom("sock-a", { name: "R", visibility: "public", playerName: "A", appearance });
  const left = m.leaveRoom("sock-a");
  assert.ok(left);
  assert.equal(left?.state, null);
  assert.equal(m.listPublicRooms().length, 0);
});

test("chat messages reach room, oversized rejected", () => {
  const m = new RoomManager();
  const room = m.createRoom("sock-a", { name: "R", visibility: "private", playerName: "Alice", appearance });
  const ok = m.addChat("sock-a", "hello world");
  assert.ok(ok.ok);

  const tooLong = m.addChat("sock-a", "x".repeat(1000));
  assert.ok(!tooLong.ok);
});

test("chat from player not in room is rejected", () => {
  const m = new RoomManager();
  const res = m.addChat("stranger", "hi");
  assert.ok(!res.ok);
});

test("host play/pause/seek propagates canonical state", () => {
  const m = new RoomManager();
  m.createRoom("host", { name: "R", visibility: "private", playerName: "H", appearance });
  const sel = m.selectVideo("host", SAMPLE_VIDEOS[0].id);
  assert.ok(sel.ok);

  const play = m.playbackCommand("host", { action: "play" });
  assert.ok(play.ok);
  assert.equal(play.ok && play.state.status, "playing");

  const seek = m.playbackCommand("host", { action: "seek", position: 42 });
  assert.ok(seek.ok);
  assert.ok(seek.ok && seek.state.position === 42);
  // seek sets paused
  assert.ok(seek.ok && seek.state.status === "paused");

  const pause = m.playbackCommand("host", { action: "pause" });
  assert.ok(pause.ok);
});

test("late joiner receives current playback state", () => {
  const m = new RoomManager();
  const room = m.createRoom("host", { name: "R", visibility: "public", playerName: "H", appearance });
  m.selectVideo("host", SAMPLE_VIDEOS[1].id);
  m.playbackCommand("host", { action: "seek", position: 100 });
  m.playbackCommand("host", { action: "play" });

  const join = m.joinRoom("late", { roomId: room.roomId, playerName: "L", appearance });
  assert.ok(join.ok);
  if (!join.ok) return;
  assert.equal(join.state.playback.videoId, SAMPLE_VIDEOS[1].id);
  assert.equal(join.state.playback.status, "playing");
  assert.ok(join.state.playback.position >= 100);
});

test("non-host playback commands are rejected", () => {
  const m = new RoomManager();
  const room = m.createRoom("host", { name: "R", visibility: "private", playerName: "H", appearance });
  m.joinRoom("guest", { roomId: room.roomId, playerName: "G", appearance });
  m.selectVideo("host", SAMPLE_VIDEOS[0].id);

  assert.ok(!m.playbackCommand("guest", { action: "play" }).ok);
  assert.ok(!m.selectVideo("guest", SAMPLE_VIDEOS[1].id).ok);
});

test("invalid video source is rejected", () => {
  const m = new RoomManager();
  m.createRoom("host", { name: "R", visibility: "private", playerName: "H", appearance });
  const res = m.selectVideo("host", "not-a-real-id");
  assert.ok(!res.ok);
});

test("host disconnect pauses playback and assigns new host", () => {
  const m = new RoomManager();
  const room = m.createRoom("host", { name: "R", visibility: "public", playerName: "H", appearance });
  m.joinRoom("guest", { roomId: room.roomId, playerName: "G", appearance });
  m.selectVideo("host", SAMPLE_VIDEOS[0].id);
  m.playbackCommand("host", { action: "play" });

  m.leaveRoom("host");
  const state = m.getRoomState("guest");
  assert.ok(state);
  assert.equal(state?.hostId, "guest");
  assert.equal(state?.playback.status, "paused");
});

test("reconnecting client gets fresh room snapshot", () => {
  const m = new RoomManager();
  const room = m.createRoom("host", { name: "R", visibility: "public", playerName: "H", appearance });
  m.joinRoom("guest", { roomId: room.roomId, playerName: "G", appearance });
  // Simulate reconnect: leave then rejoin, should get full state.
  m.leaveRoom("guest");
  const rejoin = m.joinRoom("guest", { roomId: room.roomId, playerName: "G", appearance });
  assert.ok(rejoin.ok);
  if (!rejoin.ok) return;
  assert.equal(rejoin.state.players.length, 2);
  assert.ok(rejoin.state.serverTime > 0);
});

test("speaking indicator is tracked", () => {
  const m = new RoomManager();
  m.createRoom("host", { name: "R", visibility: "private", playerName: "H", appearance });
  const upd = m.setSpeaking("host", true);
  assert.ok(upd);
  assert.equal(upd?.speaking, true);
});

test("private rooms are not listed publicly", () => {
  const m = new RoomManager();
  m.createRoom("a", { name: "Secret", visibility: "private", playerName: "A", appearance });
  m.createRoom("b", { name: "Open", visibility: "public", playerName: "B", appearance });
  const list = m.listPublicRooms();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "Open");
});
