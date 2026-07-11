# iveman · UI

A polished, enterprise-style chat web app for frontier AI models
(Claude Opus 4.8/4.7/4.6, GPT-5.5, GLM-5.2) via [AgentRouter](https://agentrouter.org).
Your friends open one link, paste their own API key, and start chatting.

---

## ⚠️ Important: why a proxy is required

AgentRouter is built for **CLI tools**, not browsers. It enforces two blocks:

1. **Client check** — it inspects the `User-Agent` and only allows CLI clients.
   Browsers can't change their `User-Agent`, so a direct browser call is
   rejected (`unauthorized client detected`).
2. **Firewall (Aliyun WAF)** — it blocks datacenter IPs (Vercel/Railway/Render),
   returning an HTML challenge page instead of the API.

The fix is a tiny **Cloudflare Worker** that (a) adds the CLI `User-Agent` and
(b) runs on Cloudflare's edge (an allowed IP). The browser calls the Worker; the
Worker calls AgentRouter. It's free and takes ~2 minutes to set up **once**.

```
Your friend's browser  →  Cloudflare Worker (adds CLI User-Agent)  →  AgentRouter
   (Vercel-hosted UI)       (free, permanent URL)
```

---

## Setup (do this once)

### Step 1 — Deploy the Cloudflare Worker

1. Create a free account at <https://dash.cloudflare.com>.
2. Left sidebar → **Workers & Pages** → **Create** → **Create Worker**.
3. Give it a name (e.g. `iveman-proxy`) → **Deploy**.
4. Click **Edit code**. Delete the sample code, and paste the entire contents of
   [`worker/agentrouter-proxy.js`](worker/agentrouter-proxy.js) from this repo.
5. Click **Deploy** (top right).
6. Copy the Worker URL shown — it looks like
   `https://iveman-proxy.YOURNAME.workers.dev`.

### Step 2 — Tell your Vercel app about the Worker

1. In Vercel → your project → **Settings** → **Environment Variables**.
2. Add:
   - **Name:** `NEXT_PUBLIC_PROXY_URL`
   - **Value:** your Worker URL from Step 1
3. Go to **Deployments** → open the latest → **Redeploy** (so the env var takes
   effect).

Done. Now anyone who opens your Vercel link just enters their name + AgentRouter
key and chats — they never see or need the proxy URL.

> No Cloudflare account handy? Users can instead paste a Worker URL themselves in
> the app's **Settings → Proxy URL** field. But setting the env var once is the
> clean path for non-technical friends.

---

## What your friends do

1. Open your Vercel link.
2. Enter their **name** and their own **AgentRouter API key**
   (from <https://agentrouter.org>).
3. Pick a model, type, press **Enter**.

Their key is stored only in their browser and sent through the Worker to the
model — never stored on any server.

---

## Run locally (for development)

```bash
npm install
# point it at your Worker:
echo 'NEXT_PUBLIC_PROXY_URL=https://your-worker.workers.dev' > .env.local
npm run dev
```

Open <http://localhost:3000>.

---

## Features

- 💬 Chat with 5 frontier models, switchable per-message
- 👤 Per-user names + avatars (a fresh visit starts a clean session)
- 🖼 Image / screenshot upload (Claude Opus models)
- 🎛 Optional system prompt
- 🌗 Automatic light / dark mode
- 🔒 Keys live only in the user's browser

---

## Files

- `app/page.tsx` — the chat UI
- `app/globals.css` — enterprise styling (light/dark)
- `worker/agentrouter-proxy.js` — the Cloudflare Worker proxy
- No server/database — the Vercel app is fully static.

---

## Troubleshooting

| Message | Meaning / fix |
|---|---|
| `No proxy URL configured` | Set `NEXT_PUBLIC_PROXY_URL` in Vercel (Step 2), or paste a Worker URL in Settings. |
| `unauthorized client detected` | The Worker isn't adding the CLI User-Agent — re-check you pasted `worker/agentrouter-proxy.js` correctly. |
| `invalid token` / `无效的令牌` | The API key is wrong. Re-enter it in Settings. |
| Firewall / HTML response | Rare: the Worker's egress IP was blocked. Redeploy the Worker, or host it on another region/provider. |
