export async function readSSE(res: Response, onData: (payload: string) => void): Promise<void> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) { break; }
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim();
        if (payload && payload !== '[DONE]') { onData(payload); }
      }
    }
  }
}

export function trimSlash(u: string): string { return u.replace(/\/+$/, ''); }

export async function assertOk(res: Response, label: string): Promise<void> {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${label} failed: HTTP ${res.status} ${body.slice(0, 300)}`);
  }
}
