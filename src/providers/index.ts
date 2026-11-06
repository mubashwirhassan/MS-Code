import { ProviderKind } from '../types';
import { OpenAIProvider } from './openai';
import { AnthropicProvider } from './anthropic';
import { GeminiProvider } from './gemini';

export const DEFAULT_BASE_URLS: Record<ProviderKind, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
};

export function makeProvider(kind: ProviderKind) {
  switch (kind) {
    case 'anthropic': return new AnthropicProvider();
    case 'gemini': return new GeminiProvider();
    default: return new OpenAIProvider();
  }
}
