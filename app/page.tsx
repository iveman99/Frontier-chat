"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";

/* ---------- Model list (from AgentRouter) ---------- */
const MODELS = [
  { id: "claude-opus-4-8", label: "Claude Opus 4.8", vision: true },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7", vision: true },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6", vision: true },
  { id: "gpt-5.5", label: "GPT-5.5", vision: false },
  { id: "glm-5.2", label: "GLM-5.2", vision: false },
];

/* ---------- Types ---------- */
type ImagePart = { type: "image"; media_type: string; data: string };
type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  images?: ImagePart[]; // only on user messages
};

const LS_KEY = "iveman.apiKey";
const LS_MODEL = "iveman.model";
const LS_SYSTEM = "iveman.system";
const LS_HISTORY = "iveman.history";

export default function Page() {
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(MODELS[0].id);
  const [system, setSystem] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [pendingImages, setPendingImages] = useState<ImagePart[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const activeModel = MODELS.find((m) => m.id === model) ?? MODELS[0];

  /* ---------- Load saved state ---------- */
  useEffect(() => {
    try {
      const k = localStorage.getItem(LS_KEY);
      const m = localStorage.getItem(LS_MODEL);
      const s = localStorage.getItem(LS_SYSTEM);
      const h = localStorage.getItem(LS_HISTORY);
      if (k) setApiKey(k);
      if (m && MODELS.some((x) => x.id === m)) setModel(m);
      if (s) setSystem(s);
      if (h) setMessages(JSON.parse(h));
      if (!k) setShowSettings(true); // first visit → prompt for key
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
    e.target.value = ""; // allow re-selecting same file
  }, []);

  const removeImage = (idx: number) =>
    setPendingImages((prev) => prev.filter((_, i) => i !== idx));

  /* ---------- Build Anthropic-format messages ---------- */
  function buildApiMessages(history: ChatMessage[]) {
    return history.map((m) => {
      if (m.role === "assistant" || !m.images?.length) {
        return { role: m.role, content: m.text };
      }
      // user message with images → content blocks
      const content: unknown[] = m.images.map((img) => ({
        type: "image",
        source: {
          type: "base64",
          media_type: img.media_type,
          data: img.data,
        },
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
      setShowSettings(true);
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
    setMessages([...history, { role: "assistant", text: "" }]);
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
          if (data?.error) msg = typeof data.error === "string" ? data.error : JSON.stringify(data.error);
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

        // Parse SSE lines
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const dataStr = trimmed.slice(5).trim();
          if (!dataStr || dataStr === "[DONE]") continue;
          try {
            const evt = JSON.parse(dataStr);
            // Anthropic streaming events
            if (
              evt.type === "content_block_delta" &&
              evt.delta?.type === "text_delta" &&
              typeof evt.delta.text === "string"
            ) {
              acc += evt.delta.text;
              updateLastAssistant(acc);
            } else if (evt.type === "error") {
              throw new Error(evt.error?.message || "Stream error.");
            }
          } catch (e) {
            // ignore keep-alive / non-JSON lines; rethrow real errors
            if (e instanceof Error && e.message !== "Unexpected end of JSON input") {
              // swallow parse noise, surface nothing
            }
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
        // remove the empty assistant placeholder on hard failure
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
  }, [apiKey, model, system, input, pendingImages, messages, streaming]);

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

  /* ---------- Settings save ---------- */
  const saveSettings = (key: string, sys: string) => {
    setApiKey(key);
    setSystem(sys);
    localStorage.setItem(LS_KEY, key);
    localStorage.setItem(LS_SYSTEM, sys);
    setShowSettings(false);
    setError("");
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          iveman<span>·</span>UI
        </div>
        <select
          className="model-select"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          title="Choose a model"
        >
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
              {m.vision ? "  🖼" : ""}
            </option>
          ))}
        </select>
        <span className={`key-badge ${apiKey ? "" : "missing"}`}>
          {apiKey ? "key set" : "no key"}
        </span>
        <div className="spacer" />
        {messages.length > 0 && (
          <button className="icon-btn subtle" onClick={clearChat} title="Clear chat">
            🗑 <span className="label">Clear</span>
          </button>
        )}
        <button className="icon-btn" onClick={() => setShowSettings(true)}>
          ⚙ <span className="label">Settings</span>
        </button>
      </header>

      <div className="messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="empty">
            <h2>Chat with frontier models</h2>
            <p>Pick a model above, type a message, and press Enter.</p>
            <p>
              Your API key stays in your browser only. Models marked 🖼 accept
              image uploads.
            </p>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <div className="role">{m.role === "user" ? "You" : activeModel.label}</div>
            <div className="bubble">
              {m.images?.map((img, j) => (
                <img
                  key={j}
                  src={`data:${img.media_type};base64,${img.data}`}
                  alt="attachment"
                />
              ))}
              {m.text}
              {streaming &&
                i === messages.length - 1 &&
                m.role === "assistant" && <span className="cursor" />}
            </div>
          </div>
        ))}

        {error && <div className="error-banner">{error}</div>}
      </div>

      <div className="composer">
        {pendingImages.length > 0 && (
          <div className="attachments">
            {pendingImages.map((img, i) => (
              <div className="thumb" key={i}>
                <img
                  src={`data:${img.media_type};base64,${img.data}`}
                  alt="pending"
                />
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
            title={
              activeModel.vision
                ? "Attach image"
                : "This model may not support images"
            }
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
            <button className="send-btn" onClick={stop} title="Stop">
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
        <div className="hint">
          Enter to send · Shift+Enter for new line
        </div>
      </div>

      {showSettings && (
        <SettingsModal
          initialKey={apiKey}
          initialSystem={system}
          onSave={saveSettings}
          onClose={() => setShowSettings(false)}
          canClose={!!apiKey}
        />
      )}
    </div>
  );
}

/* ---------- Settings Modal ---------- */
function SettingsModal({
  initialKey,
  initialSystem,
  onSave,
  onClose,
  canClose,
}: {
  initialKey: string;
  initialSystem: string;
  onSave: (key: string, system: string) => void;
  onClose: () => void;
  canClose: boolean;
}) {
  const [key, setKey] = useState(initialKey);
  const [sys, setSys] = useState(initialSystem);

  return (
    <div className="overlay" onClick={canClose ? onClose : undefined}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>
        <p>Your key is stored only in this browser and sent directly to the model.</p>

        <div className="field">
          <label>AgentRouter API Key</label>
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="sk-..."
            autoFocus
          />
          <small>
            Get a key at{" "}
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
            placeholder="e.g. You are a helpful assistant that answers concisely."
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
            onClick={() => onSave(key.trim(), sys)}
            disabled={!key.trim()}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Helpers ---------- */
function cleanError(raw: string): string {
  // Try to extract a human message from a JSON error body.
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
