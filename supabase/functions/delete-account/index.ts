import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const PUBLISHABLE_KEY = Deno.env.get("SUPABASE_ANON_KEY")
  || Deno.env.get("SUPABASE_PUBLISHABLE_KEY")
  || "sb_publishable_YjvZDDh2CPsaSShoippJ9g_1ccsuj-F";
const ALLOWED_ORIGINS = new Set([
  "https://leocguedes.github.io",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

function corsHeaders(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://leocguedes.github.io",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
    "Content-Type": "application/json",
  };
}

Deno.serve(async (request: Request) => {
  const headers = corsHeaders(request.headers.get("origin"));
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  if (request.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });

  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return new Response(JSON.stringify({ error: "Authentication required" }), { status: 401, headers });
  if (!SERVICE_ROLE_KEY || !SUPABASE_URL) {
    console.error("Required Supabase server environment is missing.");
    return new Response(JSON.stringify({ error: "Account deletion is temporarily unavailable." }), { status: 503, headers });
  }

  try {
    const userClient = createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: authorization } },
    });
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user || user.is_anonymous) return new Response(JSON.stringify({ error: "A signed-in account is required." }), { status: 401, headers });

    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
    const { error: deleteError } = await adminClient.auth.admin.deleteUser(user.id);
    if (deleteError) {
      console.error("Admin account deletion failed:", deleteError.message);
      return new Response(JSON.stringify({ error: "Could not delete account." }), { status: 500, headers });
    }
    return new Response(JSON.stringify({ success: true }), { status: 200, headers });
  } catch (error) {
    console.error("Account deletion failed:", error instanceof Error ? error.message : "Unknown error");
    return new Response(JSON.stringify({ error: "Could not delete account." }), { status: 500, headers });
  }
});
