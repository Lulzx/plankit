import { PlanError } from "./errors.js";

export type InputItem = { role?: string; type?: string; content?: unknown; [k: string]: unknown };

export interface ResponseParams {
  model: string;
  /** A string becomes a single user message. */
  input: string | InputItem[];
  instructions?: string;
  tools?: unknown[];
  reasoning?: unknown;
  text?: unknown;
  [k: string]: unknown;
}

export interface StreamEvent {
  type: string;
  [k: string]: any;
}

/** Fields the plan-usage route rejects; stripped before sending. */
export const UNSUPPORTED_FIELDS = [
  "background",
  "conversation",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "prompt",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
  "previous_response_id",
];

/** Shape a request for the plan-usage route: store=false, stream=true, no system items, no unsupported fields. */
export function buildBody(params: ResponseParams, warn: (msg: string) => void): Record<string, unknown> {
  const body: Record<string, unknown> = { ...params };
  delete body.signal;
  for (const f of UNSUPPORTED_FIELDS) {
    if (f in body) {
      warn(`plankit: dropped unsupported field "${f}" (not allowed when using a ChatGPT plan)`);
      delete body[f];
    }
  }
  const input = typeof params.input === "string" ? [{ role: "user", content: params.input }] : params.input;
  body.input = input.map((item) =>
    item.role === "system" && (item.type === undefined || item.type === "message") ? { ...item, role: "developer" } : item,
  );
  body.store = false;
  body.stream = true;
  return body;
}

/** Parse a `text/event-stream` body into JSON events. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const decoder = new TextDecoder();
  let buf = "";
  const reader = body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buf += decoder.decode(value, { stream: !done });
      let idx: number;
      while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx).replace(/^\r?\n\r?\n/, "");
        const ev = parseChunk(chunk);
        if (ev) yield ev;
      }
      if (done) break;
    }
    const tail = parseChunk(buf);
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function parseChunk(chunk: string): StreamEvent | undefined {
  const data = chunk
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).replace(/^ /, ""))
    .join("\n");
  if (!data || data === "[DONE]") return undefined;
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

/**
 * Pass events through until a terminal event. Throws PlanError on `response.failed`, `response.incomplete`,
 * `error`, or a stream that ends without `response.completed` (usage-limit errors can arrive mid-stream).
 */
export async function* checkedEvents(events: AsyncIterable<StreamEvent>, requestId?: string): AsyncGenerator<StreamEvent> {
  for await (const ev of events) {
    if (ev.type === "response.failed") {
      const e = ev.response?.error ?? {};
      throw new PlanError(e.code ?? "response_failed", e.message ?? "Response failed", { requestId, param: e.param });
    }
    if (ev.type === "error") {
      const e = ev.error ?? ev;
      throw new PlanError(e.code ?? "stream_error", e.message ?? "Stream error", { requestId, param: e.param });
    }
    if (ev.type === "response.incomplete") {
      const reason = ev.response?.incomplete_details?.reason ?? "unknown";
      throw new PlanError("response_incomplete", `Response incomplete: ${reason}`, { requestId });
    }
    yield ev;
    if (ev.type === "response.completed") return;
  }
  throw new PlanError("stream_interrupted", "Stream ended before response.completed", { requestId, recovery: "retry_later" });
}
