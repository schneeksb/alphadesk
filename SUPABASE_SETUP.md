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
their own watchlist/portfolio/settings. Without the vars, the app runs exactly as before (no login).

> Note: per-user data wiring (loading/saving each user's portfolio to their Supabase row) is the
> follow-up step — ping me once Google login works and I'll connect it and we'll test together.
