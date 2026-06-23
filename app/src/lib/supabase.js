import { createClient } from "@supabase/supabase-js";

// Auth turns on ONLY when these are set (locally absent → app runs exactly as before).
const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const authEnabled = Boolean(url && key);
export const supabase = authEnabled ? createClient(url, key) : null;
