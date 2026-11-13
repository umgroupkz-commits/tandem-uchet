// Настройки из окружения контейнера. Значения секретов в сообщения об ошибках не попадают.
export interface Config {
  uzelBase: string; uzelKey: string; uzelWebhookSecret: string;
  uchetUrl: string; uchetKey: string; anthropicKey: string; model: string;
  tgToken: string; tgWebhookSecret: string; telegramOwnerId: number;
  databaseUrl: string; publicBase: string; port: number;
  /** BOT_MODE=silent — бот слушает и записывает, но никому не пишет. Замок сильнее настроек учёта:
   *  снимается только правкой bot.env на сервере, чтобы бот не заговорил с клиентами по недосмотру. */
  silent: boolean;
}

const REQUIRED = ["UZEL_BASE_URL", "UZEL_API_KEY", "UCHET_API_URL", "UCHET_SERVICE_KEY", "DATABASE_URL", "PUBLIC_BASE_URL"];
// Нужно только говорящему боту: в тихом режиме он не обращается к модели и не шлёт карточки в Telegram,
// поэтому запускается на одном «Узле» и учёте — без ключа Anthropic и до того, как заведён бот Telegram.
const REQUIRED_TALKING = ["ANTHROPIC_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_OWNER_ID"];

export function loadConfig(env: Record<string, string | undefined>): Config {
  const silent = (env.BOT_MODE ?? "").trim().toLowerCase() === "silent";
  const missing = [...REQUIRED, ...(silent ? [] : REQUIRED_TALKING)].filter((k) => !env[k]);
  if (missing.length) throw new Error("Не заданы переменные окружения: " + missing.join(", "));
  const num = (k: string, v: string) => {
    const n = Number(v);
    if (!v.trim() || !Number.isFinite(n)) throw new Error(`Переменная окружения ${k} должна быть числом`);
    return n;
  };
  return {
    uzelBase: env.UZEL_BASE_URL!.replace(/\/$/, ""), uzelKey: env.UZEL_API_KEY!,
    uzelWebhookSecret: env.UZEL_WEBHOOK_SECRET ?? "",
    uchetUrl: env.UCHET_API_URL!, uchetKey: env.UCHET_SERVICE_KEY!, anthropicKey: env.ANTHROPIC_API_KEY ?? "",
    model: env.BOT_MODEL || "claude-sonnet-5-5",
    tgToken: env.TELEGRAM_BOT_TOKEN ?? "", tgWebhookSecret: env.TELEGRAM_WEBHOOK_SECRET ?? "",
    telegramOwnerId: env.TELEGRAM_OWNER_ID ? num("TELEGRAM_OWNER_ID", env.TELEGRAM_OWNER_ID) : 0,
    databaseUrl: env.DATABASE_URL!, publicBase: env.PUBLIC_BASE_URL!.replace(/\/$/, ""),
    port: num("PORT", env.PORT || "8080"),
    silent,
  };
}
