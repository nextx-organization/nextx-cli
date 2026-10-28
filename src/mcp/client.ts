// Minimal MCP client over Streamable HTTP (JSON-RPC 2.0): initialize, tools/list, tools/call.
// Responses may arrive as JSON or as an SSE stream carrying the JSON-RPC message.
import { fetch } from "undici";
import { context } from "../core/context.js";
import { CliError, Exit } from "../core/errors.js";
import { tr } from "../core/i18n.js";
import { errorFor, networkError, userAgent } from "../core/http.js";
import { VERSION } from "../core/version.js";
import { brand } from "../core/brand.js";
import { mcpToken, deleteGrant } from "../auth/mcp-oauth.js";

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}

export interface McpCallResult {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

const PROTOCOL = "2025-06-18";

export class McpClient {
  private sessionId?: string;
  private nextId = 1;
  private token?: string;
  private ready = false;

  /** `url`: MCP endpoint other than the hosted OAuth server (NextFarm API keys go through the gateway's /api/v1/mcp). */
  constructor(private readonly interactive: boolean, private readonly apiKey?: string, private readonly url?: string) {}

  private async rpc<T>(method: string, params?: unknown, notification = false): Promise<T> {
    const url = this.url ?? context().endpoints.mcp;
    this.token ??= this.apiKey ?? (await mcpToken({ interactive: this.interactive }));
    const id = notification ? undefined : this.nextId++;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "User-Agent": userAgent(),
      "MCP-Protocol-Version": PROTOCOL,
      Authorization: `Bearer ${this.token}`,
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    let res;
    try {
      res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", ...(id ? { id } : {}), method, ...(params ? { params } : {}) }) });
    } catch (e) {
      throw networkError(e, url);
    }
    if (res.status === 401 && !this.apiKey) {
      // Grant revoked or scopes changed: drop it so the next run asks again.
      deleteGrant();
      throw new CliError(tr("Quyền công cụ AI của CLI đã hết hoặc bị thu hồi.", "The CLI's AI tool access expired or was revoked."), Exit.auth, `${brand().bin} tools login`);
    }
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (notification) {
      await res.body?.cancel();
      return undefined as T;
    }
    const ct = res.headers.get("content-type") ?? "";
    let msg: { result?: T; error?: { code: number; message: string } } | undefined;
    if (ct.includes("text/event-stream")) {
      const text = await res.text();
      for (const frame of text.split("\n\n")) {
        const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
        if (!data) continue;
        const m = JSON.parse(data) as { id?: number; result?: T; error?: { code: number; message: string } };
        if (m.id === id) msg = m;
      }
    } else {
      const body = await res.json().catch(() => undefined);
      if (!res.ok) throw errorFor(res.status, body, res);
      msg = body as typeof msg;
    }
    if (!msg) throw new CliError(tr("Máy chủ MCP không trả lời.", "The MCP server did not answer."), Exit.general);
    if (msg.error) throw new CliError(msg.error.message, msg.error.code === -32602 ? Exit.usage : Exit.general);
    return msg.result as T;
  }

  async init(): Promise<void> {
    if (this.ready) return;
    await this.rpc("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: `${brand().bin}-cli`, version: VERSION } });
    await this.rpc("notifications/initialized", undefined, true);
    this.ready = true;
  }

  async listTools(): Promise<McpTool[]> {
    await this.init();
    const all: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.rpc<{ tools: McpTool[]; nextCursor?: string }>("tools/list", cursor ? { cursor } : {});
      all.push(...r.tools);
      cursor = r.nextCursor;
    } while (cursor);
    return all;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    await this.init();
    return this.rpc<McpCallResult>("tools/call", { name, arguments: args });
  }
}

/** Joins text content of a tool result; parses JSON when the text is JSON. */
export function resultValue(r: McpCallResult): unknown {
  if (r.structuredContent !== undefined) return r.structuredContent;
  const text = (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
