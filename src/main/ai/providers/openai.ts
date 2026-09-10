import OpenAI from 'openai';
import type { ProviderId, ToolSpec } from '../../../shared/types';
import {
  MissingCredentialsError,
  splitToolResultImages,
  type ModelMessage,
  type Provider,
  type StreamEvent,
  type StreamRequest,
} from '../provider';

const MODELS = ['gpt-5.1', 'gpt-5.1-codex', 'gpt-5', 'gpt-4.1', 'o4-mini'];

/**
 * OpenAI-compatible backend — also the path for Codex-family models and for any
 * third-party endpoint that speaks the Chat Completions API (set a custom base
 * URL in settings).
 */
export class OpenAIProvider implements Provider {
  readonly id: ProviderId = 'openai';
  readonly label = 'OpenAI / Codex';

  constructor(
    private readonly getKey: () => string | null,
    private readonly getBaseUrl: () => string,
  ) {}

  private client(): OpenAI {
    const apiKey = this.getKey();
    if (!apiKey) {
      throw new MissingCredentialsError(
        'OpenAI',
        'Add one in Settings → Models, or set OPENAI_API_KEY.',
      );
    }
    return new OpenAI({ apiKey, baseURL: this.getBaseUrl() || undefined });
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await this.client().models.list();
      const ids = res.data.map((m) => m.id).filter((id) => /^(gpt|o\d|chatgpt)/.test(id)).sort();
      return [...MODELS.filter((m) => ids.includes(m)), ...ids.filter((i) => !MODELS.includes(i))];
    } catch {
      return MODELS;
    }
  }

  supportsVision(model: string): boolean {
    return /gpt-5|gpt-4|o3|o4/.test(model);
  }

  async *stream(req: StreamRequest): AsyncGenerator<StreamEvent> {
    yield* streamChatCompletions(this.client(), req);
  }
}

/**
 * The Chat Completions streaming loop, shared by every backend that speaks it.
 *
 * OpenAI's wire format is the lingua franca for local servers too — llama.cpp's
 * `llama-server` implements it, tool calls included — so the local backend is
 * this same loop pointed at a different base URL rather than a second
 * translation layer to keep in step.
 */
export async function* streamChatCompletions(
  client: OpenAI,
  req: StreamRequest,
): AsyncGenerator<StreamEvent> {
  {
    const messages = toOpenAIMessages(req.system, splitToolResultImages(req.messages));

    const stream = await client.chat.completions.create(
      {
        model: req.model,
        messages,
        max_completion_tokens: req.maxTokens,
        stream: true,
        stream_options: { include_usage: true },
        ...(req.tools.length ? { tools: toOpenAITools(req.tools), tool_choice: 'auto' as const } : {}),
      },
      { signal: req.signal },
    );

    // Tool calls stream as fragments keyed by index; assemble before emitting.
    const pending = new Map<number, { id: string; name: string; args: string }>();
    let stopReason = 'end_turn';

    for await (const chunk of stream) {
      if (chunk.usage) {
        yield {
          type: 'usage',
          usage: {
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
            cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
          },
        };
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;

      const delta = choice.delta;
      if (delta?.content) yield { type: 'text', delta: delta.content };

      // Reasoning summaries are exposed by some models under a non-standard key.
      const reasoning = (delta as { reasoning_content?: string } | undefined)?.reasoning_content;
      if (reasoning) yield { type: 'thinking', delta: reasoning };

      for (const tc of delta?.tool_calls ?? []) {
        const slot = pending.get(tc.index) ?? { id: '', name: '', args: '' };
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
        pending.set(tc.index, slot);
      }

      if (choice.finish_reason) {
        stopReason = choice.finish_reason === 'tool_calls' ? 'tool_use' : choice.finish_reason;
      }
    }

    for (const call of pending.values()) {
      if (!call.name) continue;
      yield {
        type: 'tool_use',
        id: call.id || `call_${Math.random().toString(36).slice(2)}`,
        name: call.name,
        input: safeParse(call.args),
      };
    }
    yield { type: 'stop', reason: stopReason };
  }
}

function safeParse(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // A truncated or subtly malformed argument string is better surfaced to the
    // model as a tool error than crashing the turn.
    return { __parse_error: raw };
  }
}

function toOpenAITools(tools: ToolSpec[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as Record<string, unknown>,
    },
  }));
}

function toOpenAIMessages(
  system: string,
  messages: ModelMessage[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: system },
  ];

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const text = msg.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('');
      const toolCalls = msg.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => {
          const t = b as { id: string; name: string; input: unknown };
          return {
            id: t.id,
            type: 'function' as const,
            function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) },
          };
        });
      if (!text && !toolCalls.length) continue;
      out.push({
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    // A user turn may hold tool results, which OpenAI models as separate
    // `tool` messages that must precede any ordinary user content.
    const toolResults = msg.content.filter((b) => b.type === 'tool_result');
    for (const b of toolResults) {
      const t = b as { toolUseId: string; content: string; isError?: boolean };
      out.push({
        role: 'tool',
        tool_call_id: t.toolUseId,
        content: (t.isError ? `ERROR: ${t.content}` : t.content) || '(no output)',
      });
    }

    const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
    for (const b of msg.content) {
      if (b.type === 'text' && b.text) parts.push({ type: 'text', text: b.text });
      if (b.type === 'image') {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${b.mediaType};base64,${b.data}` },
        });
      }
    }
    if (parts.length) out.push({ role: 'user', content: parts });
  }

  return out;
}
