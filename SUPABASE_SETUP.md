# AlphaDesk — Login & Multi-User Setup (Supabase + Google)

This adds Google sign-in and gives every user their own private data. The app code is
already wired; it stays dormant until you add the two env vars below, so nothing breaks
in the meantime.

## 1. Create a Supabase project (free)
1. Go to https://supabase.com → sign in → **New project**. Pick a name + region; save the DB password.
2. When it's ready, open **Project Settings → API** and copy:
   - **Project URL** (e.g. `https://abcd1234.supabase.co`)
   - **anon public** key (a long `eyJ...` string — this one is safe in the frontend)

## 2. Create the database table
- Supabase → **SQL Editor** → New query → paste the contents of `supabase/schema.sql` → **Run**.
  (Creates the `portfolios` table with Row-Level Security so users can't see each other's data.)

## 3. Turn on Google sign-in
1. **Google Cloud:** https://console.cloud.google.com → create/select a project →
   **APIs & Services → Credentials → Create Credentials → OAuth client ID** → type **Web application**.
   - Under **Authorized redirect URIs**, add the callback Supabase shows you in the next step
     (looks like `https://<your-project>.supabase.co/auth/v1/callback`).
   - Copy the **Client ID** and **Client secret**.
2. **Supabase:** **Authentication → Providers → Google** → enable → paste the Client ID + secret → save.
3. **Supabase:** **Authentication → URL Configuration** → set **Site URL** to your Vercel URL
   (e.g. `https://alphadesk.vercel.app`) and add `http://localhost:5173` to **Redirect URLs** for local testing.

## 4. Add the env vars
Add these wherever the frontend runs:

```
VITE_SUPABASE_URL=https://<your-project>.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...your-anon-key...
```

- **Local:** put them in `app/.env.local` (gitignored), then restart `npm run dev`.
- **Vercel:** Project → Settings → Environment Variables → add both → **Redeploy** (Vite bakes these in at build time).

## 5. Done
With the vars set, the app shows a **Sign in with Google** screen; after login each user gets
their own watchlist/portfolio/settings/accounts, synced across devices. Without the vars, the app
runs exactly as before (no login, local-only).

## 6. ⚠️ Verify your data is actually private (do this once)

Each user's financial data lives in one row of the `portfolios` table, keyed by their `user_id`.
The frontend talks to Supabase with the **anon public** key. The ONLY thing stopping one user
from reading another user's row is **Row-Level Security (RLS)**. `supabase/schema.sql` enables it,
but you must confirm it's active:

1. Supabase → **Authentication → Policies** (or **Database → Tables → portfolios → RLS**).
2. Confirm **RLS is enabled** on `public.portfolios` and you see three policies:
   `own portfolio select / insert / update`, each `auth.uid() = user_id`.
3. If RLS shows **disabled** or there are no policies, re-run `supabase/schema.sql` in the SQL Editor.

> If RLS is off, the anon key can read every row — anyone could see everyone's holdings.
> This single setting is what enforces "only I can see my information." Treat it as required.

Quick self-test: sign in as two different Google accounts (e.g. a second browser/incognito),
add a position in each, and confirm neither sees the other's positions.

## Security model (how isolation is enforced)
- **Logged-in users:** all holdings/watchlist/accounts/cash/margin persist ONLY to that user's
  private, RLS-protected Supabase row. The app never writes a logged-in user's data to the
  backend's shared `positions.json` / `settings.json`.
- **Anonymous / local mode** (no Supabase env vars): single-user, data in `localStorage` + the
  backend's local `positions.json`. Intended for running AlphaDesk locally for yourself only —
  do **not** expose that backend publicly with real holdings, since those files are unauthenticated.
- **Never** put the Supabase `service_role` key in the frontend or any env var prefixed `VITE_`.
  Only the `anon` public key belongs in the browser.
