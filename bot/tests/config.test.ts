import { assertEquals, assertThrows } from "@std/assert";
import { loadConfig } from "../src/config.ts";

const full = {
  UZEL_BASE_URL: "https://uzel.example.kz", UZEL_API_KEY: "uzel_x", UZEL_WEBHOOK_SECRET: "whsec_x",
  UCHET_API_URL: "https://u.example/functions/v1/uchet", UCHET_SERVICE_KEY: "k", ANTHROPIC_API_KEY: "a",
  TELEGRAM_BOT_TOKEN: "t", TELEGRAM_WEBHOOK_SECRET: "s", TELEGRAM_OWNER_ID: "42",
  DATABASE_URL: "postgres://x", PUBLIC_BASE_URL: "https://bot.example.kz",
};

Deno.test("config: всё задано — модель по умолчанию Sonnet 5.5, порт 8080", () => {
  const c = loadConfig(full);
  assertEquals(c.model, "claude-sonnet-5-5");
  assertEquals(c.port, 8080);
  assertEquals(c.telegramOwnerId, 42);
});

Deno.test("config: нет переменной — ошибка с её именем, без значений", () => {
  const { UCHET_SERVICE_KEY: _, ...rest } = full;
  assertThrows(() => loadConfig(rest), Error, "UCHET_SERVICE_KEY");
});

Deno.test("config: секрет вебхука может быть пустым до регистрации", () => {
  const c = loadConfig({ ...full, UZEL_WEBHOOK_SECRET: "" });
  assertEquals(c.uzelWebhookSecret, "");
});

Deno.test("config: TELEGRAM_OWNER_ID и PORT — только числа, иначе ошибка с именем переменной", () => {
  assertThrows(() => loadConfig({ ...full, TELEGRAM_OWNER_ID: "андрей" }), Error, "TELEGRAM_OWNER_ID");
  assertThrows(() => loadConfig({ ...full, PORT: "80a" }), Error, "PORT");
  assertEquals(loadConfig({ ...full, PORT: "9000" }).port, 9000);
});
