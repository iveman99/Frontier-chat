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
  { id: "claude-opus-4-8", label: "Claude Opus 4.8", short: "Opus 4.8", vision: true, tag: "Anthropic", blurb: "Best for coding, research & long documents", strengths: ["Coding", "Research", "Vision", "Long context"] },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7", short: "Opus 4.7", vision: true, tag: "Anthropic", blurb: "Balanced reasoning with vision support", strengths: ["Coding", "Reasoning", "Vision"] },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6", short: "Opus 4.6", vision: true, tag: "Anthropic", blurb: "Reliable all-rounder with vision", strengths: ["Writing", "Analysis", "Vision"] },
  { id: "gpt-5.5", label: "GPT-5.5", short: "GPT-5.5", vision: false, tag: "OpenAI", blurb: "Fast, creative & strong general reasoning", strengths: ["Creative", "Reasoning", "Fast"] },
  { id: "glm-5.2", label: "GLM-5.2", short: "GLM-5.2", vision: false, tag: "Zhipu AI", blurb: "Efficient multilingual generalist", strengths: ["Multilingual", "General", "Fast"] },
];

const SUGGESTED_PROMPTS = [
  { icon: "✨", label: "Explain RAG simply", text: "Explain Retrieval-Augmented Generation (RAG) simply, with an analogy." },
  { icon: "⚡", label: "Write SQL", text: "Write a SQL query to find the top 5 customers by total order value." },
  { icon: "⚛️", label: "Generate a React component", text: "Generate a clean, accessible React button component with variants." },
  { icon: "🐍", label: "Debug Python", text: "Help me debug a Python function — I'll paste it. Ask me for the code and the error." },
];

const APP_VERSION = "v1.2";
const LINKS = {
  portfolio: "https://iveman99.github.io/iveman/",
  linkedin: "https://www.linkedin.com/in/veman-chippa",
  github: "https://github.com/iVeman99",
};

// The proxy Worker URL. Set NEXT_PUBLIC_PROXY_URL in Vercel to your deployed
// Cloudflare Worker. Users can also override it in Settings. The browser calls
// this Worker, which injects the Claude-CLI User-Agent and forwards to
// AgentRouter from a non-WAF-blocked IP (a direct browser call can't do either).
const ENV_PROXY = (process.env.NEXT_PUBLIC_PROXY_URL || "").trim();

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
const LS_PROXY = "iveman.proxyUrl";

export default function Page() {
  const [apiKey, setApiKey] = useState("");
  const [userName, setUserName] = useState("");
  const [proxyUrl, setProxyUrl] = useState(ENV_PROXY);
  const [model, setModel] = useState(MODELS[0].id);
  const [system, setSystem] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [pendingImages, setPendingImages] = useState<ImagePart[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showOnboard, setShowOnboard] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [toast, setToast] = useState("");
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
      const px = localStorage.getItem(LS_PROXY);
      if (k) setApiKey(k);
      if (n) setUserName(n);
      if (m && MODELS.some((x) => x.id === m)) setModel(m);
      if (s) setSystem(s);
      if (px) setProxyUrl(px); // saved override beats env default
      // Each new session starts with a fresh, empty chat — we intentionally do
      // NOT restore old messages. Clear any leftover history from before.
      localStorage.removeItem(LS_HISTORY);
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
      // Send through the proxy Worker.
      //
      // AgentRouter blocks browsers directly: it requires a CLI User-Agent
      // (browsers can't set that) and its WAF blocks datacenter IPs. The
      // Cloudflare Worker at proxyUrl injects the Claude-CLI User-Agent and
      // forwards from a non-blocked edge IP, with CORS so the browser can call
      // it. The user's key goes in the Authorization header, straight through.
      const target = (proxyUrl || "").trim();
      if (!target) {
        throw new Error(
          "No proxy URL configured. Open Settings and paste your Cloudflare Worker URL (see the README to create one in ~2 minutes)."
        );
      }

      const payload: Record<string, unknown> = {
        model,
        max_tokens: 4096,
        messages: buildApiMessages(history),
        stream: false,
      };
      if (system.trim()) payload.system = system;

      const res = await fetch(target, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const rawText = await res.text();
      let data: any = null;
      try {
        data = JSON.parse(rawText);
      } catch {
        /* non-JSON handled below */
      }

      if (!res.ok) {
        const msg =
          (data && (typeof data.error === "string" ? data.error : data?.error?.message)) ||
          extractHttpError(rawText, res.status);
        throw new Error(msg);
      }

      if (!data) {
        throw new Error(
          `Unexpected reply from AgentRouter: ${rawText.slice(0, 300)}`
        );
      }
      if (data?.error) {
        throw new Error(
          typeof data.error === "string"
            ? data.error
            : data.error?.message || JSON.stringify(data.error)
        );
      }

      const full = extractText(data);
      if (!full) {
        throw new Error(
          `Model replied but no text was found. Raw: ${rawText.slice(0, 300)}`
        );
      }

      // Typewriter reveal so it still feels live.
      const total = full.length;
      const step = Math.max(2, Math.round(total / 240)); // ~240 frames max
      let shown = 0;
      while (shown < total) {
        if (controller.signal.aborted) {
          updateLastAssistant(full);
          break;
        }
        shown = Math.min(total, shown + step);
        updateLastAssistant(full.slice(0, shown));
        await sleep(12);
      }
      updateLastAssistant(full);
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

  const saveSettings = (key: string, sys: string, name: string, proxy: string) => {
    const nm = name.trim();
    const px = proxy.trim();
    const wasOnboard = showOnboard;
    setApiKey(key);
    setSystem(sys);
    setUserName(nm);
    setProxyUrl(px);
    localStorage.setItem(LS_KEY, key);
    localStorage.setItem(LS_SYSTEM, sys);
    if (nm) localStorage.setItem(LS_NAME, nm);
    if (px) localStorage.setItem(LS_PROXY, px);
    else localStorage.removeItem(LS_PROXY);
    setShowSettings(false);
    setShowOnboard(false);
    setError("");
    showToast(wasOnboard ? `Welcome, ${nm}! You're all set.` : "Settings saved");
  };

  const showToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(""), 2600);
  };

  const initials = useMemo(() => initialsOf(userName), [userName]);

  return (
    <div className="app">
      {/* Ambient background */}
      <div className="bg-grid" aria-hidden />
      <div className="bg-glow" aria-hidden />

      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">◉</span>
          <span className="brand-block">
            <span className="brand-text">Frontier Hub</span>
            <span className="brand-sub">by iVeman</span>
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
                {m.label} · {m.tag}
                {m.vision ? " · 🖼" : ""}
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

        <button className="icon-btn" onClick={() => setShowSetup(true)} title="Use in Claude Code / Desktop">
          <span className="gear">⌘</span>
          <span className="label">Setup</span>
        </button>

        <button className="icon-btn" onClick={() => setShowSettings(true)} title="Settings">
          <span className="gear">⚙</span>
          <span className="label">Settings</span>
        </button>
      </header>

      <div className="messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="hero">
            <div className="hero-badge">◉</div>
            <h1 className="hero-title">
              {userName ? (
                <>
                  Welcome back, <span className="accent">{userName}</span>
                </>
              ) : (
                <>
                  Access the world&apos;s best <span className="accent">AI models</span>
                </>
              )}
            </h1>
            <p className="hero-sub">
              One interface. Bring your own key. Switch frontier models instantly.
            </p>

            <div className="model-badges">
              {MODELS.map((m) => (
                <button
                  key={m.id}
                  className={`model-badge ${m.id === model ? "active" : ""}`}
                  onClick={() => setModel(m.id)}
                  title={m.blurb}
                >
                  <span className="mb-name">{m.short}</span>
                  <span className="mb-tag">{m.tag}</span>
                </button>
              ))}
            </div>

            <div className="active-card">
              <div className="ac-head">
                <span className="ac-name">{activeModel.label}</span>
                <span className="ac-provider">{activeModel.tag}</span>
              </div>
              <p className="ac-blurb">{activeModel.blurb}</p>
              <div className="ac-strengths">
                {activeModel.strengths.map((s) => (
                  <span className="ac-chip" key={s}>
                    {s}
                  </span>
                ))}
                {activeModel.vision && <span className="ac-chip vision">🖼 Vision</span>}
              </div>
            </div>

            <div className="suggest-label">Try a prompt</div>
            <div className="suggestions">
              {SUGGESTED_PROMPTS.map((p) => (
                <button
                  key={p.label}
                  className="suggestion"
                  onClick={() => setInput(p.text)}
                >
                  <span className="sg-icon">{p.icon}</span>
                  <span className="sg-label">{p.label}</span>
                </button>
              ))}
            </div>
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
                  <span className="avatar ai">◉</span>
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
            placeholder="Ask anything…"
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
          <span className="foot-hint">
            Enter to send · Shift+Enter for new line
          </span>
          <span className="foot-brand">
            <span>
              Made with <span className="heart">♥</span> by <b>iVeman</b>
            </span>
            <a href={LINKS.portfolio} target="_blank" rel="noreferrer">
              Portfolio
            </a>
            <a href={LINKS.linkedin} target="_blank" rel="noreferrer">
              LinkedIn
            </a>
            <a href={LINKS.github} target="_blank" rel="noreferrer">
              GitHub
            </a>
            <span className="foot-ver">{APP_VERSION}</span>
          </span>
        </div>
      </div>

      {toast && (
        <div className="toast">
          <span className="toast-check">✓</span>
          {toast}
        </div>
      )}

      {(showOnboard || showSettings) && (
        <SettingsModal
          mode={showOnboard ? "onboard" : "settings"}
          initialKey={apiKey}
          initialSystem={system}
          initialName={userName}
          initialProxy={proxyUrl}
          proxyFromEnv={!!ENV_PROXY}
          onSave={saveSettings}
          onClose={() => {
            setShowSettings(false);
            if (apiKey && userName) setShowOnboard(false);
          }}
          canClose={!!apiKey && !!userName}
        />
      )}

      {showSetup && <SetupModal onClose={() => setShowSetup(false)} onCopy={showToast} />}
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
  initialProxy,
  proxyFromEnv,
  onSave,
  onClose,
  canClose,
}: {
  mode: "onboard" | "settings";
  initialKey: string;
  initialSystem: string;
  initialName: string;
  initialProxy: string;
  proxyFromEnv: boolean;
  onSave: (key: string, system: string, name: string, proxy: string) => void;
  onClose: () => void;
  canClose: boolean;
}) {
  const [key, setKey] = useState(initialKey);
  const [sys, setSys] = useState(initialSystem);
  const [name, setName] = useState(initialName);
  const [proxy, setProxy] = useState(initialProxy);
  const onboard = mode === "onboard";

  // If the owner baked in a proxy URL (env var), friends never need to see it.
  // Show the field only in Settings, or in onboarding when there's no proxy yet.
  const needsProxy = !proxyFromEnv && !initialProxy;
  const showProxyField = !onboard || needsProxy;
  const canSave = key.trim() && name.trim() && (proxyFromEnv || proxy.trim());

  return (
    <div className="overlay" onClick={canClose ? onClose : undefined}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-mark">◉</div>
        <h2>{onboard ? "Welcome to Frontier Hub" : "Settings"}</h2>
        <p>
          {onboard
            ? "Enter your name and AgentRouter key to start. Everything stays in your browser."
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
          <small>Shown on your messages so friends know who&apos;s who.</small>
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
            Get one free at{" "}
            <a href="https://agentrouter.org" target="_blank" rel="noreferrer">
              agentrouter.org
            </a>
            . It never leaves your device except to call the model.
          </small>
        </div>

        {showProxyField && (
          <div className="field">
            <label>Proxy URL {needsProxy ? "" : "(advanced)"}</label>
            <input
              type="text"
              value={proxy}
              onChange={(e) => setProxy(e.target.value)}
              placeholder="https://your-worker.workers.dev"
            />
            <small>
              Your Cloudflare Worker URL. Required to reach AgentRouter from the
              web (see the README to deploy one in ~2 minutes).
            </small>
          </div>
        )}

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
            onClick={() => onSave(key.trim(), sys, name, proxy)}
            disabled={!canSave}
          >
            {onboard ? "Start chatting →" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Setup / Configure Modal ---------- */
type SetupTab = "cli" | "desktop" | "cursor";

function SetupModal({
  onClose,
  onCopy,
}: {
  onClose: () => void;
  onCopy: (msg: string) => void;
}) {
  const [tab, setTab] = useState<SetupTab>("cli");

  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).then(
      () => onCopy("Copied to clipboard"),
      () => onCopy("Copy failed — select manually")
    );
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal setup-modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-x" onClick={onClose} title="Close">
          ×
        </button>
        <h2>Use these models in your own tools</h2>
        <p>
          Prefer working in a terminal or editor? Point any Claude-compatible
          tool at AgentRouter with your API key. Pick your tool below.
        </p>

        <div className="setup-tabs">
          <button
            className={`setup-tab ${tab === "cli" ? "active" : ""}`}
            onClick={() => setTab("cli")}
          >
            Claude Code (CLI)
          </button>
          <button
            className={`setup-tab ${tab === "desktop" ? "active" : ""}`}
            onClick={() => setTab("desktop")}
          >
            Claude Desktop
          </button>
          <button
            className={`setup-tab ${tab === "cursor" ? "active" : ""}`}
            onClick={() => setTab("cursor")}
          >
            Cursor / VS Code
          </button>
        </div>

        {tab === "cli" && (
          <div className="setup-body">
            <Step n={1} title="Install Claude Code">
              <CodeBlock
                onCopy={copy}
                code={`npm install -g @anthropic-ai/claude-code@latest`}
              />
            </Step>
            <Step n={2} title="Set your AgentRouter key & endpoint">
              <p className="setup-note">
                Get a free key at{" "}
                <a href="https://agentrouter.org" target="_blank" rel="noreferrer">
                  agentrouter.org
                </a>
                . Windows PowerShell:
              </p>
              <CodeBlock
                onCopy={copy}
                code={`$env:ANTHROPIC_AUTH_TOKEN="YOUR_AGENTROUTER_API_KEY"
$env:ANTHROPIC_BASE_URL="https://agentrouter.org"
$env:ANTHROPIC_MODEL="claude-opus-4-8"`}
              />
              <p className="setup-note">macOS / Linux:</p>
              <CodeBlock
                onCopy={copy}
                code={`export ANTHROPIC_AUTH_TOKEN="YOUR_AGENTROUTER_API_KEY"
export ANTHROPIC_BASE_URL="https://agentrouter.org"
export ANTHROPIC_MODEL="claude-opus-4-8"`}
              />
            </Step>
            <Step n={3} title="Start Claude Code">
              <CodeBlock onCopy={copy} code={`claude`} />
              <p className="setup-note">
                That&apos;s it — you&apos;re now running frontier models in your
                terminal. Swap <code>ANTHROPIC_MODEL</code> for any model below.
              </p>
            </Step>
            <ModelIds onCopy={copy} />
          </div>
        )}

        {tab === "desktop" && (
          <div className="setup-body">
            <Step n={1} title="Install Claude Desktop">
              <p className="setup-note">
                Download the desktop app from{" "}
                <a href="https://claude.ai/download" target="_blank" rel="noreferrer">
                  claude.ai/download
                </a>{" "}
                (Windows / macOS).
              </p>
            </Step>
            <Step n={2} title="Set environment variables before launching">
              <p className="setup-note">
                Claude Desktop reads the same variables. Set them, then launch the
                app from that same terminal. Windows PowerShell:
              </p>
              <CodeBlock
                onCopy={copy}
                code={`$env:ANTHROPIC_AUTH_TOKEN="YOUR_AGENTROUTER_API_KEY"
$env:ANTHROPIC_BASE_URL="https://agentrouter.org"
& "$env:LOCALAPPDATA\\Programs\\claude\\Claude.exe"`}
              />
              <p className="setup-note">macOS:</p>
              <CodeBlock
                onCopy={copy}
                code={`export ANTHROPIC_AUTH_TOKEN="YOUR_AGENTROUTER_API_KEY"
export ANTHROPIC_BASE_URL="https://agentrouter.org"
open -a Claude`}
              />
            </Step>
            <ModelIds onCopy={copy} />
          </div>
        )}

        {tab === "cursor" && (
          <div className="setup-body">
            <Step n={1} title="Open model settings">
              <p className="setup-note">
                In Cursor: <b>Settings → Models</b>. Enable{" "}
                <b>Override OpenAI/Anthropic Base URL</b> and add a custom
                Anthropic model.
              </p>
            </Step>
            <Step n={2} title="Point it at AgentRouter">
              <p className="setup-note">Base URL:</p>
              <CodeBlock onCopy={copy} code={`https://agentrouter.org`} />
              <p className="setup-note">API key: your AgentRouter key.</p>
              <CodeBlock onCopy={copy} code={`YOUR_AGENTROUTER_API_KEY`} />
            </Step>
            <Step n={3} title="Add a model id">
              <p className="setup-note">
                Add one of the model ids below as a custom model, then select it in
                the chat.
              </p>
            </Step>
            <ModelIds onCopy={copy} />
          </div>
        )}
      </div>
    </div>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="setup-step">
      <span className="setup-step-num">{n}</span>
      <div className="setup-step-body">
        <h4 className="setup-step-title">{title}</h4>
        {children}
      </div>
    </div>
  );
}

function CodeBlock({
  code,
  onCopy,
}: {
  code: string;
  onCopy: (text: string) => void;
}) {
  return (
    <div className="code-block">
      <pre>
        <code>{code}</code>
      </pre>
      <button className="code-copy" onClick={() => onCopy(code)} title="Copy">
        Copy
      </button>
    </div>
  );
}

function ModelIds({ onCopy }: { onCopy: (text: string) => void }) {
  return (
    <div className="setup-models">
      <div className="setup-models-title">Available model ids</div>
      <div className="setup-model-list">
        {MODELS.map((m) => (
          <button
            key={m.id}
            className="setup-model-id"
            onClick={() => onCopy(m.id)}
            title="Copy model id"
          >
            <span className="smi-label">{m.label}</span>
            <code>{m.id}</code>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------- Helpers ---------- */

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Pull assistant text out of a complete (non-streaming) response body,
// handling both Anthropic and OpenAI shapes.
function extractText(data: any): string {
  // Anthropic messages: { content: [{ type:"text", text }] }
  if (Array.isArray(data?.content)) {
    const t = data.content
      .filter((b: any) => b?.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("");
    if (t) return t;
  }
  // OpenAI chat completions: { choices:[{ message:{ content } }] }
  const choice = data?.choices?.[0];
  if (choice) {
    if (typeof choice.message?.content === "string") return choice.message.content;
    if (typeof choice.text === "string") return choice.text;
    if (Array.isArray(choice.message?.content)) {
      const t = choice.message.content
        .map((p: any) => (typeof p === "string" ? p : p?.text || ""))
        .join("");
      if (t) return t;
    }
  }
  if (typeof data?.content === "string") return data.content;
  if (typeof data?.text === "string") return data.text;
  return "";
}

// Build a readable error when the body isn't the JSON we expect (e.g. a WAF
// HTML page).
function extractHttpError(raw: string, status: number): string {
  const t = raw.trim();
  if (/aliyun_waf|<!doctype|<html/i.test(t)) {
    return "AgentRouter blocked this request (firewall). Try again, or check that your network isn't on a blocklist.";
  }
  return t ? `${status}: ${t.slice(0, 200)}` : `Request failed (${status}).`;
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
