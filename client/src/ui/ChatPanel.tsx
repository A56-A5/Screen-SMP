import { useEffect, useRef, useState, useCallback } from "react";
import type { ChatMessage } from "../net/types";

/**
 * Minecraft-style chat:
 * - T (or Enter) opens the chat input; / opens with a slash pre-filled.
 * - Messages appear as overlay lines at the bottom-left, like Minecraft.
 * - When closed, recent messages fade out after a few seconds.
 * - A toggle button hides/shows chat entirely.
 * - Escape closes the input without sending.
 */
export function ChatPanel({
  messages,
  onSend,
  hidden,
  onToggleHidden,
}: {
  messages: ChatMessage[];
  onSend: (text: string) => void;
  hidden: boolean;
  onToggleHidden: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Global key handler: T opens chat, Enter also opens, / opens with slash.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (open) return;
      if (e.code === "KeyT") {
        e.preventDefault();
        setDraft("");
        setOpen(true);
        requestAnimationFrame(() => inputRef.current?.focus());
      } else if (e.code === "Slash") {
        e.preventDefault();
        setDraft("/");
        setOpen(true);
        requestAnimationFrame(() => inputRef.current?.focus());
      } else if (e.code === "Enter") {
        e.preventDefault();
        setDraft("");
        setOpen(true);
        requestAnimationFrame(() => inputRef.current?.focus());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const close = useCallback(() => {
    setOpen(false);
    setDraft("");
    inputRef.current?.blur();
  }, []);

  const send = useCallback(() => {
    const t = draft.trim();
    if (t) onSend(t);
    close();
  }, [draft, onSend, close]);

  const formatTime = (ts: number) =>
    new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  // Show the last ~8 messages as overlay lines; when open show more.
  const shown = open ? messages.slice(-12) : messages.slice(-8);
  const fadeAfter = open ? Infinity : 6000; // fade closed messages after 6s
  const now = Date.now();

  if (hidden && !open) {
    return (
      <button className="mc-chat-toggle mc-chat-hidden-btn" onClick={onToggleHidden} title="Show chat (T)">
        💬
      </button>
    );
  }

  return (
    <div className="mc-chat">
      <button className="mc-chat-toggle" onClick={onToggleHidden} title="Hide chat">
        ✕
      </button>
      <div className="mc-chat-lines">
        {shown.map((m) => {
          const age = now - m.timestamp;
          const fading = !open && age > fadeAfter;
          if (fading) return null;
          return (
            <div
              key={m.id}
              className={`mc-chat-line ${m.kind === "system" || m.kind === "emote" ? "system" : ""}`}
            >
              {m.kind === "message" && (
                <span className="mc-chat-sender">
                  &lt;{m.senderName}&gt;{" "}
                </span>
              )}
              <span className="mc-chat-text">{m.text}</span>
              {open && <span className="mc-chat-time">{formatTime(m.timestamp)}</span>}
            </div>
          );
        })}
      </div>
      {open && (
        <div className="mc-chat-input-row">
          <input
            ref={inputRef}
            type="text"
            maxLength={500}
            className="mc-chat-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                close();
              }
            }}
            placeholder="Type a message…"
          />
        </div>
      )}
      {!open && (
        <div className="mc-chat-hint">Press T to chat</div>
      )}
    </div>
  );
}
