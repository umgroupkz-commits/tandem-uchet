// Адаптер Anthropic SDK. Параметры собирает dialog.ts; здесь — только транспорт и тайм-аут. Повторы SDK
// выключены: единственный повтор (429, 5xx, обрыв) делает dialog.ts, итого не больше двух попыток.
import Anthropic from "@anthropic-ai/sdk";
import type { Block, ModelClient } from "./dialog.ts";

export class ClaudeModel implements ModelClient {
  private client: Anthropic;
  constructor(apiKey: string, client?: Anthropic) { this.client = client ?? new Anthropic({ apiKey, timeout: 60_000, maxRetries: 0 }); }
  async create(p: Record<string, unknown>) {
    const r = await this.client.beta.messages.create(p as never);
    const x = r as unknown as { content: Block[]; stop_reason: string; usage?: Record<string, number> };
    return { content: x.content, stop_reason: x.stop_reason, usage: x.usage };
  }
}
