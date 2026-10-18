import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const APP_PUBLISHABLE_KEY = "sb_publishable_YjvZDDh2CPsaSShoippJ9g_1ccsuj-F";
const ALLOWED_ORIGINS = new Set([
  "https://leocguedes.github.io",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);
const AFRODITE_URL = "https://raw.githubusercontent.com/adrianosferreira/afrodite.json/master/afrodite.json";
let afroditeCache: Promise<Record<string, unknown>[]> | null = null;

async function fetchAfrodite() {
  if (!afroditeCache) {
    afroditeCache = (async () => {
      const response = await fetch(AFRODITE_URL, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error(`Afrodite returned ${response.status}`);
      const data = await response.json();
      if (!Array.isArray(data)) throw new Error("Unexpected Afrodite data format");
      return data as Record<string, unknown>[];
    })().catch((error) => {
      afroditeCache = null;
      throw error;
    });
  }
  return await afroditeCache;
}

function afroditeSections(recipe: Record<string, unknown>) {
  return Array.isArray(recipe.secao) ? recipe.secao as Array<Record<string, unknown>> : [];
}

function cleanAfroditeIngredient(raw: string) {
  return raw.replace(/^\s*(?:[-•]\s*)?(?:\d+(?:[.,]\d+)?\s*(?:g|kg|mg|ml|l|litros?|xícaras?|xic\.?|colheres?|c\.?s\.?|c\.?chá|unidades?|dentes?)\b\s*(?:de\s+)?)?/i, "").replace(/^\s*\d+\s+/, "").replace(/\s+/g, " ").trim().replace(/[.,;:]$/, "");
}

function parseAfroditeRecipe(raw: Record<string, unknown>, index: number, matched: string[]) {
  const sections = afroditeSections(raw);
  const sectionContent = (needle: string) => sections.find((section) => normalize(String(section.nome ?? "")).includes(needle));
  const ingredientsSection = sectionContent("ingrediente");
  const preparationSection = sections.find((section) => {
    const name = normalize(String(section.nome ?? ""));
    return name.includes("preparo") || name.includes("modo de fazer") || name.includes("como fazer");
  });
  const lines = Array.isArray(ingredientsSection?.conteudo) ? ingredientsSection.conteudo : [];
  const ingredients = lines.map((line) => String(line ?? "").trim()).filter((line) => line && line.length > 1).map((line) => {
    const name = cleanAfroditeIngredient(line) || line;
    return { name, aliases: [...new Set([name, line])], quantity: 1, unit: "unidades", measureText: line };
  });
  const instructions = (Array.isArray(preparationSection?.conteudo) ? preparationSection.conteudo : [])
    .map((step) => String(step ?? "").trim())
    .filter((step) => step && !/^\d+\s*(?:porções?|rendimento)/i.test(step));
  const id = String(raw._id ?? raw.id ?? index);
  const name = String(raw.nome ?? "").trim();
  if (!name || !ingredients.length || !instructions.length) return null;
  return {
    id: `afrodite-${id}`,
    name,
    description: "Receita em português da base Afrodite. Confira as medidas originais antes de preparar.",
    minutes: 0,
    servings: 0,
    ingredients,
    instructions,
    source: "afrodite",
    sourceUrl: "https://github.com/adrianosferreira/afrodite.json",
    presenceOnly: true,
    matchedPantryIngredients: matched,
  };
}

async function searchAfrodite(input: string[]) {
  const data = await fetchAfrodite();
  const pantryTerms = [...new Set(input.map(normalize).filter((value) => value.length >= 3))];
  const scored = data.map((raw, index) => {
    const sections = afroditeSections(raw);
    const section = sections.find((item) => normalize(String(item.nome ?? "")).includes("ingrediente"));
    const lines = Array.isArray(section?.conteudo) ? section.conteudo.map((line) => normalize(String(line ?? ""))).filter(Boolean) : [];
    const matchedLines = lines.filter((line) => pantryTerms.some((term) =>
      line.includes(term) || term.split(/\s+/).filter(part => part.length >= 4).some(part => line.includes(part))
    ));
    const matched = pantryTerms.filter((term) => lines.some((line) =>
      line.includes(term) || term.split(/\s+/).filter(part => part.length >= 4).some(part => line.includes(part))
    ));
    const coverage = lines.length ? matchedLines.length / lines.length : 0;
    return { raw, index, matchedLines: matchedLines.length, totalIngredients: lines.length, coverage, matched };
  }).filter((item) => item.matchedLines > 0)
    .sort((a, b) =>
      b.coverage - a.coverage ||
      b.matchedLines - a.matchedLines ||
      a.totalIngredients - b.totalIngredients ||
      String(a.raw.nome ?? "").localeCompare(String(b.raw.nome ?? ""), "pt-BR")
    )
    .slice(0, 20);
  return scored.map((item) => parseAfroditeRecipe(item.raw, item.index, item.matched)).filter(Boolean);
}


const normalize = (value: string) =>
  value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function jsonResponse(body: unknown, status: number, origin: string) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json; charset=utf-8" },
  });
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") ?? "";
  if (req.method === "OPTIONS") {
    if (!ALLOWED_ORIGINS.has(origin)) return new Response("Origin not allowed", { status: 403 });
    return new Response("ok", { headers: corsHeaders(origin) });
  }
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!ALLOWED_ORIGINS.has(origin)) return new Response("Origin not allowed", { status: 403 });
  // This is a read-only proxy for public recipe data; require the app's public API key
  // and an allowed browser origin. No user data or service-role credentials are accessed.
  if (req.headers.get("apikey") !== APP_PUBLISHABLE_KEY) {
    return jsonResponse({ error: "Unauthorized" }, 401, origin);
  }

  let body: { ingredients?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400, origin);
  }
  const input = Array.isArray(body.ingredients)
    ? body.ingredients.filter((item): item is string => typeof item === "string").slice(0, 40)
    : [];
  const offset = Number.isInteger(body.offset) && Number(body.offset) >= 0 ? Number(body.offset) : 0;
  const requestedLimit = Number.isInteger(body.limit) ? Number(body.limit) : 10;
  const limit = Math.min(10, Math.max(1, requestedLimit));
  if (!input.length) return jsonResponse({ recipes: [], total: 0, hasMore: false }, 200, origin);

  try {
    const allRecipes = await searchAfrodite(input);
    const recipes = allRecipes.slice(offset, offset + limit);
    return jsonResponse({ recipes, total: allRecipes.length, hasMore: offset + recipes.length < allRecipes.length }, 200, origin);
  } catch {
    return jsonResponse({ error: "Recipe source temporarily unavailable", recipes: [], total: 0, hasMore: false }, 502, origin);
  }
});
