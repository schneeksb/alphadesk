import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Disable auth on localhost — Google OAuth redirect won't be whitelisted for local dev,
// so we skip auth entirely and let the app run with localStorage only.
const isLocalhost = typeof window !== "undefined" && window.location.hostname === "localhost";

export const authEnabled = Boolean(url && key) && !isLocalhost;
export const supabase = (url && key) ? createClient(url, key) : null;
