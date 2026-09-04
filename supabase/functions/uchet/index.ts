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
    const pin = payload.pin ?? "";

    if (action === "charts") {
      return await proxy("tandem_charts", { p_pin: pin, p_point: payload.point_id ?? "" });
    }
    if (action === "realization") {
      return await proxy("tandem_realization", { p_pin: pin, p_action: payload.op ?? "list", p_data: payload.data ?? {} });
    }
    if (action === "save_aliases") {
      return await proxy("tandem_save_aliases", { p_pin: pin, p_point: payload.point_id ?? "", p_data: payload.data ?? [] });
    }

    // Служебные действия синхронизации — проверка кода внутри функций.
    if (action === "sync_items") {
      return await proxy("tandem_sync_items", { p_pin: pin, p_items: payload.items ?? [] });
    }
    if (action === "sync_prices") {
      return await proxy("tandem_sync_prices", { p_pin: pin, p_data: payload.data ?? [] });
    }
    if (action === "sync_charts") {
      return await proxy("tandem_sync_charts", { p_pin: pin, p_data: payload.data ?? [] });
    }
    if (action === "recalc_ranks") {
      return await proxy("tandem_recalc_ranks", { p_pin: pin, p_days: payload.days ?? 30 });
    }
    if (action === "set_packaging") {
      return await proxy("tandem_set_packaging", { p_pin: pin, p_data: payload.data ?? [] });
    }
    if (action === "set_short_list") {
      return await proxy("tandem_set_short_list", { p_pin: pin, p_point: payload.point ?? "", p_codes: payload.codes ?? [] });
    }

    return await proxy("tandem_api", { action, payload });
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
