import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Disable auth on localhost — Google OAuth redirect won't be whitelisted for local dev,
// so we skip auth entirely and let the app run with localStorage only.
const isLocalhost = typeof window !== "undefined" && window.location.hostname === "localhost";

export const authEnabled = Boolean(url && key) && !isLocalhost;
export const supabase = (url && key) ? createClient(url, key) : null;

// Cache the current access token so requests to the backend AI endpoints can
// attach it synchronously. The backend verifies it (only signed-in users may
// trigger paid Claude calls). Kept fresh via the auth state listener.
let _accessToken = null;
if (supabase) {
  supabase.auth.getSession().then(({ data }) => { _accessToken = data.session?.access_token || null; });
  supabase.auth.onAuthStateChange((_e, s) => { _accessToken = s?.access_token || null; });
}
export function authHeaders() {
  return _accessToken ? { Authorization: `Bearer ${_accessToken}` } : {};
}
