import type { ProviderId, TokenUsage, ToolSpec } from '../../shared/types';

/** Provider-neutral conversation model. Each backend adapts this to its wire format. */
export type ModelBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; signature?: string }
  | { type: 'image'; mediaType: string; data: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result';
      toolUseId: string;
      content: string;
      isError?: boolean;
      images?: { mediaType: string; data: string }[];
    };

export interface ModelMessage {
  role: 'user' | 'assistant';
  content: ModelBlock[];
}

export interface StreamRequest {
  model: string;
  system: string;
  messages: ModelMessage[];
  tools: ToolSpec[];
  maxTokens: number;
  /** Ask the backend to expose reasoning when it supports doing so. */
  thinking: boolean;
  signal: AbortSignal;
  /**
   * Stable id for the conversation. CLI backends keep their own server-side
   * session and use this to resume it instead of replaying `messages`.
   */
  conversationKey?: string;
}

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'stop'; reason: string };

export interface Provider {
  readonly id: ProviderId;
  readonly label: string;
  /** Models offered in the settings dropdown; the field stays free-text. */
  listModels(): Promise<string[]>;
  supportsVision(model: string): boolean;
  stream(req: StreamRequest): AsyncGenerator<StreamEvent, void, unknown>;
  /**
   * Present on backends that shell out to a locally installed agent CLI:
   * the resolved path, or null when the binary cannot be found.
   */
  readonly binaryPath?: string | null;
  /**
   * Total context window in tokens, when the backend has a small and knowable
   * one. Absent means "large enough not to plan around", which is true of the
   * hosted models and not true of a locally loaded 8k model — that one rejects
   * an ordinary page snapshot outright, so the agent has to fit the request to
   * it rather than discover the limit from a 400.
   */
  readonly contextTokens?: number;
}

export class MissingCredentialsError extends Error {
  constructor(provider: string, hint: string) {
    super(`No API key configured for ${provider}. ${hint}`);
    this.name = 'MissingCredentialsError';
  }
}

/**
 * Tool results can carry screenshots. Providers that cannot attach images to a
 * tool result (OpenAI, Ollama) call this to fold them into a following user
 * message instead of dropping them.
 */
export function splitToolResultImages(messages: ModelMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const msg of messages) {
    const trailing: ModelBlock[] = [];
    const content = msg.content.map((block) => {
      if (block.type === 'tool_result' && block.images?.length) {
        for (const img of block.images) {
          trailing.push({ type: 'image', mediaType: img.mediaType, data: img.data });
        }
        return { ...block, images: undefined };
      }
      return block;
    });
    out.push({ ...msg, content });
    if (trailing.length) {
      out.push({
        role: 'user',
        content: [
          { type: 'text', text: 'Screenshot from the tool call above:' },
          ...trailing,
        ],
      });
    }
  }
  return out;
}
