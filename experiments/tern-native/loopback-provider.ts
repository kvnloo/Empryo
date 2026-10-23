/**
 * Deterministic, loopback-only OpenAI Chat Completions fixture for the real
 * Empryo Ollama provider and runChat path. No credentials or external calls.
 * Fixture output is synthetic; assertions must never treat it as LLM quality.
 */
import { appendFileSync } from "node:fs";

export const FIXTURE_MODEL = "trn3-fixture";

interface ChatMessage {
  role?: string;
  content?: unknown;
}

interface ChatRequest {
  model?: string;
  stream?: boolean;
  messages?: ChatMessage[];
  tools?: Array<{ function?: { name?: string } }>;
}

export interface FixtureServerOptions {
  port?: number;
  logPath?: string;
}

function stringContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) =>
      part && typeof part === "object" && "text" in part && typeof part.text === "string"
        ? part.text
        : "",
    )
    .join("");
}

function completion(req: ChatRequest): Response {
  const messages = req.messages ?? [];
  // Forge may inject a later user-role mode reminder; select the last test
  // marker so the actual submitted prompt drives the synthetic provider.
  const prompt = messages
    .filter((message) => message.role === "user")
    .map((message) => stringContent(message.content))
    .filter((text) => text.startsWith("typing ") || text.includes("TRN3_READ_FILE"))
    .at(-1) ?? "";
  const readFixture = prompt.includes("TRN3_READ_FILE");
  const toolResults = messages.filter((message) => message.role === "tool");
  const readAvailable = req.tools?.some((entry) => entry.function?.name === "read") ?? false;

  // A model-produced tool invocation: the actual Empryo tool validates and
  // reads fixture.txt inside the operator's isolated working directory.
  const callTool = readFixture && toolResults.length === 0 && readAvailable;
  const answer = readFixture
    ? "SYNTHETIC_READ_DONE"
    : "SYNTHETIC_ECHO:" + prompt;
  const id = "chatcmpl-trn3-loopback";
  const stamp = Math.floor(Date.now() / 1_000);
  const chunks: unknown[] = [
    {
      id, object: "chat.completion.chunk", created: stamp, model: FIXTURE_MODEL,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    },
  ];

  if (callTool) {
    chunks.push({
      id, object: "chat.completion.chunk", created: stamp, model: FIXTURE_MODEL,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0, id: "call-trn3-read", type: "function",
            function: { name: "read", arguments: JSON.stringify({ files: [{ path: "fixture.txt" }] }) },
          }],
        },
        finish_reason: null,
      }],
    });
  } else {
    // At least two genuine SSE text deltas, through the real AI SDK stream.
    const midpoint = Math.max(1, Math.floor(answer.length / 2));
    for (const text of [answer.slice(0, midpoint), answer.slice(midpoint)]) {
      if (!text) continue;
      chunks.push({
        id, object: "chat.completion.chunk", created: stamp, model: FIXTURE_MODEL,
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      });
    }
  }
  chunks.push({
    id, object: "chat.completion.chunk", created: stamp, model: FIXTURE_MODEL,
    choices: [{
      index: 0, delta: {}, finish_reason: callTool ? "tool_calls" : "stop",
    }],
  });
  const wire = [
    ...chunks.map((chunk) => "data: " + JSON.stringify(chunk) + "\\n\\n"),
    "data: [DONE]\\n\\n",
  ];
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const part = wire[index++];
      if (!part) {
        controller.close();
        return;
      }
      if (index > 1) await Bun.sleep(12);
      controller.enqueue(new TextEncoder().encode(part));
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

export function startLoopbackProvider(options: FixtureServerOptions = {}): ReturnType<typeof Bun.serve> {
  const host = "127.0.0.1";
  return Bun.serve({
    hostname: host,
    port: options.port ?? 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/api/tags") {
        return Response.json({ models: [{ name: FIXTURE_MODEL }] });
      }
      if (request.method === "GET" && url.pathname === "/v1/models") {
        return Response.json({
          object: "list",
          data: [{ id: FIXTURE_MODEL, object: "model", owned_by: "trn3-synthetic-fixture" }],
        });
      }
      if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
        return new Response("Not Found", { status: 404 });
      }
      let body: ChatRequest;
      try {
        body = (await request.json()) as ChatRequest;
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }
      if (!Array.isArray(body.messages) || body.model !== FIXTURE_MODEL || body.stream !== true) {
        return new Response("Unsupported synthetic fixture request", { status: 400 });
      }
      if (options.logPath) {
        appendFileSync(options.logPath, JSON.stringify({
          model: body.model,
          messages: body.messages,
          offeredTools: body.tools?.map((tool) => tool.function?.name) ?? [],
        }) + "\n");
      }
      return completion(body);
    },
  });
}

if (import.meta.main) {
  const port = Number(process.env.TRN3_PORT ?? "11439");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("TRN3_PORT must be an integer from 1 to 65535");
  }
  const server = startLoopbackProvider({
    port,
    logPath: process.env.TRN3_REQUEST_LOG,
  });
  process.stdout.write("TRN3 synthetic fixture listening at " + server.url + "\n");
}
