import { assert, assertEquals, assertRejects } from "@std/assert";
import { GroqStt, RetryLater } from "../src/media.ts";

function fakeFetch(answers: { status: number; body: unknown }[]) {
  const seen: { url: string; form: FormData; auth: string }[] = [];
  const f = (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), form: init!.body as FormData, auth: new Headers(init!.headers).get("authorization") ?? "" });
    const a = answers.shift()!;
    return Promise.resolve(new Response(JSON.stringify(a.body), { status: a.status }));
  };
  return { f: f as typeof fetch, seen };
}

Deno.test("Groq: голосовое в текст, ключ в заголовке, язык сам, подсказка словами Енешки", async () => {
  const { f, seen } = fakeFetch([{ status: 200, body: { text: " Пирог с мясом на завтра ", language: "russian" } }]);
  assertEquals(await new GroqStt("k1", f).transcribe(new Uint8Array([1]), "audio/ogg; codecs=opus"), "Пирог с мясом на завтра");
  assertEquals(seen[0].url, "https://api.groq.com/openai/v1/audio/transcriptions");
  assertEquals(seen[0].auth, "Bearer k1");
  assertEquals(seen[0].form.get("language"), null);
  assert(String(seen[0].form.get("prompt")).includes("самса"));
  assertEquals((seen[0].form.get("file") as File).name, "voice.ogg");
});
Deno.test("Groq: казахский принимается как есть", async () => {
  const { f, seen } = fakeFetch([{ status: 200, body: { text: "Сәлеметсіз бе", language: "kazakh" } }]);
  assertEquals(await new GroqStt("k", f).transcribe(new Uint8Array([1]), "audio/ogg"), "Сәлеметсіз бе");
  assertEquals(seen.length, 1);
});
Deno.test("Groq: чужой язык - второй раз с русским", async () => {
  const { f, seen } = fakeFetch([{ status: 200, body: { text: "Pirog", language: "english" } }, { status: 200, body: { text: "Пирог", language: "russian" } }]);
  assertEquals(await new GroqStt("k", f).transcribe(new Uint8Array([1]), "audio/ogg"), "Пирог");
  assertEquals(seen[1].form.get("language"), "ru");
});
Deno.test("Groq: 429 и 5xx - повторить позже, 400 - обычная ошибка", async () => {
  await assertRejects(() => new GroqStt("k", fakeFetch([{ status: 429, body: {} }]).f).transcribe(new Uint8Array([1]), "audio/ogg"), RetryLater);
  await assertRejects(() => new GroqStt("k", fakeFetch([{ status: 503, body: {} }]).f).transcribe(new Uint8Array([1]), "audio/ogg"), RetryLater);
  const e = await assertRejects(() => new GroqStt("k", fakeFetch([{ status: 400, body: { error: { message: "bad file" } } }]).f).transcribe(new Uint8Array([1]), "audio/ogg"));
  assert(!(e instanceof RetryLater));
});
