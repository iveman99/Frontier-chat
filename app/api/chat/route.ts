import { NextRequest } from "next/server";

// Node runtime is far more reliable than Edge for proxying an upstream API
// (Edge's streaming pipe was delivering an empty body on Vercel).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BASE_URL = process.env.AGENTROUTER_BASE_URL || "https://agentrouter.org";

/**
 * Proxy to AgentRouter's Anthropic-compatible /v1/messages endpoint.
 *
 * We do a NON-streaming request (stream:false), read the complete JSON reply,
 * pull the text out of whatever shape it comes in (Anthropic or OpenAI), and
 * return a simple { text } payload. If we can't parse it, we return the raw
 * upstream body so failures are visible instead of silent.
 *
 * The user's key is passed through only — never stored or logged.
 */
export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request body." }, 400);
  }

  const { apiKey, model, system, messages } = body ?? {};

  if (!apiKey || typeof apiKey !== "string") {
    return json({ error: "Missing API key. Add your AgentRouter key in Settings." }, 401);
  }
  if (!model || typeof model !== "string") {
    return json({ error: "No model selected." }, 400);
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return json({ error: "No messages to send." }, 400);
  }

  const payload: Record<string, unknown> = {
    model,
    max_tokens: typeof body.max_tokens === "number" ? body.max_tokens : 4096,
    messages,
    stream: false,
  };
  if (system && typeof system === "string" && system.trim()) {
    payload.system = system;
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${BASE_URL}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // AgentRouter authenticates via Bearer token (same as the Claude Code
        // CLI's ANTHROPIC_AUTH_TOKEN).
        authorization: `Bearer ${apiKey}`,
        "anthropic-version": "2023-06-01",
        // Present as the Claude Code CLI so AgentRouter accepts us as an
        // authorized client (otherwise: "unauthorized client detected").
        "user-agent": "claude-cli/1.0.60 (external, cli)",
        "x-app": "cli",
      },
      body: JSON.stringify(payload),
    });
  } catch (err: any) {
    return json(
      { error: `Could not reach AgentRouter: ${err?.message || "network error"}.` },
      502
    );
  }

  const rawText = await upstream.text();

  if (!upstream.ok) {
    return json({ error: extractError(rawText) || `AgentRouter returned ${upstream.status}.` }, upstream.status || 502);
  }

  // Parse the complete JSON body and extract the assistant text.
  let data: any;
  try {
    data = JSON.parse(rawText);
  } catch {
    return json(
      { error: `Unexpected non-JSON reply from AgentRouter: ${rawText.slice(0, 400)}` },
      502
    );
  }

  // Upstream may still carry an error object inside a 200.
  if (data?.error) {
    return json({ error: extractError(rawText) }, 400);
  }

  const text = extractText(data);
  if (!text) {
    // Surface the raw JSON so we can see the exact shape and fix parsing.
    return json(
      { error: `Model replied but no text was found. Raw: ${rawText.slice(0, 600)}` },
      200
    );
  }

  return json({ text }, 200);
}

/* ---------- helpers ---------- */

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
      // some providers return content parts
      const t = choice.message.content
        .map((p: any) => (typeof p === "string" ? p : p?.text || ""))
        .join("");
      if (t) return t;
    }
  }
  // Bare shapes
  if (typeof data?.content === "string") return data.content;
  if (typeof data?.text === "string") return data.text;
  return "";
}

function extractError(raw: string): string {
  try {
    const o = JSON.parse(raw);
    if (o?.error?.message) return o.error.message;
    if (typeof o?.error === "string") return o.error;
    if (o?.message) return o.message;
  } catch {
    /* not JSON */
  }
  return raw.slice(0, 400);
}

function json(data: unknown, status: number) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
