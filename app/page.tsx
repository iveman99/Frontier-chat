"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";

/* ---------- Model list (from AgentRouter) ---------- */
const MODELS = [
  { id: "claude-opus-4-8", label: "Claude Opus 4.8", short: "Opus 4.8", vision: true, tag: "Anthropic" },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7", short: "Opus 4.7", vision: true, tag: "Anthropic" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6", short: "Opus 4.6", vision: true, tag: "Anthropic" },
  { id: "gpt-5.5", label: "GPT-5.5", short: "GPT-5.5", vision: false, tag: "OpenAI" },
  { id: "glm-5.2", label: "GLM-5.2", short: "GLM-5.2", vision: false, tag: "Zhipu AI" },
];

const BUILD_DATE = "July 2026";

/* ---------- Types ---------- */
type ImagePart = { type: "image"; media_type: string; data: string };
type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  model?: string; // which model produced an assistant reply
  images?: ImagePart[]; // only on user messages
};

const LS_KEY = "iveman.apiKey";
const LS_MODEL = "iveman.model";
const LS_SYSTEM = "iveman.system";
const LS_HISTORY = "iveman.history";
const LS_NAME = "iveman.userName";

export default function Page() {
  const [apiKey, setApiKey] = useState("");
  const [userName, setUserName] = useState("");
  const [model, setModel] = useState(MODELS[0].id);
  const [system, setSystem] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [pendingImages, setPendingImages] = useState<ImagePart[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showOnboard, setShowOnboard] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const activeModel = MODELS.find((m) => m.id === model) ?? MODELS[0];

  /* ---------- Load saved state ---------- */
  useEffect(() => {
    try {
      const k = localStorage.getItem(LS_KEY);
      const n = localStorage.getItem(LS_NAME);
      const m = localStorage.getItem(LS_MODEL);
      const s = localStorage.getItem(LS_SYSTEM);
      const h = localStorage.getItem(LS_HISTORY);
      if (k) setApiKey(k);
      if (n) setUserName(n);
      if (m && MODELS.some((x) => x.id === m)) setModel(m);
      if (s) setSystem(s);
      if (h) setMessages(JSON.parse(h));
      // New session / new user → onboard if we don't know who they are or have no key.
      if (!n || !k) setShowOnboard(true);
    } catch {
      /* ignore */
    }
    setLoaded(true);
  }, []);

  /* ---------- Persist ---------- */
  useEffect(() => {
    if (loaded) localStorage.setItem(LS_MODEL, model);
  }, [model, loaded]);

  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(LS_HISTORY, JSON.stringify(messages.slice(-100)));
    } catch {
      /* quota — ignore */
    }
  }, [messages, loaded]);

  /* ---------- Auto-scroll ---------- */
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  /* ---------- Image handling ---------- */
  const onPickFiles = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    files.forEach((file) => {
      if (!file.type.startsWith("image/")) return;
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || "");
        const comma = result.indexOf(",");
        if (comma === -1) return;
        setPendingImages((prev) => [
          ...prev,
          { type: "image", media_type: file.type, data: result.slice(comma + 1) },
        ]);
      };
      reader.readAsDataURL(file);
    });
    e.target.value = "";
  }, []);

  const removeImage = (idx: number) =>
    setPendingImages((prev) => prev.filter((_, i) => i !== idx));

  /* ---------- Build Anthropic-format messages ---------- */
  function buildApiMessages(history: ChatMessage[]) {
    return history.map((m) => {
      if (m.role === "assistant" || !m.images?.length) {
        return { role: m.role, content: m.text };
      }
      const content: unknown[] = m.images.map((img) => ({
        type: "image",
        source: { type: "base64", media_type: img.media_type, data: img.data },
      }));
      if (m.text.trim()) content.push({ type: "text", text: m.text });
      return { role: m.role, content };
    });
  }

  /* ---------- Send ---------- */
  const send = useCallback(async () => {
    if (streaming) return;
    const text = input.trim();
    if (!text && pendingImages.length === 0) return;

    if (!apiKey) {
      setShowOnboard(true);
      setError("Add your AgentRouter API key first.");
      return;
    }

    setError("");
    const userMsg: ChatMessage = {
      role: "user",
      text,
      images: pendingImages.length ? pendingImages : undefined,
    };
    const history = [...messages, userMsg];
    setMessages([...history, { role: "assistant", text: "", model: activeModel.id }]);
    setInput("");
    setPendingImages([]);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          apiKey,
          model,
          system,
          messages: buildApiMessages(history),
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        let msg = `Request failed (${res.status}).`;
        try {
          const data = await res.json();
          if (data?.error)
            msg = typeof data.error === "string" ? data.error : JSON.stringify(data.error);
        } catch {
          /* ignore */
        }
        throw new Error(msg);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let acc = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const dataStr = trimmed.slice(5).trim();
          if (!dataStr || dataStr === "[DONE]") continue;
          try {
            const evt = JSON.parse(dataStr);
            const chunk = extractDelta(evt);
            if (chunk) {
              acc += chunk;
              updateLastAssistant(acc);
            } else if (evt.type === "error" || evt.error) {
              throw new Error(evt.error?.message || "Stream error.");
            }
          } catch (e) {
            if (e instanceof Error && e.message === "Stream error.") throw e;
            // otherwise ignore keep-alive / partial-JSON noise
          }
        }
      }

      if (!acc) {
        updateLastAssistant("");
        setError("The model returned an empty response. Try again.");
      }
    } catch (err) {
      const aborted = err instanceof DOMException && err.name === "AbortError";
      if (!aborted) {
        const msg = err instanceof Error ? err.message : "Something went wrong.";
        setError(cleanError(msg));
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === "assistant" && last.text === "") {
            return prev.slice(0, -1);
          }
          return prev;
        });
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [apiKey, model, system, input, pendingImages, messages, streaming, activeModel.id]);

  function updateLastAssistant(text: string) {
    setMessages((prev) => {
      const copy = [...prev];
      const last = copy[copy.length - 1];
      if (last && last.role === "assistant") {
        copy[copy.length - 1] = { ...last, text };
      }
      return copy;
    });
  }

  const stop = () => {
    abortRef.current?.abort();
    setStreaming(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const clearChat = () => {
    if (streaming) stop();
    setMessages([]);
    setError("");
    localStorage.removeItem(LS_HISTORY);
  };

  const saveSettings = (key: string, sys: string, name: string) => {
    const nm = name.trim();
    setApiKey(key);
    setSystem(sys);
    setUserName(nm);
    localStorage.setItem(LS_KEY, key);
    localStorage.setItem(LS_SYSTEM, sys);
    if (nm) localStorage.setItem(LS_NAME, nm);
    setShowSettings(false);
    setShowOnboard(false);
    setError("");
  };

  const initials = useMemo(() => initialsOf(userName), [userName]);

  return (
    <div className="app">
      {/* Ambient background glow */}
      <div className="bg-orbs" aria-hidden>
        <span className="orb orb-1" />
        <span className="orb orb-2" />
        <span className="orb orb-3" />
      </div>

      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">iV</span>
          <span className="brand-text">
            iveman<span className="dot">·</span>UI
          </span>
        </div>

        <div className="model-wrap">
          <select
            className="model-select"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            title="Choose a model"
          >
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
                {m.vision ? "  ·  🖼 vision" : ""}
              </option>
            ))}
          </select>
        </div>

        <div className="spacer" />

        {messages.length > 0 && (
          <button className="icon-btn subtle" onClick={clearChat} title="Clear chat">
            <span className="label">Clear</span>
          </button>
        )}

        {userName && (
          <button
            className="user-chip"
            onClick={() => setShowSettings(true)}
            title="Your profile & settings"
          >
            <span className="avatar sm">{initials}</span>
            <span className="user-name">{userName}</span>
          </button>
        )}

        <button className="icon-btn" onClick={() => setShowSettings(true)} title="Settings">
          <span className="gear">⚙</span>
          <span className="label">Settings</span>
        </button>
      </header>

      <div className="messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="empty">
            <div className="empty-badge">iV</div>
            <h2>
              {userName ? (
                <>
                  Welcome, <span className="grad-text">{userName}</span>
                </>
              ) : (
                <>Chat with frontier models</>
              )}
            </h2>
            <p>Pick a model above, type a message, and press Enter.</p>
            <div className="chips">
              {MODELS.map((m) => (
                <button
                  key={m.id}
                  className={`chip ${m.id === model ? "active" : ""}`}
                  onClick={() => setModel(m.id)}
                >
                  {m.short}
                </button>
              ))}
            </div>
            <p className="muted small">
              Your API key stays in your browser only. Models with 🖼 accept images.
            </p>
          </div>
        )}

        {messages.map((m, i) => {
          const mdl = MODELS.find((x) => x.id === m.model);
          const isStreamingLast =
            streaming && i === messages.length - 1 && m.role === "assistant";
          return (
            <div key={i} className={`msg ${m.role}`}>
              <div className="msg-head">
                {m.role === "assistant" ? (
                  <span className="avatar ai">iV</span>
                ) : (
                  <span className="avatar you">{initials}</span>
                )}
                <span className="msg-name">
                  {m.role === "user" ? userName || "You" : mdl?.label || "Assistant"}
                </span>
              </div>
              <div className="bubble">
                {m.images?.map((img, j) => (
                  <img
                    key={j}
                    src={`data:${img.media_type};base64,${img.data}`}
                    alt="attachment"
                  />
                ))}
                {m.text}
                {isStreamingLast && !m.text && <TypingDots />}
                {isStreamingLast && m.text && <span className="cursor" />}
              </div>
            </div>
          );
        })}

        {error && <div className="error-banner">{error}</div>}
      </div>

      <div className="composer">
        {pendingImages.length > 0 && (
          <div className="attachments">
            {pendingImages.map((img, i) => (
              <div className="thumb" key={i}>
                <img src={`data:${img.media_type};base64,${img.data}`} alt="pending" />
                <button onClick={() => removeImage(i)} title="Remove">
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="input-row">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={onPickFiles}
          />
          <button
            className="attach-btn"
            onClick={() => fileRef.current?.click()}
            title={activeModel.vision ? "Attach image" : "This model may not support images"}
          >
            +
          </button>
          <textarea
            className="prompt"
            placeholder={`Message ${activeModel.label}…`}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = Math.min(e.target.scrollHeight, 200) + "px";
            }}
            onKeyDown={onKeyDown}
            rows={1}
          />
          {streaming ? (
            <button className="send-btn stop" onClick={stop} title="Stop">
              ■
            </button>
          ) : (
            <button
              className="send-btn"
              onClick={send}
              disabled={!input.trim() && pendingImages.length === 0}
              title="Send"
            >
              ↑
            </button>
          )}
        </div>
        <div className="foot">
          <span>Enter to send · Shift+Enter for new line</span>
          <span className="foot-brand">
            Designed & built for <b>iVeman</b> · {BUILD_DATE}
          </span>
        </div>
      </div>

      {(showOnboard || showSettings) && (
        <SettingsModal
          mode={showOnboard ? "onboard" : "settings"}
          initialKey={apiKey}
          initialSystem={system}
          initialName={userName}
          onSave={saveSettings}
          onClose={() => {
            setShowSettings(false);
            if (apiKey && userName) setShowOnboard(false);
          }}
          canClose={!!apiKey && !!userName}
        />
      )}
    </div>
  );
}

/* ---------- Typing indicator ---------- */
function TypingDots() {
  return (
    <span className="typing">
      <span />
      <span />
      <span />
    </span>
  );
}

/* ---------- Settings / Onboarding Modal ---------- */
function SettingsModal({
  mode,
  initialKey,
  initialSystem,
  initialName,
  onSave,
  onClose,
  canClose,
}: {
  mode: "onboard" | "settings";
  initialKey: string;
  initialSystem: string;
  initialName: string;
  onSave: (key: string, system: string, name: string) => void;
  onClose: () => void;
  canClose: boolean;
}) {
  const [key, setKey] = useState(initialKey);
  const [sys, setSys] = useState(initialSystem);
  const [name, setName] = useState(initialName);
  const onboard = mode === "onboard";

  return (
    <div className="overlay" onClick={canClose ? onClose : undefined}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-mark">iV</div>
        <h2>{onboard ? "Welcome to iveman·UI" : "Your profile & settings"}</h2>
        <p>
          {onboard
            ? "Tell us your name and paste your AgentRouter key to start. Everything stays in your browser."
            : "Your key is stored only in this browser and sent straight to the model."}
        </p>

        <div className="field">
          <label>Your name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Aarav"
            autoFocus={onboard}
            maxLength={40}
          />
          <small>Shown on your messages so friends know who's who.</small>
        </div>

        <div className="field">
          <label>AgentRouter API Key</label>
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="sk-..."
          />
          <small>
            Get one at{" "}
            <a href="https://agentrouter.org" target="_blank" rel="noreferrer">
              agentrouter.org
            </a>
            . It never leaves your device except to call the model.
          </small>
        </div>

        <div className="field">
          <label>System prompt (optional)</label>
          <textarea
            value={sys}
            onChange={(e) => setSys(e.target.value)}
            placeholder="e.g. You are a concise, helpful assistant."
          />
        </div>

        <div className="modal-actions">
          {canClose && (
            <button className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
          )}
          <button
            className="btn-primary"
            onClick={() => onSave(key.trim(), sys, name)}
            disabled={!key.trim() || !name.trim()}
          >
            {onboard ? "Start chatting →" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Helpers ---------- */

// Handle BOTH Anthropic and OpenAI streaming shapes.
function extractDelta(evt: any): string {
  // Anthropic: { type: "content_block_delta", delta: { type:"text_delta", text } }
  if (
    evt?.type === "content_block_delta" &&
    evt.delta?.type === "text_delta" &&
    typeof evt.delta.text === "string"
  ) {
    return evt.delta.text;
  }
  // Anthropic (some proxies): { type:"message_delta", delta:{ text } }
  if (typeof evt?.delta?.text === "string" && evt.type !== "content_block_delta") {
    return evt.delta.text;
  }
  // OpenAI chat completions: { choices:[{ delta:{ content } }] }
  const choice = evt?.choices?.[0];
  if (choice) {
    if (typeof choice.delta?.content === "string") return choice.delta.content;
    if (typeof choice.text === "string") return choice.text; // legacy completions
    if (typeof choice.message?.content === "string") return choice.message.content;
  }
  return "";
}

function initialsOf(name: string): string {
  const n = name.trim();
  if (!n) return "?";
  const parts = n.split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function cleanError(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.error?.message) return parsed.error.message;
    if (typeof parsed?.error === "string") return parsed.error;
    if (parsed?.message) return parsed.message;
  } catch {
    /* not JSON */
  }
  if (raw.includes("401") || raw.toLowerCase().includes("authentication")) {
    return "Invalid API key. Check it in Settings.";
  }
  return raw.length > 300 ? raw.slice(0, 300) + "…" : raw;
}
