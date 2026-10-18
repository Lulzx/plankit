#!/usr/bin/env node
// Folder Chat: ask questions about any folder, answered with the user's own ChatGPT plan.
import { createServer } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { createPlanClient, openInBrowser, PlanError } from "plankit";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { port: { type: "string", default: "4321" }, "no-open": { type: "boolean", default: false } },
});
const ROOT = resolve(positionals[0] ?? ".");
const PORT = Number(values.port);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PAGE = fileURLToPath(new URL("./public/index.html", import.meta.url));

const plan = createPlanClient({
  appName: "Folder Chat",
  // Dev-only overrides for testing against a mock server.
  issuer: process.env.PLANKIT_ISSUER,
  apiBase: process.env.PLANKIT_API_BASE,
});

// ---- folder context ---------------------------------------------------------------------------

const TEXT_EXT = new Set(
  ".md .mdx .txt .rst .org .csv .tsv .json .jsonl .yaml .yml .toml .ini .xml .html .css .scss .js .jsx .ts .tsx .mjs .cjs .py .rb .go .rs .java .kt .swift .c .h .cpp .hpp .cs .php .sh .zsh .sql .graphql .proto .vue .svelte .tex".split(" "),
);
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".venv", "venv", "__pycache__", "target", ".cache", ".idea", ".vscode"]);
const MAX_FILE = 256 * 1024;
const BUDGET = 800_000; // characters, roughly 200k tokens

let context = { files: [], chars: 0, skipped: 0, text: "" };

async function loadFolder() {
  const files = [];
  let chars = 0;
  let skipped = 0;
  async function walk(dir) {
    for (const ent of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      // Skip hidden directories and anything that looks like a secrets file.
      if (ent.name.startsWith(".") && (ent.isDirectory() || ent.name.startsWith(".env"))) continue;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) await walk(full);
      } else if (ent.isFile() && TEXT_EXT.has(extname(ent.name).toLowerCase())) {
        const { size } = await stat(full);
        if (size > MAX_FILE || chars + size > BUDGET) {
          skipped++;
          continue;
        }
        const body = await readFile(full, "utf8");
        files.push({ path: relative(ROOT, full), body });
        chars += body.length;
      }
    }
  }
  await walk(ROOT);
  const text = files.map((f) => `<file path="${f.path}">\n${f.body}\n</file>`).join("\n\n");
  context = { files: files.map((f) => f.path), chars, skipped, text };
}

const instructions = () =>
  `You answer questions about the user's folder "${basename(ROOT)}". Its text files are below, each in a <file> tag.
Ground every answer in these files and cite paths in backticks, like \`notes/todo.md\`. If the files don't contain the answer, say so plainly.
Use short Markdown answers.\n\n${context.text}`;

// ---- http -------------------------------------------------------------------------------------

const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};
const errorBody = (e) =>
  e instanceof PlanError
    ? { code: e.code, message: e.message, recovery: e.recovery, requestId: e.requestId, manageUsageUrl: e.manageUsageUrl }
    : { code: "internal", message: String(e?.message ?? e), recovery: "none" };
const readJson = (req) =>
  new Promise((ok) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => {
      try {
        ok(JSON.parse(s || "{}"));
      } catch {
        ok({});
      }
    });
  });

async function state() {
  const s = await plan.status();
  return {
    folder: basename(ROOT),
    path: ROOT,
    files: context.files.length,
    chars: context.chars,
    skipped: context.skipped,
    account: s.active ? { email: s.active.email, name: s.active.name, signedIn: s.active.signedIn, planEnabled: s.active.planEnabled } : null,
  };
}

const routes = {
  "GET /": async (req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(await readFile(PAGE));
  },
  "GET /api/state": async (req, res) => send(res, 200, await state()),
  "POST /api/signin": async (req, res) => {
    const { consent } = await readJson(req);
    const active = (await plan.status()).active;
    // Reauthorize the saved registration when there is one; otherwise register this app.
    await plan.signIn({ account: active?.id, forceConsent: Boolean(consent) });
    send(res, 200, await state());
  },
  "POST /api/signout": async (req, res) => {
    const { revoked } = await plan.signOut();
    send(res, 200, { ...(await state()), revoked });
  },
  "POST /api/reload": async (req, res) => {
    await loadFolder();
    send(res, 200, await state());
  },
  "GET /api/models": async (req, res) => send(res, 200, await plan.models()),
  "POST /api/chat": async (req, res) => {
    const { model, messages } = await readJson(req);
    const ac = new AbortController();
    res.on("close", () => ac.abort());
    // Responses aren't stored server-side in this flow, so the whole history goes with each request.
    const stream = plan.streamText({ model, instructions: instructions(), input: messages }, { signal: ac.signal });
    let started = false;
    try {
      for await (const delta of stream) {
        if (!started) {
          res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
          started = true;
        }
        res.write(JSON.stringify({ d: delta }) + "\n");
      }
      if (!started) res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end(JSON.stringify({ done: true }) + "\n");
    } catch (e) {
      if (ac.signal.aborted) return;
      if (!started) return send(res, e?.status && e.status < 500 ? e.status : 502, errorBody(e));
      res.end(JSON.stringify({ error: errorBody(e) }) + "\n");
    }
  },
};

const server = createServer(async (req, res) => {
  // Only this page may drive the server: blocks DNS rebinding and cross-site POSTs.
  if (req.headers.host !== `127.0.0.1:${PORT}`) return send(res, 403, { code: "bad_host" });
  if (req.method !== "GET" && req.headers.origin !== ORIGIN) return send(res, 403, { code: "bad_origin" });
  const route = routes[`${req.method} ${new URL(req.url, ORIGIN).pathname}`];
  if (!route) return send(res, 404, { code: "not_found" });
  try {
    await route(req, res);
  } catch (e) {
    if (!res.headersSent) send(res, e instanceof PlanError && e.status && e.status < 500 ? e.status : 400, errorBody(e));
  }
});

await loadFolder();
server.listen(PORT, "127.0.0.1", async () => {
  console.log(`Folder Chat: ${ROOT}`);
  console.log(`${context.files.length} files loaded${context.skipped ? `, ${context.skipped} skipped (too large or over budget)` : ""}`);
  console.log(`Open ${ORIGIN}`);
  if (!values["no-open"]) await openInBrowser(ORIGIN);
});
