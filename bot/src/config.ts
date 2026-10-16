// Настройки из окружения контейнера. Значения секретов в сообщения об ошибках не попадают.
export interface Config {
  uzelBase: string; uzelKey: string; uzelWebhookSecret: string;
  uchetUrl: string; uchetKey: string; anthropicKey: string; model: string;
  tgToken: string; tgWebhookSecret: string; telegramOwnerId: number;
  databaseUrl: string; publicBase: string; port: number;
}

const REQUIRED = ["UZEL_BASE_URL", "UZEL_API_KEY", "UCHET_API_URL", "UCHET_SERVICE_KEY", "ANTHROPIC_API_KEY",
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_OWNER_ID", "DATABASE_URL", "PUBLIC_BASE_URL"];

export function loadConfig(env: Record<string, string | undefined>): Config {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length) throw new Error("Не заданы переменные окружения: " + missing.join(", "));
  const num = (k: string, v: string) => {
    const n = Number(v);
    if (!v.trim() || !Number.isFinite(n)) throw new Error(`Переменная окружения ${k} должна быть числом`);
    return n;
  };
  return {
    uzelBase: env.UZEL_BASE_URL!.replace(/\/$/, ""), uzelKey: env.UZEL_API_KEY!,
    uzelWebhookSecret: env.UZEL_WEBHOOK_SECRET ?? "",
    uchetUrl: env.UCHET_API_URL!, uchetKey: env.UCHET_SERVICE_KEY!, anthropicKey: env.ANTHROPIC_API_KEY!,
    model: env.BOT_MODEL || "claude-sonnet-5-5",
    tgToken: env.TELEGRAM_BOT_TOKEN!, tgWebhookSecret: env.TELEGRAM_WEBHOOK_SECRET!,
    telegramOwnerId: num("TELEGRAM_OWNER_ID", env.TELEGRAM_OWNER_ID!),
    databaseUrl: env.DATABASE_URL!, publicBase: env.PUBLIC_BASE_URL!.replace(/\/$/, ""),
    port: num("PORT", env.PORT || "8080"),
  };
}
