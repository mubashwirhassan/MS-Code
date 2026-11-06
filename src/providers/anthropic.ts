import { IProvider, StreamHandlers, StreamOpts } from '../types';
import { assertOk, readSSE, trimSlash } from './sse';

interface ToolBuf { id: string; name: string; json: string; }

export class AnthropicProvider implements IProvider {

  async listModels(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<string[]> {
    const res = await fetch(`${trimSlash(baseUrl)}/v1/models?limit=100`, {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, signal,
    });
    await assertOk(res, 'Listing Anthropic models');
    const j: any = await res.json();
    return (j.data ?? []).map((m: any) => m.id).sort();
  }

  async stream(opts: StreamOpts, h: StreamHandlers): Promise<void> {
    const msgs: any[] = [];
    for (const m of opts.messages) {
      if (m.role === 'user') { msgs.push({ role: 'user', content: [{ type: 'text', text: m.content }] }); }
      else if (m.role === 'assistant') {
        const blocks: any[] = m.content ? [{ type: 'text', text: m.content }] : [];
        for (const t of m.toolCalls ?? []) {
          blocks.push({ type: 'tool_use', id: t.id, name: t.name, input: t.args });
        }
        msgs.push({ role: 'assistant', content: blocks });
      } else {
        msgs.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }],
        });
      }
    }
    const body = {
      model: opts.model, max_tokens: 8192, system: opts.systemPrompt, messages: msgs, stream: true,
      tools: opts.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })),
    };
    const res = await fetch(`${trimSlash(opts.baseUrl)}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': opts.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body), signal: opts.signal,
    });
    await assertOk(res, 'Anthropic stream');

    const bufs = new Map<number, ToolBuf>();
    let stop = '';
    await readSSE(res, payload => {
      const ev: any = JSON.parse(payload);
      switch (ev.type) {
        case 'content_block_start':
          if (ev.content_block?.type === 'tool_use') {
            bufs.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name, json: '' });
          }
          break;
        case 'content_block_delta':
          if (ev.delta?.type === 'text_delta') { h.onText(ev.delta.text); }
          if (ev.delta?.type === 'input_json_delta') {
            const b = bufs.get(ev.index); if (b) { b.json += ev.delta.partial_json; }
          }
          break;
        case 'message_delta':
          stop = ev.delta?.stop_reason ?? stop;
          break;
      }
    });
    for (const [, b] of [...bufs.entries()].sort((a, b2) => a[0] - b2[0])) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(b.json || '{}'); } catch { args = { _raw: b.json }; }
      h.onToolCall({ id: b.id, name: b.name, args });
    }
    h.onDone(stop || 'end_turn');
  }
}
