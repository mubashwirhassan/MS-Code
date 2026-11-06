import { IProvider, StreamHandlers, StreamOpts } from '../types';
import { assertOk, readSSE, trimSlash } from './sse';
import { safeParse } from './openai';

export class GeminiProvider implements IProvider {

  async listModels(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<string[]> {
    const res = await fetch(`${trimSlash(baseUrl)}/v1beta/models?pageSize=200`, {
      headers: { 'x-goog-api-key': apiKey }, signal,
    });
    await assertOk(res, 'Listing Gemini models');
    const j: any = await res.json();
    return (j.models ?? [])
      .filter((m: any) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
      .map((m: any) => String(m.name).replace(/^models\//, ''))
      .sort();
  }

  async stream(opts: StreamOpts, h: StreamHandlers): Promise<void> {
    const contents: any[] = [];
    for (const m of opts.messages) {
      if (m.role === 'user') { contents.push({ role: 'user', parts: [{ text: m.content }] }); }
      else if (m.role === 'assistant') {
        const parts: any[] = [];
        if (m.content) { parts.push({ text: m.content }); }
        for (const t of m.toolCalls ?? []) {
          parts.push({ functionCall: { name: t.name, args: t.args } });
        }
        contents.push({ role: 'model', parts: parts.length ? parts : [{ text: '' }] });
      } else {
        contents.push({
          role: 'user',
          parts: [{ functionResponse: { name: m.name, response: { output: m.content } } }],
        });
      }
    }
    const body = {
      contents,
      systemInstruction: { parts: [{ text: opts.systemPrompt }] },
      tools: [{
        functionDeclarations: opts.tools.map(t => ({
          name: t.name, description: t.description, parameters: t.parameters,
        })),
      }],
    };
    const url = `${trimSlash(opts.baseUrl)}/v1beta/models/${opts.model}:streamGenerateContent?alt=sse`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': opts.apiKey },
      body: JSON.stringify(body), signal: opts.signal,
    });
    await assertOk(res, 'Gemini stream');

    let counter = 0;
    let stop = '';
    await readSSE(res, payload => {
      const ev: any = JSON.parse(payload);
      const parts = ev.candidates?.[0]?.content?.parts ?? [];
      for (const p of parts) {
        if (typeof p.text === 'string') { h.onText(p.text); }
        if (p.functionCall) {
          counter++;
          h.onToolCall({
            id: `gem_${counter}_${Date.now()}`,
            name: p.functionCall.name,
            args: p.functionCall.args ?? safeParse(''),
          });
        }
      }
      if (ev.candidates?.[0]?.finishReason) { stop = ev.candidates[0].finishReason; }
    });
    h.onDone(stop || 'STOP');
  }
}
