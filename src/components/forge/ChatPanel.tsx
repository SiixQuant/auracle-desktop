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
  type ChatToolCallPayload,
  type ChatToolResultPayload,
} from "@/lib/tauri";

interface ChatPanelProps {
  /** Path currently open in the editor — added as context. */
  activePath: string | null;
  /** Set by Forge.tsx; Editor consumes it then resets to null. */
  onInsertCode: (code: string) => void;
  /**
   * When true, send dispatches to the agent loop (tool-use enabled).
   * When false, sends to the plain streaming chat (text-only).
   * Defaults to false to preserve existing Code-mode behavior.
   */
  useAgentTools?: boolean;
  /**
   * Optional callback when the agent successfully writes a file via
   * write_strategy. Forge uses this to auto-refresh the preview pane.
   */
  onAgentWroteFile?: (relPath: string) => void;
}

interface UiToolCall {
  tool_use_id: string;
  name: string;
  input_summary: string;
  status: "running" | "success" | "error";
  result_summary?: string;
}

interface UiMessage {
  role: "user" | "assistant";
  content: string;
  /** Tool calls made during this assistant turn (agent mode only). */
  toolCalls?: UiToolCall[];
  /** Code blocks extracted from the assistant message, if any. */
  codeBlocks?: string[];
  /** Last call's token counts — only on the most recent assistant turn. */
  usage?: { in: number; out: number };
}

export default function ChatPanel({
  activePath,
  onInsertCode,
  useAgentTools = false,
  onAgentWroteFile,
}: ChatPanelProps) {
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
    let unlistenToolCall: (() => void) | null = null;
    let unlistenToolResult: (() => void) | null = null;

    const teardown = () => {
      try { unlistenChunk?.(); } catch {}
      try { unlistenDone?.(); } catch {}
      try { unlistenError?.(); } catch {}
      try { unlistenToolCall?.(); } catch {}
      try { unlistenToolResult?.(); } catch {}
      unlistenChunk = unlistenDone = unlistenError = null;
      unlistenToolCall = unlistenToolResult = null;
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

    // Tool-event handlers (only relevant in agent mode, but cheap
    // to register either way — they just never fire for plain chat).
    const onToolCall = (payload: ChatToolCallPayload) => {
      setMessages((prev) => {
        if (prev.length === 0) return prev;
        const next = prev.slice();
        const last = next[next.length - 1];
        if (last.role !== "assistant") return prev;
        const newCall: UiToolCall = {
          tool_use_id: payload.tool_use_id,
          name: payload.name,
          input_summary: payload.input_summary,
          status: "running",
        };
        next[next.length - 1] = {
          ...last,
          toolCalls: [...(last.toolCalls ?? []), newCall],
        };
        return next;
      });
    };

    const onToolResult = (payload: ChatToolResultPayload) => {
      // Side effect: if the agent successfully wrote a file, tell
      // the parent so it can refresh the preview pane + (optionally)
      // open the file. Done via the prop so this component doesn't
      // need to know about Forge's state shape.
      if (
        payload.ok &&
        payload.name === "write_strategy" &&
        onAgentWroteFile
      ) {
        // The rel_path lives in input_summary because of how the
        // Rust summarize_tool_input is written for write_strategy.
        // (Same field the activity card title shows.)
        // Walk the toolCalls list to find the matching tool_use_id
        // and grab its input_summary deterministically rather than
        // relying on the prior-render's contents.
        setMessages((prev) => {
          if (prev.length === 0) return prev;
          const last = prev[prev.length - 1];
          const call = last.toolCalls?.find(
            (c) => c.tool_use_id === payload.tool_use_id,
          );
          if (call?.input_summary) {
            // setMessages callback should be pure but onAgentWroteFile
            // is a stable callback from the parent — calling here is
            // safe + ensures it fires once per result.
            setTimeout(() => onAgentWroteFile(call.input_summary), 0);
          }
          return prev;
        });
      }

      setMessages((prev) => {
        if (prev.length === 0) return prev;
        const next = prev.slice();
        const last = next[next.length - 1];
        if (last.role !== "assistant" || !last.toolCalls) return prev;
        next[next.length - 1] = {
          ...last,
          toolCalls: last.toolCalls.map((c) =>
            c.tool_use_id === payload.tool_use_id
              ? {
                  ...c,
                  status: payload.ok ? "success" : "error",
                  result_summary: payload.result_summary,
                }
              : c,
          ),
        };
        return next;
      });
    };

    try {
      // Subscribe to all five Tauri event types IN PARALLEL. Each
      // onEvent() is a separate IPC roundtrip to the Rust event hub;
      // doing them sequentially used to add ~5×IPC-RTT of dead time
      // between the user hitting Send and the request actually
      // leaving the machine. Promise.all collapses that into one
      // round-trip's worth of latency.
      //
      // Longer term: these listeners could be hoisted to a useEffect
      // mounted once per ChatPanel instance (handlers gated by a
      // "currently sending?" ref). That removes ALL subscription
      // overhead per turn. Out of scope for this perf pass — the
      // 5×→1× win here covers the user-perceived slowness.
      [
        unlistenChunk,
        unlistenDone,
        unlistenError,
        unlistenToolCall,
        unlistenToolResult,
      ] = await Promise.all([
        onEvent<ChatChunkPayload>("forge-chat-chunk", onChunk),
        onEvent<ChatDonePayload>("forge-chat-done", onDone),
        onEvent<ChatErrorPayload>("forge-chat-error", onError),
        onEvent<ChatToolCallPayload>("forge-chat-tool-call", onToolCall),
        onEvent<ChatToolResultPayload>("forge-chat-tool-result", onToolResult),
      ]);

      // Mode-aware dispatch. Agent mode runs the tool-use loop;
      // plain chat just streams text. Cancel works for both via
      // the shared CHAT_CANCEL handle on the Rust side.
      if (useAgentTools) {
        await cmd.forgeAgentRun(apiMessages);
      } else {
        await cmd.forgeChatStream(apiMessages);
      }
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
          {sending ? (
            <button
              type="button"
              className="ghost danger"
              onClick={async () => {
                try {
                  await cmd.forgeChatCancel();
                  // The Rust side fires a done event with whatever
                  // text it has so far — our existing onDone handler
                  // settles the bubble. No extra UI work needed
                  // here.
                } catch (e) {
                  console.warn("cancel failed:", e);
                }
              }}
              title="Stop the current generation. Whatever's already streamed stays in the transcript."
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              className="primary"
              disabled={!draft.trim()}
              onClick={send}
            >
              Send
            </button>
          )}
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
  const tools = message.toolCalls ?? [];
  const hasContent = message.content.trim().length > 0;

  return (
    <div className={`forge-msg ${isUser ? "user" : "assistant"}`}>
      <div className="forge-msg-role">{isUser ? "you" : "claude"}</div>
      {/* Tool calls render above the text so the user sees the
       *  agent's actions in the order they happened. Each renders
       *  as a small activity card with status pill. */}
      {tools.length > 0 && (
        <div className="forge-msg-tools">
          {tools.map((t) => (
            <ToolCallCard key={t.tool_use_id} call={t} />
          ))}
        </div>
      )}
      <div className="forge-msg-content">
        {streaming && !hasContent ? (
          <div className="muted">
            {tools.length > 0 ? "working…" : "thinking…"}
          </div>
        ) : hasContent ? (
          renderContent(message.content, blocks, onInsertCode)
        ) : null}
      </div>
      {message.usage && (
        <div className="forge-msg-meta mono">
          {message.usage.in} in · {message.usage.out} out
        </div>
      )}
    </div>
  );
}

function ToolCallCard({ call }: { call: UiToolCall }) {
  const friendlyName = TOOL_LABELS[call.name] ?? call.name;
  const icon =
    call.status === "running" ? "○" : call.status === "success" ? "✓" : "✗";
  return (
    <div className={`forge-tool-card status-${call.status}`}>
      <div className="forge-tool-card-head">
        <span className="forge-tool-icon">{icon}</span>
        <span className="forge-tool-name">{friendlyName}</span>
        {call.input_summary && (
          <span className="forge-tool-input mono" title={call.input_summary}>
            {call.input_summary}
          </span>
        )}
      </div>
      {call.result_summary && (
        <div className="forge-tool-result mono">{call.result_summary}</div>
      )}
    </div>
  );
}

/**
 * Human-readable labels for each tool. Keep in sync with the Rust
 * agent_tool_catalog() — adding a tool there means adding its
 * label here.
 */
const TOOL_LABELS: Record<string, string> = {
  list_strategies: "List strategies",
  read_strategy: "Read",
  write_strategy: "Write",
  list_templates: "List templates",
  run_backtest: "Run backtest",
  list_dashboards: "List dashboards",
  read_dashboard: "Read dashboard",
  save_dashboard: "Save dashboard",
  delete_dashboard: "Delete dashboard",
  open_dashboard: "Open dashboard",
  get_account_summary: "Account summary",
  get_open_positions: "Open positions",
  get_quote: "Quote",
  get_options_chain: "Options chain",
  get_market_data_status: "Data tier",
  get_historical_bars: "Historical bars",
  list_deployments: "List deployments",
  deploy_strategy: "Deploy",
};

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
