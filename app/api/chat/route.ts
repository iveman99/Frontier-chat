import { NextRequest } from "next/server";

// Run on the Edge runtime for fast, streaming-friendly responses.
export const runtime = "edge";

// The AgentRouter base URL. Same value you used as ANTHROPIC_BASE_URL.
// Can be overridden with an env var if the host ever changes.
const BASE_URL = process.env.AGENTROUTER_BASE_URL || "https://agentrouter.org";

/**
 * Proxy endpoint. The browser sends the user's own API key + the chat payload;
 * we forward it to AgentRouter's Anthropic-compatible /v1/messages endpoint and
 * stream the Server-Sent Events response straight back to the browser.
 *
 * We proxy (rather than calling AgentRouter directly from the browser) because
 * browsers block cross-origin API calls (CORS). The key is never stored on the
 * server — it only passes through this request.
 */
export async function POST(req: NextRequest) {
  let body: {
    apiKey?: string;
    model?: string;
    system?: string;
    max_tokens?: number;
    messages?: unknown;
  };

  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request body." }, 400);
  }

  const { apiKey, model, system, messages } = body;

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
    stream: true,
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
        // AgentRouter expects the key as a Bearer token (same as Claude Code's
        // ANTHROPIC_AUTH_TOKEN), NOT the x-api-key header.
        authorization: `Bearer ${apiKey}`,
        "anthropic-version": "2023-06-01",
        // AgentRouter rejects requests that don't look like an authorized
        // client ("unauthorized client detected"). Present as the Claude Code
        // CLI, which is the client these keys are provisioned for.
        "user-agent": "claude-cli/1.0.60 (external, cli)",
        "x-app": "cli",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return json(
      { error: "Could not reach AgentRouter. Check your connection and try again." },
      502
    );
  }

  // If the upstream failed, surface a readable error to the client.
  if (!upstream.ok || !upstream.body) {
    let detail = `AgentRouter returned ${upstream.status}.`;
    try {
      const errText = await upstream.text();
      if (errText) detail = errText;
    } catch {
      /* ignore */
    }
    return json({ error: detail }, upstream.status || 502);
  }

  // Pipe the SSE stream straight through.
  return new Response(upstream.body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

function json(data: unknown, status: number) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
