import type { ProviderId, ToolSpec } from '../../../shared/types';
import {
  splitToolResultImages,
  type ModelMessage,
  type Provider,
  type StreamEvent,
  type StreamRequest,
} from '../provider';

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[];
  tool_name?: string;
  tool_calls?: { function: { name: string; arguments: unknown } }[];
}

interface OllamaChunk {
  message?: { content?: string; thinking?: string; tool_calls?: OllamaMessage['tool_calls'] };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

/** Local models via Ollama. No credentials; the endpoint is configurable. */
export class OllamaProvider implements Provider {
  readonly id: ProviderId = 'ollama';
  readonly label = 'Ollama (local)';

  constructor(private readonly getBaseUrl: () => string) {}

  private base(): string {
    return (this.getBaseUrl() || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.base()}/api/tags`);
      if (!res.ok) return [];
      const body = (await res.json()) as { models?: { name: string }[] };
      return (body.models ?? []).map((m) => m.name);
    } catch {
      return [];
    }
  }

  supportsVision(model: string): boolean {
    return /llava|vision|llama3\.2-vision|qwen2?\.?5?-vl|gemma3/i.test(model);
  }

  async *stream(req: StreamRequest): AsyncGenerator<StreamEvent> {
    const res = await fetch(`${this.base()}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: req.signal,
      body: JSON.stringify({
        model: req.model,
        messages: toOllamaMessages(req.system, splitToolResultImages(req.messages)),
        stream: true,
        think: req.thinking || undefined,
        ...(req.tools.length ? { tools: toOllamaTools(req.tools) } : {}),
        options: { num_predict: req.maxTokens },
      }),
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `Ollama request failed (${res.status}). Is the server running at ${this.base()}? ${detail}`,
      );
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let stopReason = 'end_turn';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // NDJSON: one JSON object per line, with the last line possibly partial.
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let chunk: OllamaChunk;
        try {
          chunk = JSON.parse(line) as OllamaChunk;
        } catch {
          continue;
        }
        if (chunk.message?.thinking) yield { type: 'thinking', delta: chunk.message.thinking };
        if (chunk.message?.content) yield { type: 'text', delta: chunk.message.content };
        for (const call of chunk.message?.tool_calls ?? []) {
          stopReason = 'tool_use';
          yield {
            type: 'tool_use',
            id: `ollama_${Math.random().toString(36).slice(2)}`,
            name: call.function.name,
            input: call.function.arguments ?? {},
          };
        }
        if (chunk.done) {
          if (chunk.done_reason && chunk.done_reason !== 'stop') stopReason = chunk.done_reason;
          yield {
            type: 'usage',
            usage: {
              inputTokens: chunk.prompt_eval_count ?? 0,
              outputTokens: chunk.eval_count ?? 0,
            },
          };
        }
      }
    }

    yield { type: 'stop', reason: stopReason };
  }
}

function toOllamaTools(tools: ToolSpec[]) {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

function toOllamaMessages(system: string, messages: ModelMessage[]): OllamaMessage[] {
  const out: OllamaMessage[] = [{ role: 'system', content: system }];

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const text = msg.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
      const calls = msg.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => {
          const t = b as { name: string; input: unknown };
          return { function: { name: t.name, arguments: t.input ?? {} } };
        });
      if (!text && !calls.length) continue;
      out.push({ role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }

    for (const b of msg.content) {
      if (b.type === 'tool_result') {
        out.push({
          role: 'tool',
          tool_name: b.toolUseId,
          content: (b.isError ? `ERROR: ${b.content}` : b.content) || '(no output)',
        });
      }
    }

    const text = msg.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
    const images = msg.content
      .filter((b) => b.type === 'image')
      .map((b) => (b as { data: string }).data);
    if (text || images.length) {
      out.push({ role: 'user', content: text, ...(images.length ? { images } : {}) });
    }
  }

  return out;
}
