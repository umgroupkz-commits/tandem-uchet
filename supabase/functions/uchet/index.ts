import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Тандем KZ — API учёта продаж (POST {action, payload} → JSON).
// HTML отсюда не отдаётся: на *.supabase.co и Edge Functions, и Storage переписывают text/html
// в text/plain (https://supabase.com/docs/guides/functions/http-methods). Страница живёт на GitHub Pages.

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PAGE_URL = "https://umgroupkz-commits.github.io/tandem-uchet/";

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "POST, GET, OPTIONS",
};

async function rpc(fn: string, args: unknown): Promise<Response> {
  return await fetch(SB_URL + "/rest/v1/rpc/" + fn, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: SB_KEY,
      authorization: "Bearer " + SB_KEY,
      accept: "application/json",
    },
    body: JSON.stringify(args),
  });
}

async function proxy(fn: string, args: unknown): Promise<Response> {
  const r = await rpc(fn, args);
  const text = await r.text();
  if (!r.ok) {
    console.error(fn + " error", r.status, text);
    return json({ ok: false, error: "Ошибка базы данных", detail: text.slice(0, 300) }, 500);
  }
  return new Response(text, { headers: { "content-type": "application/json; charset=utf-8", ...CORS } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  if (req.method === "POST") {
    let body: { action?: string; payload?: Record<string, unknown> };
    try {
      body = await req.json();
    } catch {
      return json({ ok: false, error: "Некорректный запрос" }, 400);
    }
    const action = body.action ?? "";
    const payload = (body.payload ?? {}) as Record<string, unknown>;
    // Вся маршрутизация, служебный ключ и счётчик неверных кодов — в базе (public.tandem_gate,
    // миграция 0029). Прокси остаётся тонким: тот же вызов делает server/proxy.mjs на своём сервере.
    return await proxy("tandem_gate", { action, payload });
  }

  if (new URL(req.url).searchParams.has("health")) {
    return json({ ok: true, page_url: PAGE_URL });
  }

  return new Response(null, { status: 302, headers: { location: PAGE_URL, "cache-control": "no-store", ...CORS } });
});

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
  });
}
