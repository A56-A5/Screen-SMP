/**
 * Live multiplayer smoke test: starts nothing itself, expects the server
 * to already be running on :4000. Creates a room with client A, joins with
 * client B, moves, chats, and verifies playback sync — all over real sockets.
 */
import { io } from "socket.io-client";
import assert from "node:assert/strict";

const URL = process.env.TEST_URL ?? "http://localhost:4000";
const appearance = { bodyColor: "#112233", headColor: "#445566", accentColor: "#778899" };

function connect(): Promise<any> {
  return new Promise((resolve, reject) => {
    const s = io(URL, { transports: ["websocket"] });
    s.on("connect", () => resolve(s));
    s.on("connect_error", reject);
    setTimeout(() => reject(new Error("connect timeout")), 5000);
  });
}

async function main() {
  const a = await connect();
  const b = await connect();

  // A creates a room
  const joinedA = new Promise<any>((res) => a.once("room:joined", res));
  a.emit("room:create", { name: "Smoke", visibility: "public", playerName: "Alice", appearance });
  const stateA = await joinedA;
  const roomId = stateA.state.roomId;
  assert.ok(roomId, "room created");

  // B joins the same room
  const joinedB = new Promise<any>((res) => b.once("room:joined", res));
  const playerJoinOnA = new Promise<any>((res) => a.once("player:join", res));
  b.emit("room:join", { roomId, playerName: "Bob", appearance });
  await joinedB;
  const joinEvent = await playerJoinOnA;
  assert.equal(joinEvent.player.name, "Bob", "A sees Bob join");
  console.log("✔ two clients share a room");

  // A moves, B receives the update
  const movedOnB = new Promise<any>((res) => b.once("player:moved", res));
  a.emit("player:move", { position: { x: 3, y: 0, z: 5 }, rotationY: 1, animation: "walking" });
  const move = await movedOnB;
  assert.equal(move.position.x, 3, "movement synced");
  console.log("✔ movement synced across clients");

  // A sends chat, B receives it
  const chatOnB = new Promise<any>((res) => b.once("chat:message", res));
  a.emit("chat:send", { text: "hello from Alice" });
  const msg = await chatOnB;
  assert.equal(msg.text, "hello from Alice");
  console.log("✔ chat synced");

  // A (host) selects a video and plays; B receives movie state
  const movieOnB = new Promise<any>((res) => b.once("movie:state", res));
  a.emit("movie:select", { videoId: "big-buck-bunny" });
  const sel = await movieOnB;
  assert.equal(sel.playback.videoId, "big-buck-bunny");

  const playOnB = new Promise<any>((res) => b.once("movie:state", res));
  a.emit("movie:play");
  const play = await playOnB;
  assert.equal(play.playback.status, "playing");
  console.log("✔ playback state synced");

  // B (non-host) tries to control playback — must be rejected
  const errOnB = new Promise<any>((res) => b.once("error:msg", res));
  b.emit("movie:pause");
  const err = await errOnB;
  assert.match(err.error, /host/i, "non-host rejected");
  console.log("✔ non-host playback rejected");

  // B leaves, A sees player:leave
  const leaveOnA = new Promise<any>((res) => a.once("player:leave", res));
  b.emit("room:leave");
  const left = await leaveOnA;
  assert.ok(left.playerId, "A notified of leave");
  console.log("✔ leave propagates");

  a.close();
  b.close();
  console.log("\nAll live multiplayer smoke tests passed.");
  process.exit(0);
}

main().catch((e) => {
  console.error("SMOKE TEST FAILED:", e);
  process.exit(1);
});
