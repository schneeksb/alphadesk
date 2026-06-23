# Deploying AlphaDesk

Backend (FastAPI) → **Render**. Frontend (Vite/React in `app/`) → **Vercel**.
One GitHub repo holds both; the two platforms deploy from different root directories.

## 1. Push to GitHub
The repo is already initialized and committed locally. Create an **empty** repo on
github.com (no README), then:

```powershell
git remote add origin https://github.com/<you>/alphadesk.git
git branch -M main
git push -u origin main
```

## 2. Backend → Render
1. https://dashboard.render.com → **New +** → **Blueprint** → connect your GitHub repo.
2. Render reads `render.yaml` and creates the `alphadesk-api` web service.
3. When prompted (or in the service's **Environment** tab), set:
   - `ANTHROPIC_API_KEY` = your real key  ← **required**
4. Deploy. Note the URL, e.g. `https://alphadesk-api.onrender.com`.
5. Verify: open `https://<your-render-url>/health` → should return `{"ok": true, ...}`.

## 3. Frontend → Vercel
1. https://vercel.com → **Add New… → Project** → import the same GitHub repo.
2. **Root Directory: `app`**  (important — the Vite app lives there).
   Framework preset auto-detects **Vite**; build `npm run build`, output `dist`.
3. Add an Environment Variable:
   - `VITE_API_URL` = your Render URL (e.g. `https://alphadesk-api.onrender.com`, no trailing slash)
4. Deploy. Open the Vercel URL on your phone — that's AlphaDesk, reachable anywhere.

## Caveats on free tiers
- **Render Free sleeps** after ~15 min idle; the first request then takes ~50s to wake
  (the Briefing/Portfolio will be slow on that first hit). A paid instance stays warm.
- **`positions.json` is ephemeral on Render** — the filesystem resets on each deploy/restart,
  so saved positions won't survive long-term. For durable positions you'd move the store to a
  database or a Render persistent disk (paid). Ask and I'll wire that up.
- CORS currently allows all origins. Once the Vercel domain is known, it can be locked down to it.
- If you rotate the Anthropic key, update it in Render's Environment tab.
