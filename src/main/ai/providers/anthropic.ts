import Anthropic from '@anthropic-ai/sdk';
import type { ProviderId } from '../../../shared/types';
import {
  MissingCredentialsError,
  type ModelBlock,
  type ModelMessage,
  type Provider,
  type StreamEvent,
  type StreamRequest,
} from '../provider';

/**
 * Models offered in the picker. The field is free-text, so a newer id typed by
 * hand still works; this list only seeds the dropdown.
 */
const MODELS = [
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-opus-4-8',
  'claude-haiku-4-5',
];

/** Models that take `thinking: {type:'adaptive'}` rather than a token budget. */
const ADAPTIVE_THINKING = /^claude-(opus-5|opus-4-8|opus-4-7|opus-4-6|sonnet-5|sonnet-4-6|fable-5)/;

export class AnthropicProvider implements Provider {
  readonly id: ProviderId = 'anthropic';
  readonly label = 'Anthropic (Claude)';

  constructor(
    private readonly getKey: () => string | null,
    private readonly getBaseUrl: () => string,
  ) {}

  private client(): Anthropic {
    const apiKey = this.getKey();
    if (!apiKey) {
      throw new MissingCredentialsError(
        'Anthropic',
        'Add one in Settings → Models, or set ANTHROPIC_API_KEY.',
      );
    }
    const baseURL = this.getBaseUrl();
    return new Anthropic({
      apiKey,
      ...(baseURL && baseURL !== 'https://api.anthropic.com' ? { baseURL } : {}),
    });
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await this.client().models.list({ limit: 40 });
      const ids = res.data.map((m) => m.id);
      // Keep the curated order first, then anything else the account can see.
      return [...MODELS.filter((m) => ids.includes(m)), ...ids.filter((i) => !MODELS.includes(i))];
    } catch {
      return MODELS;
    }
  }

  supportsVision(): boolean {
    return true;
  }

  async *stream(req: StreamRequest): AsyncGenerator<StreamEvent> {
    const client = this.client();
    const adaptive = ADAPTIVE_THINKING.test(req.model);

    const params: Anthropic.MessageStreamParams = {
      model: req.model,
      max_tokens: req.maxTokens,
      // The system prompt is stable across a session, so caching it keeps the
      // per-step cost of a long agent loop close to output-only.
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      messages: toAnthropicMessages(req.messages),
      ...(req.tools.length ? { tools: toAnthropicTools(req.tools) } : {}),
    };

    if (req.thinking && adaptive) {
      params.thinking = { type: 'adaptive', display: 'summarized' };
    }

    const stream = client.messages.stream(params, { signal: req.signal });

    for await (const event of stream) {
      switch (event.type) {
        case 'content_block_delta':
          if (event.delta.type === 'text_delta') {
            yield { type: 'text', delta: event.delta.text };
          } else if (event.delta.type === 'thinking_delta') {
            yield { type: 'thinking', delta: event.delta.thinking };
          }
          break;
        case 'message_delta':
          if (event.usage) {
            yield {
              type: 'usage',
              usage: {
                inputTokens: event.usage.input_tokens ?? 0,
                outputTokens: event.usage.output_tokens ?? 0,
                cacheReadTokens: event.usage.cache_read_input_tokens ?? 0,
                cacheWriteTokens: event.usage.cache_creation_input_tokens ?? 0,
              },
            };
          }
          break;
        default:
          break;
      }
    }

    // finalMessage() assembles streamed tool inputs for us — accumulating
    // input_json_delta by hand is the classic source of malformed tool args.
    const final = await stream.finalMessage();
    for (const block of final.content) {
      if (block.type === 'tool_use') {
        yield { type: 'tool_use', id: block.id, name: block.name, input: block.input };
      }
    }
    yield { type: 'stop', reason: final.stop_reason ?? 'end_turn' };
  }
}

function toAnthropicTools(tools: import('../../../shared/types').ToolSpec[]): Anthropic.ToolUnion[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));
}

function toAnthropicMessages(messages: ModelMessage[]): Anthropic.MessageParam[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content.map(toAnthropicBlock).filter(Boolean) as Anthropic.ContentBlockParam[],
  }));
}

function toAnthropicBlock(block: ModelBlock): Anthropic.ContentBlockParam | null {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'image':
      return {
        type: 'image',
        source: { type: 'base64', media_type: block.mediaType as 'image/png', data: block.data },
      };
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: (block.input ?? {}) as Record<string, unknown>,
      };
    case 'tool_result': {
      const content: Anthropic.ToolResultBlockParam['content'] = [
        { type: 'text', text: block.content || '(no output)' },
      ];
      for (const img of block.images ?? []) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType as 'image/png', data: img.data },
        });
      }
      return {
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        content,
        ...(block.isError ? { is_error: true } : {}),
      };
    }
    case 'thinking':
      // Thinking blocks are bound to the producing model and are only replayed
      // when we still hold the original signature; otherwise they are dropped.
      return block.signature
        ? { type: 'thinking', thinking: block.text, signature: block.signature }
        : null;
    default:
      return null;
  }
}
