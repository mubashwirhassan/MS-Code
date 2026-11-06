import * as vscode from 'vscode';
import { ChatMessage, ExecutionMode, ToolCall, IProvider } from '../types';
import { agentToolSchemas, executeTool, ToolCtx } from './tools';

export interface AgentCallbacks {
  onDelta(text: string): void;
  onAssistant(text: string): void;
  onToolStart(name: string, args: Record<string, unknown>): void;
  onToolResult(name: string, ok: boolean, summary: string): void;
  onDone(final: string): void;
  onError(err: string): void;
}

export interface AgentDeps {
  provider: IProvider;
  model: string;
  baseUrl: string;
  apiKey: string;
  instructions: string;
  mode: ExecutionMode;
  toolCtx: ToolCtx;
}

function buildSystemPrompt(instructions: string, mode: ExecutionMode): string {
  return `You are MS Code, an elite autonomous software engineering agent operating inside VS Code.

MODES: current execution mode is "${mode}".
- auto: you run file edits and terminal commands yourself, without asking.
- Still, catastrophic operations (rm -rf /, disk format, git push --force, dropping databases, piping curl to sh) are hard-blocked by the runtime — never attempt them.

WORKFLOW:
1. Explore with read_file / list_dir / glob_search before changing anything.
2. Make changes with write_file / edit_file (exact unique old_text).
3. Verify with run_command (build/test/lint).
4. When finished, ALWAYS call attempt_completion with a concise summary.

RULES:
- Prefer edit_file over rewriting whole files.
- Keep commands non-interactive (no editors/prompts; use flags like -y, --no-input).
- One tool call at a time is fine; batch independent calls when possible.
- Never print API keys or secrets.

${instructions ? `USER INSTRUCTIONS (highest priority):\n${instructions}` : ''}`;
}

export class Agent {
  readonly ctrl = new AbortController();

  constructor(private deps: AgentDeps) {}

  abort(): void { this.ctrl.abort(); }

  async run(history: ChatMessage[], userInput: string, cb: AgentCallbacks): Promise<void> {
    const maxSteps = vscode.workspace.getConfiguration('mscode').get<number>('maxAgentSteps', 40);
    history.push({ role: 'user', content: userInput });

    try {
      for (let step = 0; step < maxSteps; step++) {
        if (this.ctrl.signal.aborted) { cb.onError('Stopped by user.'); return; }

        let text = '';
        const calls: ToolCall[] = [];
        let streamError: string | undefined;

        await this.deps.provider.stream({
          baseUrl: this.deps.baseUrl,
          apiKey: this.deps.apiKey,
          model: this.deps.model,
          systemPrompt: buildSystemPrompt(this.deps.instructions, this.deps.mode),
          messages: history,
          tools: agentToolSchemas,
          signal: this.ctrl.signal,
        }, {
          onText: t => { text += t; cb.onDelta(t); },
          onToolCall: c => calls.push(c),
          onDone: () => { /* noop */ },
        }).catch(e => { streamError = String(e?.message ?? e); });

        if (streamError) { cb.onError(streamError); return; }
        if (this.ctrl.signal.aborted) { cb.onError('Stopped by user.'); return; }

        history.push({
          role: 'assistant',
          content: text,
          ...(calls.length ? { toolCalls: calls } : {}),
        });
        if (text) { cb.onAssistant(text); }

        if (!calls.length) { cb.onDone(text); return; }

        let completed = false;
        for (const call of calls) {
          if (call.name === 'attempt_completion') {
            const res = await executeTool(call.name, call.args, this.deps.toolCtx);
            history.push({ role: 'tool', toolCallId: call.id, name: call.name, content: res.output });
            cb.onDone(res.output);
            completed = true;
            break;
          }
          cb.onToolStart(call.name, call.args);
          const res = await executeTool(call.name, call.args, this.deps.toolCtx);
          history.push({ role: 'tool', toolCallId: call.id, name: call.name, content: res.output });
          cb.onToolResult(call.name, res.ok, res.output.split('\n')[0].slice(0, 200));
          if (this.ctrl.signal.aborted) { cb.onError('Stopped by user.'); return; }
        }
        if (completed) { return; }
      }
      cb.onError('Max agent steps reached.');
    } catch (e: any) {
      cb.onError(String(e?.message ?? e));
    }
  }
}
