// Маршруты: вебхук «Узла», вебхук Telegram (секретный заголовок), здоровье. Ответ Telegram — сразу.
import type { Inbound } from "./inbound.ts";
import type { Cards } from "./telegram.ts";

export function makeApp(d: { inbound: Pick<Inbound, "handle">; cards: Pick<Cards, "onUpdate">; tgSecret: string; health: () => Promise<unknown> }) {
  return async (req: Request): Promise<Response> => {
    const path = new URL(req.url).pathname;
    if (req.method === "POST" && path === "/uzel") return d.inbound.handle(req);
    if (req.method === "POST" && path === "/tg") {
      if (req.headers.get("x-telegram-bot-api-secret-token") !== d.tgSecret) return new Response("no", { status: 401 });
      const u = await req.json().catch(() => null);
      if (u) d.cards.onUpdate(u).catch((e) => console.error("tg", String(e)));
      return new Response("ok");
    }
    if (req.method === "GET" && path === "/health") return Response.json(await d.health());
    return new Response("not found", { status: 404 });
  };
}
