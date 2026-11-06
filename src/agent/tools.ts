import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ExecutionMode, ToolSchema } from '../types';
import { classifyCommand } from '../security';

const pexec = promisify(exec);

export interface ToolCtx {
  rootPath: string | undefined;
  mode: ExecutionMode;
  confirm(cmd: string): Promise<boolean>;
}

export const agentToolSchemas: ToolSchema[] = [
  {
    name: 'read_file',
    description: 'Read a file from the workspace. Returns file content with line numbers.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Relative or absolute file path' }, start_line: { type: 'number' }, end_line: { type: 'number' } }, required: ['path'] },
  },
  {
    name: 'write_file',
    description: 'Create a new file or fully overwrite an existing one.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  },
  {
    name: 'edit_file',
    description: 'Edit a file by exact string replacement. old_text must match exactly and appear exactly once.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] },
  },
  {
    name: 'list_dir',
    description: 'List entries of a directory.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Directory path, default workspace root' } }, required: [] },
  },
  {
    name: 'glob_search',
    description: 'Search files in workspace by glob pattern, e.g. "**/*.ts".',
    parameters: { type: 'object', properties: { pattern: { type: 'string' }, query: { type: 'string', description: 'Optional: only return files containing this text' } }, required: ['pattern'] },
  },
  {
    name: 'run_command',
    description: 'Run a shell command in the workspace root. Returns stdout/stderr.',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
  {
    name: 'attempt_completion',
    description: 'Present the final result to the user once the task is complete. Always call this when done.',
    parameters: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] },
  },
];

function resolvePath(p: string, ctx: ToolCtx): string {
  const allowOutside = vscode.workspace.getConfiguration('mscode').get<boolean>('allowOutsideWorkspace', false);
  const abs = path.isAbsolute(p) ? p : (ctx.rootPath ? path.join(ctx.rootPath, p) : path.resolve(p));
  if (ctx.rootPath && !allowOutside) {
    const rel = path.relative(ctx.rootPath, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error('Path is outside the workspace (blocked by security policy).');
    }
  }
  return path.normalize(abs);
}

export interface ToolResult { ok: boolean; output: string; }

export async function executeTool(name: string, args: any, ctx: ToolCtx): Promise<ToolResult> {
  try {
    switch (name) {
      case 'read_file': return await toolReadFile(args, ctx);
      case 'write_file': return await toolWriteFile(args, ctx);
      case 'edit_file': return await toolEditFile(args, ctx);
      case 'list_dir': return await toolListDir(args, ctx);
      case 'glob_search': return await toolGlobSearch(args, ctx);
      case 'run_command': return await toolRunCommand(args, ctx);
      case 'attempt_completion': return { ok: true, output: String(args.result ?? 'Done.') };
      default: return { ok: false, output: `Unknown tool: ${name}` };
    }
  } catch (e: any) {
    return { ok: false, output: `ERROR: ${e.message ?? String(e)}` };
  }
}

async function toolReadFile(args: any, ctx: ToolCtx): Promise<ToolResult> {
  const abs = resolvePath(String(args.path), ctx);
  const raw = await fs.readFile(abs, 'utf8');
  const lines = raw.split('\n');
  const start = Math.max(1, Number(args.start_line ?? 1));
  const end = Math.min(lines.length, Number(args.end_line ?? lines.length));
  const numbered = lines.slice(start - 1, end).map((l, i) => `${start + i} | ${l}`).join('\n');
  await showInEditor(abs);
  return { ok: true, output: numbered.slice(0, 40000) };
}

async function toolWriteFile(args: any, ctx: ToolCtx): Promise<ToolResult> {
  const abs = resolvePath(String(args.path), ctx);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, String(args.content ?? ''), 'utf8');
  await showInEditor(abs);
  return { ok: true, output: `Wrote ${args.path} (${String(args.content ?? '').length} chars).` };
}

async function toolEditFile(args: any, ctx: ToolCtx): Promise<ToolResult> {
  const abs = resolvePath(String(args.path), ctx);
  const oldText = String(args.old_text ?? '');
  const raw = await fs.readFile(abs, 'utf8');
  const count = raw.split(oldText).length - 1;
  if (count === 0) { return { ok: false, output: 'old_text not found in file.' }; }
  if (count > 1) { return { ok: false, output: `old_text found ${count} times; must be unique. Provide more context.` }; }
  const updated = raw.replace(oldText, String(args.new_text ?? ''));
  await fs.writeFile(abs, updated, 'utf8');
  await showInEditor(abs);
  return { ok: true, output: `Edited ${args.path} successfully.` };
}

async function toolListDir(args: any, ctx: ToolCtx): Promise<ToolResult> {
  const dir = args.path ? resolvePath(String(args.path), ctx) : ctx.rootPath ?? process.cwd();
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out = entries
    .map(e => `${e.isDirectory() ? '[dir]' : '[file]'} ${e.name}`)
    .join('\n');
  return { ok: true, output: `${dir}\n${out}` };
}

async function toolGlobSearch(args: any, ctx: ToolCtx): Promise<ToolResult> {
  if (!vscode.workspace.workspaceFolders?.length) { return { ok: false, output: 'No workspace open.' }; }
  const uris = await vscode.workspace.findFiles(String(args.pattern), '**/node_modules/**', 200);
  let files = uris.map(u => vscode.workspace.asRelativePath(u));
  if (args.query) {
    const q = String(args.query).toLowerCase();
    const kept: string[] = [];
    for (const f of files.slice(0, 60)) {
      try {
        const c = (await fs.readFile(path.join(ctx.rootPath!, f), 'utf8')).toLowerCase();
        if (c.includes(q)) { kept.push(f); }
      } catch { /* ignore */ }
    }
    files = kept;
  }
  return { ok: true, output: files.join('\n') || 'No matches.' };
}

async function toolRunCommand(args: any, ctx: ToolCtx): Promise<ToolResult> {
  const cmd = String(args.command ?? '');
  const verdict = classifyCommand(cmd, ctx.mode);
  if (verdict === 'deny') {
    return { ok: false, output: `⛔ Command blocked by MS Code security policy: ${cmd}` };
  }
  if (verdict === 'confirm') {
    const allowed = await ctx.confirm(cmd);
    if (!allowed) { return { ok: false, output: '⛔ User denied this command.' }; }
  }
  const timeout = vscode.workspace.getConfiguration('mscode').get<number>('commandTimeoutMs', 120000);
  try {
    const { stdout, stderr } = await pexec(cmd, {
      cwd: ctx.rootPath ?? process.cwd(),
      timeout, maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    const out = `exit 0\nSTDOUT:\n${stdout.slice(0, 20000)}\n${stderr ? 'STDERR:\n' + stderr.slice(0, 8000) : ''}`;
    return { ok: true, output: out.trim() };
  } catch (e: any) {
    const out = `exit ${e.code ?? '?'}\nSTDOUT:\n${(e.stdout ?? '').slice(0, 20000)}\nSTDERR:\n${(e.stderr ?? e.message).slice(0, 8000)}`;
    return { ok: false, output: out };
  }
}

async function showInEditor(abs: string): Promise<void> {
  try {
    const doc = await vscode.workspace.openTextDocument(abs);
    await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
  } catch { /* non-fatal */ }
}
