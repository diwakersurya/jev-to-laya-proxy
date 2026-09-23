import { afterAll, expect, test } from "bun:test";
import { makeHandler } from "./proxy";

let lastBody: any;
const fake = Bun.serve({
  port: 0,
  async fetch(req) {
    lastBody = await req.json();
    if (lastBody.state === "boom") return Response.json({ error: "bad question" }, { status: 400 });
    return Response.json({
      model: "laya-rl-agent",
      answers: {
        n: { type: "noul", noul: 0.9, confidence: 0.9, action: { act_probability: 1 } },
        c: { type: "choice", choice: "a", probabilities: { a: 0.8, b: 0.2 }, confidence: 0.7, action: {} },
      },
      usage: { input_tokens: 10, output_tokens: 0 },
      routing: { model: "english" },
      latency_ms: 5,
    });
  },
});
afterAll(() => fake.stop());

const handler = (apiKey: string | null = null) =>
  makeHandler({
    port: 0, apiKey, backend: "fake",
    backends: {
      fake: {
        url: `http://localhost:${fake.port}`, predictPath: "/p", extraBody: { lang: "en" },
        modelMap: { "jev-latest": null, "laya-english": "english" }, defaultModel: null,
      },
    },
  });

const post = (body: unknown, h = handler(), auth = "Bearer x") =>
  h(new Request("http://proxy/v1/systemone", { method: "POST", headers: { authorization: auth }, body: JSON.stringify(body) }));

const questions = { n: { type: "noul", instructions: "yes?" }, c: { type: "choice", instructions: "which?", criteria: { a: null, b: null } } };

test("maps model, merges extraBody, trims to Jev shape", async () => {
  const r = await post({ state: "hi", model: "laya-english", questions });
  expect(r.headers.get("x-served-by")).toBe("jev-proxy (fake)");
  expect(lastBody).toEqual({ lang: "en", state: "hi", model: "english", questions });
  expect(await r.json()).toEqual({
    model: "laya-rl-agent",
    answers: {
      n: { type: "noul", noul: 0.9 },
      c: { type: "choice", choice: "a", probabilities: { a: 0.8, b: 0.2 }, confidence: 0.7 },
    },
    usage: { input_tokens: 10, output_tokens: 0 },
  });
});

test("unknown model falls back to defaultModel", async () => {
  await post({ state: "hi", model: "jev-9000", questions });
  expect(lastBody.model).toBeNull();
});

test("422 on invalid questions", async () => {
  expect((await post({ state: "hi", questions: {} })).status).toBe(422);
  expect((await post({ state: "hi", questions: { s: { type: "score", instructions: "x", criteria: ["one"] } } })).status).toBe(422);
  expect((await post({ state: "hi", questions: { s: { type: "nope", instructions: "x" } } })).status).toBe(422);
});

test("backend 4xx becomes 422", async () => {
  const r = await post({ state: "boom", questions });
  expect(r.status).toBe(422);
  expect((await r.json()).error.message).toBe("bad question");
});

test("apiKey enforced when set", async () => {
  expect((await post({ state: "hi", questions }, handler("k"), "Bearer wrong")).status).toBe(401);
  expect((await post({ state: "hi", questions }, handler("k"), "Bearer k")).status).toBe(200);
});

test("backend down → 529", async () => {
  const h = makeHandler({ port: 0, apiKey: null, backend: "d", backends: { d: { url: "http://127.0.0.1:1", predictPath: "/" } } });
  expect((await post({ state: "hi", questions }, h)).status).toBe(529);
});

test("/v1/models lists modelMap keys", async () => {
  const r = await handler()(new Request("http://proxy/v1/models"));
  expect((await r.json()).models.map((m: any) => m.name)).toEqual(["jev-latest", "laya-english"]);
});
