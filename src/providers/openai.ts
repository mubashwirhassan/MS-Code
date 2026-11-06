import { ChatMessage, IProvider, StreamHandlers, StreamOpts } from '../types';
import { assertOk, readSSE, trimSlash } from './sse';

interface OAIRecord { id: string; name: string; args: string; }

export function safeParse(s: string): Record<string, unknown> {
  try { return JSON.parse(s || '{}'); } catch { return { _raw: s }; }
}

export class OpenAIProvider implements IProvider {

  async listModels(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<string[]> {
    const res = await fetch(`${trimSlash(baseUrl)}/models`, {
      headers: { 'Authorization': `Bearer ${apiKey}` }, signal,
    });
    await assertOk(res, 'Listing models');
    const j: any = await res.json();
    return (j.data ?? []).map((m: any) => m.id).sort();
  }

  async stream(opts: StreamOpts, h: StreamHandlers): Promise<void> {
    const msgs: any[] = [{ role: 'system', content: opts.systemPrompt }];
    for (const m of opts.messages) {
      if (m.role === 'user') { msgs.push({ role: 'user', content: m.content }); }
      else if (m.role === 'assistant') {
        const out: any = { role: 'assistant', content: m.content || '' };
        if (m.toolCalls?.length) {
          out.tool_calls = m.toolCalls.map(t => ({
            id: t.id, type: 'function',
            function: { name: t.name, arguments: JSON.stringify(t.args) },
          }));
        }
        msgs.push(out);
      } else {
        msgs.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
      }
    }
    const body = {
      model: opts.model, messages: msgs, stream: true,
      tools: opts.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
    };
    const res = await fetch(`${trimSlash(opts.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${opts.apiKey}` },
      body: JSON.stringify(body), signal: opts.signal,
    });
    await assertOk(res, 'OpenAI-compatible stream');

    const calls = new Map<number, OAIRecord>();
    let stop = '';
    await readSSE(res, payload => {
      const ev: any = JSON.parse(payload);
      if (ev.choices?.[0]?.delta?.content) { h.onText(ev.choices[0].delta.content); }
      for (const tc of ev.choices?.[0]?.delta?.tool_calls ?? []) {
        const cur = calls.get(tc.index) ?? { id: '', name: '', args: '' };
        if (tc.id) { cur.id = tc.id; }
        if (tc.function?.name) { cur.name = tc.function.name; }
        if (tc.function?.arguments) { cur.args += tc.function.arguments; }
        calls.set(tc.index, cur);
      }
      if (ev.choices?.[0]?.finish_reason) { stop = ev.choices[0].finish_reason; }
    });
    for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      h.onToolCall({ id: c.id || `oai_${Math.random().toString(36).slice(2)}`, name: c.name, args: safeParse(c.args) });
    }
    h.onDone(stop || 'stop');
  }
}
