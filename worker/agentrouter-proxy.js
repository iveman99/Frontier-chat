/**
 * iveman·UI — AgentRouter proxy (Cloudflare Worker)
 * ---------------------------------------------------
 * Why this exists:
 *   AgentRouter blocks two things that stop a browser talking to it directly:
 *     1) It only accepts CLI-style clients (checks the User-Agent). Browsers
 *        cannot set User-Agent, so a direct browser call is rejected with
 *        "unauthorized client detected".
 *     2) It sits behind Aliyun WAF, which blocks many datacenter IPs
 *        (Vercel/Railway/Render), returning an HTML challenge page.
 *
 *   This Worker solves both: it runs on Cloudflare's edge (an IP the WAF
 *   generally allows) and injects the Claude-CLI User-Agent that AgentRouter
 *   expects. The browser calls this Worker (with permissive CORS), and the
 *   Worker forwards to AgentRouter.
 *
 * The user's API key is passed straight through and never stored or logged.
 *
 * Deploy: paste into a new Cloudflare Worker (workers.dev) and Deploy. Then set
 * NEXT_PUBLIC_PROXY_URL in Vercel to the Worker's URL.
 */

const AGENTROUTER = "https://agentrouter.org/v1/messages";
const CLAUDE_UA = "claude-cli/1.0.60 (external, cli)";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, anthropic-version, x-api-key",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request) {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method !== "POST") {
      return json({ error: { message: "Use POST." } }, 405);
    }

    // Read the client payload. Accept the key either in the Authorization
    // header (Bearer) or an `apiKey` field in the JSON body.
    let bodyText = await request.text();
    let apiKey = "";
    const auth = request.headers.get("authorization") || "";
    if (auth.toLowerCase().startsWith("bearer ")) apiKey = auth.slice(7).trim();

    try {
      const parsed = JSON.parse(bodyText);
      if (!apiKey && typeof parsed.apiKey === "string") apiKey = parsed.apiKey;
      if ("apiKey" in parsed) {
        delete parsed.apiKey; // don't forward our own field
        bodyText = JSON.stringify(parsed);
      }
    } catch {
      return json({ error: { message: "Invalid JSON body." } }, 400);
    }

    if (!apiKey) {
      return json({ error: { message: "Missing API key." } }, 401);
    }

    let upstream;
    try {
      upstream = await fetch(AGENTROUTER, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
          "anthropic-version": "2023-06-01",
          "user-agent": CLAUDE_UA,
          "x-app": "cli",
        },
        body: bodyText,
      });
    } catch (err) {
      return json({ error: { message: `Upstream fetch failed: ${err}` } }, 502);
    }

    // Pass the upstream response through, adding CORS headers.
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        "content-type":
          upstream.headers.get("content-type") || "application/json",
        ...CORS,
      },
    });
  },
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}
