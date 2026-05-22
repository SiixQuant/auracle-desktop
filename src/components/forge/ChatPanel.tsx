// Chat — right panel of the Forge view.
//
// Phase 1: single-shot Anthropic Messages API calls (no streaming).
// Each user turn appends to an in-memory transcript that we send
// as the full history on every call, so the model has context
// across turns. No persistence between sessions in this phase —
// Phase 2 adds per-strategy chat history.
//
// First-launch gate: if no Anthropic API key is in the keychain,
// the panel shows the key-setup UI instead of the chat input.
// The key never leaves the keychain — we don't echo it back to
// the renderer after save.

import { useEffect, useRef, useState } from "react";

import {
  cmd,
  onEvent,
  openInBrowser,
  type ChatChunkPayload,
  type ChatDonePayload,
  type ChatErrorPayload,
  type ChatMessage,
} from "@/lib/tauri";

interface ChatPanelProps {
  /** Path currently open in the editor — added as context. */
  activePath: string | null;
  /** Set by Forge.tsx; Editor consumes it then resets to null. */
  onInsertCode: (code: string) => void;
}

interface UiMessage {
  role: "user" | "assistant";
  content: string;
  /** Code blocks extracted from the assistant message, if any. */
  codeBlocks?: string[];
  /** Last call's token counts — only on the most recent assistant turn. */
  usage?: { in: number; out: number };
}

export default function ChatPanel({ activePath, onInsertCode }: ChatPanelProps) {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Initial key probe.
  useEffect(() => {
    cmd.anthropicKeyGet()
      .then((v) => setHasKey(!!v))
      .catch(() => setHasKey(false));
  }, []);

  // Auto-scroll to the bottom on new messages.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, sending]);

  const send = async () => {
    const trimmed = draft.trim();
    if (!trimmed || sending) return;

    const userMsg: UiMessage = { role: "user", content: trimmed };
    const nextHistory = [...messages, userMsg];

    setMessages(nextHistory);
    setDraft("");
    setSending(true);
    setError(null);

    // Build the API call. We prepend a synthetic "active file" hint
    // to the user's message so the model has filename context without
    // us hard-coding it into the system prompt every turn.
    const apiMessages: ChatMessage[] = nextHistory.map((m, i) => {
      if (i === nextHistory.length - 1 && activePath) {
        return {
          role: m.role,
          content: `[Working on ${activePath}]\n\n${m.content}`,
        };
      }
      return { role: m.role, content: m.content };
    });

    // Streaming send: subscribe to the three Tauri event types BEFORE
    // invoking, then invoke. The Rust side spawns a tokio task and
    // emits chunks as they arrive. We accumulate into a placeholder
    // assistant message and finalize on `done`.
    //
    // Listener teardown happens in `finalize()` — both the done +
    // error paths call it, so we don't leak Tauri listeners across
    // turns.

    // Append a placeholder assistant message we'll mutate in-place
    // as chunks arrive. The empty string renders as nothing until
    // the first chunk lands.
    setMessages((prev) => [
      ...prev,
      { role: "assistant", content: "" },
    ]);

    let unlistenChunk: (() => void) | null = null;
    let unlistenDone: (() => void) | null = null;
    let unlistenError: (() => void) | null = null;

    const teardown = () => {
      try { unlistenChunk?.(); } catch {}
      try { unlistenDone?.(); } catch {}
      try { unlistenError?.(); } catch {}
      unlistenChunk = unlistenDone = unlistenError = null;
    };

    const onChunk = (payload: ChatChunkPayload) => {
      // Append to the last assistant message in the buffer.
      setMessages((prev) => {
        if (prev.length === 0) return prev;
        const next = prev.slice();
        const last = next[next.length - 1];
        if (last.role !== "assistant") return prev;
        next[next.length - 1] = {
          ...last,
          content: last.content + payload.text,
        };
        return next;
      });
    };

    const onDone = (payload: ChatDonePayload) => {
      // Final settle: replace the streamed text with the
      // authoritative full_text (handles the edge case where a
      // chunk dropped), pull out code blocks for the Insert cards,
      // attach usage.
      setMessages((prev) => {
        if (prev.length === 0) return prev;
        const next = prev.slice();
        const last = next[next.length - 1];
        if (last.role !== "assistant") return prev;
        next[next.length - 1] = {
          ...last,
          content: payload.full_text,
          codeBlocks: extractCodeBlocks(payload.full_text),
          usage: { in: payload.usage_in, out: payload.usage_out },
        };
        return next;
      });
      setSending(false);
      teardown();
    };

    const onError = (payload: ChatErrorPayload) => {
      setError(payload.message);
      // Roll back the user turn + the placeholder assistant turn
      // so retry doesn't burn the message and the transcript stays
      // clean.
      setMessages((prev) => prev.slice(0, -2));
      setDraft(trimmed);
      setSending(false);
      teardown();
    };

    try {
      unlistenChunk = await onEvent<ChatChunkPayload>(
        "forge-chat-chunk",
        onChunk,
      );
      unlistenDone = await onEvent<ChatDonePayload>(
        "forge-chat-done",
        onDone,
      );
      unlistenError = await onEvent<ChatErrorPayload>(
        "forge-chat-error",
        onError,
      );
      await cmd.forgeChatStream(apiMessages);
    } catch (err) {
      // Synchronous failure from the invoke (e.g. no API key set
      // raises a typed Err on the Rust side before any events fire).
      setError(String(err));
      setMessages((prev) => prev.slice(0, -2));
      setDraft(trimmed);
      setSending(false);
      teardown();
    }
  };

  // First-launch / no-key state.
  if (hasKey === null) {
    return (
      <div className="forge-panel">
        <div className="forge-panel-head">Chat</div>
        <div className="muted mono forge-empty">loading…</div>
      </div>
    );
  }
  if (!hasKey) {
    return (
      <ApiKeySetup
        onSaved={() => {
          setHasKey(true);
        }}
      />
    );
  }

  return (
    <div className="forge-panel">
      <div className="forge-panel-head">
        Chat
        <button
          type="button"
          className="forge-link"
          onClick={() => {
            if (confirm("Clear the chat transcript?")) setMessages([]);
          }}
          title="Clear transcript"
        >
          clear
        </button>
      </div>

      <div ref={scrollRef} className="forge-chat-scroll">
        {messages.length === 0 && (
          <div className="muted forge-empty">
            <p style={{ margin: 0 }}>
              Ask Claude to write a strategy, explain the open file, or
              suggest a tweak. Code blocks come with an{" "}
              <strong>Insert</strong> button that drops them into the
              editor.
            </p>
            <p style={{ marginTop: 12, fontSize: 12 }}>
              Examples:
            </p>
            <ul
              style={{
                marginTop: 4,
                paddingLeft: 18,
                color: "var(--fg-dim)",
                fontSize: 13,
                lineHeight: 1.6,
              }}
            >
              <li>Make me an RSI mean-reversion on liquid US ETFs</li>
              <li>Convert this strategy to use weekly bars instead of daily</li>
              <li>Why is my Sharpe negative?</li>
            </ul>
          </div>
        )}

        {messages.map((m, i) => {
          const isLast = i === messages.length - 1;
          const isStreamingPlaceholder =
            isLast && sending && m.role === "assistant" && m.content === "";
          return (
            <MessageBubble
              key={i}
              message={m}
              onInsertCode={onInsertCode}
              streaming={isStreamingPlaceholder}
            />
          );
        })}
      </div>

      {error && (
        <div className="forge-chat-error mono">
          {error}
        </div>
      )}

      <div className="forge-chat-input">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={
            activePath
              ? `Ask about ${activePath}, or generate something new…`
              : "Ask Claude to write a strategy or open a file first…"
          }
          rows={3}
        />
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: 6,
          }}
        >
          <div className="muted mono" style={{ fontSize: 11 }}>
            ⌘+Enter to send
          </div>
          <button
            type="button"
            className="primary"
            disabled={sending || !draft.trim()}
            onClick={send}
          >
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Message bubble ──────────────────────────────────────────────

function MessageBubble({
  message,
  onInsertCode,
  streaming,
}: {
  message: UiMessage;
  onInsertCode: (code: string) => void;
  streaming?: boolean;
}) {
  const isUser = message.role === "user";
  const blocks = message.codeBlocks ?? [];

  return (
    <div className={`forge-msg ${isUser ? "user" : "assistant"}`}>
      <div className="forge-msg-role">{isUser ? "you" : "claude"}</div>
      <div className="forge-msg-content">
        {streaming ? (
          <div className="muted">thinking…</div>
        ) : (
          renderContent(message.content, blocks, onInsertCode)
        )}
      </div>
      {message.usage && (
        <div className="forge-msg-meta mono">
          {message.usage.in} in · {message.usage.out} out
        </div>
      )}
    </div>
  );
}

/**
 * Render assistant text with fenced ```python blocks pulled out as
 * code cards with an "Insert into editor" button. Everything else
 * renders as plain pre-wrapped text so paragraphs and lists stay
 * readable without a full markdown engine.
 */
function renderContent(
  text: string,
  _blocks: string[],
  onInsertCode: (code: string) => void,
) {
  const parts: Array<{ kind: "text" | "code"; value: string }> = [];
  const re = /```(?:python|py)?\s*\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ kind: "text", value: text.slice(lastIndex, match.index) });
    }
    parts.push({ kind: "code", value: match[1] });
    lastIndex = re.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push({ kind: "text", value: text.slice(lastIndex) });
  }

  return (
    <>
      {parts.map((part, i) =>
        part.kind === "text" ? (
          <div key={i} className="forge-msg-text">
            {part.value}
          </div>
        ) : (
          <div key={i} className="forge-msg-code">
            <pre>
              <code>{part.value}</code>
            </pre>
            <div className="forge-msg-code-actions">
              <button
                type="button"
                className="ghost"
                onClick={() => onInsertCode(part.value)}
                title="Replace the editor's current content with this code"
              >
                Insert into editor
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  navigator.clipboard.writeText(part.value).catch(() => {});
                }}
              >
                Copy
              </button>
            </div>
          </div>
        ),
      )}
    </>
  );
}

function extractCodeBlocks(text: string): string[] {
  const blocks: string[] = [];
  const re = /```(?:python|py)?\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) blocks.push(m[1]);
  return blocks;
}

// ── API-key setup screen ────────────────────────────────────────

function ApiKeySetup({ onSaved }: { onSaved: () => void }) {
  const [value, setValue] = useState("");
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const v = value.trim();
    if (!v) {
      setStatus("Paste a key first.");
      return;
    }
    setSaving(true);
    setStatus("");
    try {
      await cmd.anthropicKeySet(v);
      setStatus("Saved.");
      setTimeout(onSaved, 400);
    } catch (err) {
      setStatus("Could not save: " + String(err));
      setSaving(false);
    }
  };

  return (
    <div className="forge-panel">
      <div className="forge-panel-head">Chat</div>
      <div className="forge-empty" style={{ display: "block", padding: 20 }}>
        <h2 style={{ marginTop: 0 }}>Connect Claude</h2>
        <p className="muted" style={{ marginBottom: 12 }}>
          Forge uses Anthropic&apos;s Claude API for code generation. Paste
          your key once — it&apos;s stored in your OS keychain and never
          written to disk.
        </p>
        <input
          type="password"
          placeholder="sk-ant-…"
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            marginTop: 12,
          }}
        >
          <button
            type="button"
            className="primary"
            disabled={saving}
            onClick={save}
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <span className="muted mono">{status}</span>
        </div>
        <p
          className="muted"
          style={{ fontSize: 12, marginTop: 20 }}
        >
          Don&apos;t have a key?{" "}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              openInBrowser("https://console.anthropic.com/");
            }}
          >
            console.anthropic.com
          </a>
          {" "}— sign up, hit{" "}
          <em>API Keys → Create Key</em>, paste here. Typical cost
          for one Forge strategy generation is roughly $0.003.
        </p>
      </div>
    </div>
  );
}
