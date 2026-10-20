/**
 * Språkmodell via adapter. Just nu Anthropic (Messages API, strömmat). Hos kunden kan
 * samma yta pekas mot Bedrock/Azure; `none` ger ett tydligt fel i stället för att gissa.
 */
import type { Config } from "../config.js";

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LlmRequest {
  system?: string;
  messages: LlmMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Snabb modell (frågeomskrivning, berikning) i stället för huvudmodellen. */
  fast?: boolean;
}

export interface Llm {
  readonly enabled: boolean;
  readonly model: string;
  complete(req: LlmRequest): Promise<string>;
  /** Strömmar textbitar; returnerar hela texten när strömmen är slut. */
  stream(req: LlmRequest, onText: (chunk: string) => void): Promise<string>;
}

export function createLlm(cfg: Pick<Config, "LLM_PROVIDER" | "ANTHROPIC_API_KEY" | "LLM_MODEL" | "LLM_FAST_MODEL">): Llm {
  if (cfg.LLM_PROVIDER === "anthropic" && cfg.ANTHROPIC_API_KEY) return anthropicLlm(cfg.ANTHROPIC_API_KEY, cfg.LLM_MODEL, cfg.LLM_FAST_MODEL);
  return {
    enabled: false,
    model: "none",
    complete: async () => {
      throw new Error("Ingen språkmodell är konfigurerad (LLM_PROVIDER).");
    },
    stream: async () => {
      throw new Error("Ingen språkmodell är konfigurerad (LLM_PROVIDER).");
    },
  };
}

function anthropicLlm(apiKey: string, model: string, fastModel: string): Llm {
  const headers = { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  const body = (req: LlmRequest, stream: boolean) =>
    JSON.stringify({
      model: req.fast ? fastModel : model,
      max_tokens: req.maxTokens ?? 4096,
      temperature: req.temperature ?? 0.2,
      system: req.system,
      messages: req.messages,
      stream,
    });
  return {
    enabled: true,
    model,
    async complete(req) {
      const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: body(req, false) });
      if (!res.ok) throw new Error(`Anthropic svarade ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = (await res.json()) as { content: { type: string; text?: string }[] };
      return data.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
    },
    async stream(req, onText) {
      const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: body(req, true) });
      if (!res.ok || !res.body) throw new Error(`Anthropic svarade ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let full = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const evt = JSON.parse(line.slice(5)) as { type: string; delta?: { type: string; text?: string } };
          if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta" && evt.delta.text) {
            full += evt.delta.text;
            onText(evt.delta.text);
          }
        }
      }
      return full;
    },
  };
}
