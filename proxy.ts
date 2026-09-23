// Jev (TypeSafe System One) API proxy → any Jev-like backend (Laya by default). See config.json.
// Run: bun proxy.ts [--log]   Env: CONFIG=path BACKEND=name PORT=n LOG=1
import embeddedConfig from "./config.json";

type Backend = {
  url: string;
  predictPath: string;
  healthPath?: string;
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  modelMap?: Record<string, string | null>;
  defaultModel?: string | null;
};
type Config = { port: number; apiKey: string | null; backend: string; backends: Record<string, Backend> };

// "${VAR}" in any string of the config → process.env.VAR
const interpolate = (v: any): any =>
  typeof v === "string" ? v.replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] ?? "")
  : Array.isArray(v) ? v.map(interpolate)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, interpolate(x)]))
  : v;

// CONFIG env → ./config.json in cwd → config.json embedded at build time (so a compiled binary runs standalone)
export async function loadConfig(path = process.env.CONFIG ?? "config.json"): Promise<Config> {
  const file = Bun.file(path);
  const raw = (await file.exists()) ? await file.json() : process.env.CONFIG ? null : embeddedConfig;
  if (!raw) throw new Error(`config not found: ${path}`);
  const cfg: Config = interpolate(structuredClone(raw));
  if (process.env.BACKEND) cfg.backend = process.env.BACKEND;
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  if (!cfg.backends[cfg.backend]) throw new Error(`backend "${cfg.backend}" not in config`);
  return cfg;
}

const LOG = process.env.LOG === "1" || process.argv.includes("--log");
const log = (...a: unknown[]) => LOG && console.log(new Date().toISOString(), ...a);
const err = (status: number, message: string, detail?: unknown) =>
  Response.json({ error: { status, message, ...(detail === undefined ? {} : { detail }) } }, { status });

function validate(body: any): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "body must be a JSON object";
  if (!("state" in body)) return "state is required";
  const qs = body.questions;
  if (!qs || typeof qs !== "object" || Array.isArray(qs) || !Object.keys(qs).length) return "questions must be a non-empty map";
  for (const [id, q] of Object.entries<any>(qs)) {
    if (!q || typeof q !== "object") return `questions.${id} must be an object`;
    if (q.instructions == null) return `questions.${id}.instructions is required`;
    const c = q.criteria;
    if (q.type === "noul") {
      if (c != null && (typeof c !== "object" || Array.isArray(c))) return `questions.${id}.criteria must be {true, false}`;
    } else if (q.type === "choice") {
      if (!c || typeof c !== "object" || Array.isArray(c)) return `questions.${id}.criteria must be a map of options`;
      const n = Object.keys(c).length;
      if (n < 2 || n > 255) return `questions.${id}.criteria must have 2-255 options`;
    } else if (q.type === "score") {
      if (!Array.isArray(c) || c.length < 2 || c.length > 10) return `questions.${id}.criteria must be an array of 2-10 levels`;
    } else return `questions.${id}.type must be noul, choice or score`;
  }
  return null;
}

// Keep only the fields the Jev API documents; backends may add their own extras.
function toJevAnswer(a: any) {
  if (a?.type === "noul") return { type: "noul", noul: a.noul };
  if (a?.type === "choice") return { type: "choice", choice: a.choice, probabilities: a.probabilities, confidence: a.confidence };
  if (a?.type === "score")
    return { type: "score", score: a.score, legend: a.legend, probabilities: a.probabilities, confidence: a.confidence };
  return a;
}

export function makeHandler(cfg: Config) {
  const be = cfg.backends[cfg.backend];
  const map = be.modelMap ?? {};
  const headers = { "content-type": "application/json", ...be.headers };

  // Every response is tagged so clients can see the proxy (not the backend) answered.
  return async (req: Request, from = "?"): Promise<Response> => {
    const t = performance.now();
    const { pathname } = new URL(req.url);
    if (LOG) log(`client→proxy ${req.method} ${pathname} from ${from}`, await req.clone().text());
    const res = await route(req, pathname);
    res.headers.set("x-served-by", `jev-proxy (${cfg.backend})`);
    if (LOG) log(`proxy→client ${res.status} ${(performance.now() - t).toFixed(0)}ms`, await res.clone().text());
    return res;
  };

  async function route(req: Request, pathname: string): Promise<Response> {
    if (req.method === "GET" && pathname === "/health") {
      if (!be.healthPath) return Response.json({ ok: true });
      try {
        const r = await fetch(be.url + be.healthPath, { headers: be.headers });
        return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
      } catch (e) {
        return err(529, `backend unreachable: ${e}`);
      }
    }

    if (cfg.apiKey && req.headers.get("authorization") !== `Bearer ${cfg.apiKey}`) return err(401, "invalid API key");

    if (req.method === "GET" && pathname === "/v1/models")
      return Response.json({
        models: Object.entries(map).map(([name, m]) => ({
          name, description: `${cfg.backend}:${m ?? "auto"}`, release_date: "",
        })),
      });

    if (req.method !== "POST" || pathname !== "/v1/systemone") return err(404, `no route ${req.method} ${pathname}`);

    let body: any;
    try { body = await req.json(); } catch { return err(422, "body is not valid JSON"); }
    const invalid = validate(body);
    if (invalid) return err(422, invalid);

    const model = body.model in map ? map[body.model] : (be.defaultModel ?? null);
    const out = { ...be.extraBody, ...body, model };
    log(`proxy→backend POST ${be.url + be.predictPath}`, JSON.stringify(out));

    let r: Response;
    try {
      r = await fetch(be.url + be.predictPath, { method: "POST", headers, body: JSON.stringify(out) });
    } catch (e) {
      return err(529, `backend unreachable: ${e}`);
    }
    const text = await r.text();
    log(`backend→proxy ${r.status}`, text);
    let res: any;
    try { res = JSON.parse(text); } catch { res = text; }

    if (!r.ok) {
      // ponytail: auth/rate-limit statuses pass through, other 4xx → 422, 5xx → 529 so SDKs retry
      const status = [401, 429].includes(r.status) ? r.status : r.status < 500 ? 422 : 529;
      return err(status, res?.error?.message ?? res?.error ?? `backend returned ${r.status}`, res);
    }

    return Response.json({
      model: res.model ?? body.model,
      answers: Object.fromEntries(Object.entries(res.answers ?? {}).map(([k, a]) => [k, toJevAnswer(a)])),
      usage: { input_tokens: res.usage?.input_tokens ?? 0, output_tokens: res.usage?.output_tokens ?? 0 },
    });
  }
}

if (import.meta.main) {
  const cfg = await loadConfig();
  const be = cfg.backends[cfg.backend];
  const handle = makeHandler(cfg);
  Bun.serve({ port: cfg.port, idleTimeout: 255, fetch: (req, server) => handle(req, server.requestIP(req)?.address) });
  console.log(`jev-proxy :${cfg.port} → ${cfg.backend} (${be.url}${be.predictPath})${LOG ? "  [logging on]" : ""}`);
}
