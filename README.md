# iveman · UI

A clean, private chat web app for frontier AI models, powered by your own
[AgentRouter](https://agentrouter.org) API key. Built so non-technical friends
can just open a link, paste a key, and start chatting.

**Models available:** Claude Opus 4.8 / 4.7 / 4.6 (with image upload), GPT-5.5, GLM-5.2.

## Features

- 💬 Streaming chat (text appears live as the model types)
- 🔑 Each user enters **their own** API key — stored only in their browser, never on a server
- 🖼 Image / screenshot upload for vision-capable models
- 🎛 Model picker + optional system prompt
- 💾 Chat history saved locally in the browser
- 🌗 Automatic dark / light mode
- 📱 Works on phone and desktop

---

## Run it on your computer (local)

```bash
npm install
npm run dev
```

Then open <http://localhost:3000>. Click **⚙ Settings**, paste your AgentRouter
key, and go.

---

## Deploy it for free (so friends can use it)

You only need to do this **once**. Your friends then just open the link and
enter their own keys.

### Option A — Vercel (easiest, recommended)

1. Push this folder to a GitHub repo (see "Push to GitHub" below).
2. Go to <https://vercel.com>, sign in with GitHub, click **Add New → Project**.
3. Pick this repo and click **Deploy**. No settings to change.
4. You'll get a free URL like `https://iveman-ui.vercel.app`. Share it.

### Option B — Railway

1. Push to GitHub (below).
2. Go to <https://railway.app> → **New Project → Deploy from GitHub repo**.
3. Railway auto-detects Next.js. It sets the build (`npm run build`) and start
   (`npm run start`) commands automatically. Deploy.

### Option C — Render

1. Push to GitHub (below).
2. Go to <https://render.com> → **New → Web Service** → connect the repo.
3. Set:
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `npm run start`
4. Create the service. Done.

---

## Push to GitHub (first time)

```bash
git init
git add .
git commit -m "iveman UI"
# create an empty repo on github.com first, then:
git remote add origin https://github.com/YOUR_NAME/iveman-ui.git
git branch -M main
git push -u origin main
```

---

## How your friends use it

1. Open the URL you deployed.
2. On first visit, a Settings box pops up — they paste **their own** AgentRouter
   key (from <https://agentrouter.org>).
3. Pick a model at the top, type, press **Enter**. That's it.

> The key is saved only in their browser's local storage. It is sent straight to
> the model through a thin proxy and is never logged or stored on the server.

---

## Notes & FAQ

- **Why is there a backend proxy?** Browsers block direct calls to AgentRouter
  (CORS). The `/api/chat` route just forwards your request — it does not store
  your key.
- **Images not working on GPT-5.5 / GLM-5.2?** Only the Claude Opus models are
  marked 🖼 for vision. The others may reject images.
- **Change the model list?** Edit the `MODELS` array at the top of
  [`app/page.tsx`](app/page.tsx).
- **Different AgentRouter host?** Set an `AGENTROUTER_BASE_URL` environment
  variable on your host; it defaults to `https://agentrouter.org`.

---

## Tech

Next.js 14 (App Router) · React 18 · TypeScript · Edge runtime for the streaming
proxy. No database, no accounts, no server-side secrets.
