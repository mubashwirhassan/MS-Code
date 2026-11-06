import * as vscode from 'vscode';
import { ChatMessage, ExecutionMode, ProviderConfig, ProviderKind } from '../types';
import { makeProvider, DEFAULT_BASE_URLS } from '../providers';
import { Agent } from '../agent/agent';
import { ToolCtx } from '../agent/tools';

interface TestResult { ok: boolean; models?: string[]; error?: string; }

export class MSCodeView implements vscode.WebviewViewProvider {
  public static readonly viewId = 'mscode.chatView';
  private view?: vscode.WebviewView;
  private agent?: Agent;
  private history: ChatMessage[] = [];
  private providers: ProviderConfig[] = [];
  private activeProviderId?: string;
  private instructions = '';
  private pendingConfirms = new Map<string, { resolve: (v: boolean) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.providers = ctx.globalState.get<ProviderConfig[]>('mscode.providers', []);
    this.activeProviderId = ctx.globalState.get<string>('mscode.activeProvider');
    this.instructions = ctx.globalState.get<string>('mscode.instructions', '');
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.getHtml(view.webview);
    view.webview.onDidReceiveMessage(m => this.onMessage(m));
    this.pushState();
  }

  private mode(): ExecutionMode {
    return vscode.workspace.getConfiguration('mscode').get<ExecutionMode>('executionMode', 'auto');
  }

  private rootPath(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private async onMessage(m: any): Promise<void> {
    switch (m.type) {
      case 'send': return this.handleSend(m.text);
      case 'stop': this.agent?.abort(); return;
      case 'setMode':
        await vscode.workspace.getConfiguration('mscode').update('executionMode', m.mode, vscode.ConfigurationTarget.Global);
        return this.pushState();
      case 'setInstructions':
        this.instructions = String(m.text ?? '');
        await this.ctx.globalState.update('mscode.instructions', this.instructions);
        return;
      case 'setProvider':
        this.activeProviderId = String(m.id);
        await this.ctx.globalState.update('mscode.activeProvider', this.activeProviderId);
        return this.pushState();
      case 'setModel': {
        const p = this.providers.find(x => x.id === m.id);
        if (p) {
          p.defaultModel = String(m.model);
          await this.ctx.globalState.update('mscode.providers', this.providers);
          this.pushState();
        }
        return;
      }
      case 'testProvider': {
        const result = await this.testProvider(m.kind, m.baseUrl, m.apiKey);
        return this.post({ type: 'testResult', reqId: m.reqId, ...result });
      }
      case 'saveProvider': return this.saveProvider(m.label, m.kind, m.baseUrl, m.apiKey, m.models);
      case 'removeProvider': return this.removeProvider(m.id);
      case 'clearChat': this.history = []; return this.post({ type: 'cleared' });
      case 'confirm.response': {
        const entry = this.pendingConfirms.get(m.id);
        if (entry) {
          clearTimeout(entry.timer);
          this.pendingConfirms.delete(m.id);
          entry.resolve(!!m.approved);
        }
        return;
      }
    }
  }

  private async testProvider(kind: ProviderKind, baseUrl: string, apiKey: string): Promise<TestResult> {
    try {
      const models = await makeProvider(kind).listModels(baseUrl.trim(), apiKey.trim());
      return { ok: true, models };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  }

  private async saveProvider(label: string, kind: ProviderKind, baseUrl: string, apiKey: string, models: string[]): Promise<void> {
    const id = `p_${Date.now().toString(36)}`;
    const cfg: ProviderConfig = {
      id, label: label.trim() || kind, kind,
      baseUrl: baseUrl.trim() || DEFAULT_BASE_URLS[kind],
      models: models?.length ? models : [],
      defaultModel: models?.[0],
    };
    await this.ctx.secrets.store(`mscode.key.${id}`, apiKey.trim());
    this.providers.push(cfg);
    this.activeProviderId = id;
    await this.ctx.globalState.update('mscode.providers', this.providers);
    await this.ctx.globalState.update('mscode.activeProvider', id);
    this.pushState();
  }

  private async removeProvider(id: string): Promise<void> {
    this.providers = this.providers.filter(p => p.id !== id);
    await this.ctx.secrets.delete(`mscode.key.${id}`);
    if (this.activeProviderId === id) { this.activeProviderId = this.providers[0]?.id; }
    await this.ctx.globalState.update('mscode.providers', this.providers);
    await this.ctx.globalState.update('mscode.activeProvider', this.activeProviderId);
    this.pushState();
  }

  private async handleSend(text: string): Promise<void> {
    const provider = this.providers.find(p => p.id === this.activeProviderId);
    if (!provider || !provider.defaultModel) {
      return this.post({ type: 'chatError', message: 'Add a provider first (⚙ Settings).' });
    }
    const apiKey = await this.ctx.secrets.get(`mscode.key.${provider.id}`);
    if (!apiKey) { return this.post({ type: 'chatError', message: 'API key missing for provider.' }); }

    this.agent = new Agent({
      provider: makeProvider(provider.kind),
      model: provider.defaultModel,
      baseUrl: provider.baseUrl,
      apiKey,
      instructions: this.instructions,
      mode: this.mode(),
      toolCtx: {
        rootPath: this.rootPath(),
        mode: this.mode(),
        confirm: (cmd) => this.requestConfirm(cmd),
      },
    });

    this.post({ type: 'runStart' });
    await this.agent.run(this.history, text, {
      onDelta: t => this.post({ type: 'delta', text: t }),
      onAssistant: () => this.post({ type: 'assistantDone' }),
      onToolStart: (name, args) => this.post({ type: 'toolStart', name, args }),
      onToolResult: (name, ok, summary) => this.post({ type: 'toolResult', name, ok, summary }),
      onDone: final => this.post({ type: 'runDone', final }),
      onError: err => this.post({ type: 'chatError', message: err }),
    });
  }

  private requestConfirm(cmd: string): Promise<boolean> {
    return new Promise<boolean>(resolve => {
      const id = `c_${Date.now().toString(36)}`;
      const timer = setTimeout(() => {
        this.pendingConfirms.delete(id);
        resolve(false);
      }, 120000);
      this.pendingConfirms.set(id, { resolve, timer });
      this.post({ type: 'confirmRequest', id, cmd });
    });
  }

  private post(msg: any): void { this.view?.webview.postMessage(msg); }

  private pushState(): void {
    this.post({
      type: 'state',
      providers: this.providers.map(p => ({ ...p })),
      activeProviderId: this.activeProviderId,
      mode: this.mode(),
      instructions: this.instructions,
    });
  }

  private getHtml(wv: vscode.Webview): string {
    const nonce = Math.random().toString(36).slice(2);
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
:root {
  --bg:#0a0a14; --panel:#11111f; --card:#161628; --border:#23233d;
  --text:#e8e8f4; --dim:#8b8ba8; --a1:#7c5cff; --a2:#00d4ff; --ok:#34d399; --err:#f87171;
}
* { box-sizing:border-box; margin:0; padding:0; }
body { background:var(--bg); color:var(--text); font-family:'Segoe UI',Inter,system-ui,sans-serif; height:100vh; display:flex; flex-direction:column; overflow:hidden; }
.bg-glow { position:fixed; inset:0; background:
  radial-gradient(600px 300px at 85% -5%, rgba(124,92,255,.18), transparent),
  radial-gradient(500px 260px at -10% 105%, rgba(0,212,255,.12), transparent); pointer-events:none; }

header { padding:12px 14px; border-bottom:1px solid var(--border); background:rgba(17,17,31,.7); backdrop-filter:blur(12px); display:flex; flex-direction:column; gap:10px; z-index:2; }
.h-row { display:flex; align-items:center; gap:8px; }
.logo { display:flex; align-items:center; gap:8px; font-weight:700; font-size:15px; letter-spacing:.3px;
  background:linear-gradient(90deg,var(--a1),var(--a2)); -webkit-background-clip:text; background-clip:text; color:transparent; animation:shift 6s ease infinite; }
@keyframes shift { 0%,100%{filter:hue-rotate(0)} 50%{filter:hue-rotate(25deg)} }
.dot { width:8px; height:8px; border-radius:50%; background:var(--ok); animation:pulse 2s infinite; }
@keyframes pulse { 0%,100%{opacity:1; box-shadow:0 0 0 0 rgba(52,211,153,.5)} 50%{opacity:.7; box-shadow:0 0 0 5px rgba(52,211,153,0)} }
.spacer { flex:1; }
select, .btn, input, textarea { background:var(--card); color:var(--text); border:1px solid var(--border); border-radius:9px; padding:6px 10px; font-size:12px; outline:none; transition:border-color .2s, box-shadow .2s; font-family:inherit; }
select:focus, input:focus, textarea:focus { border-color:var(--a1); box-shadow:0 0 0 3px rgba(124,92,255,.15); }
.btn { cursor:pointer; white-space:nowrap; }
.btn:hover { border-color:var(--a1); }
.btn.primary { background:linear-gradient(135deg,var(--a1),#5a3ff0); border:none; font-weight:600; }
.btn.ghost { background:transparent; }
.btn.danger { color:var(--err); }
.pills { display:flex; gap:4px; background:var(--card); border:1px solid var(--border); padding:3px; border-radius:10px; }
.pill { padding:4px 10px; border-radius:7px; font-size:11px; cursor:pointer; color:var(--dim); transition:all .25s; }
.pill.active { background:linear-gradient(135deg,var(--a1),var(--a2)); color:#fff; font-weight:600; box-shadow:0 2px 10px rgba(124,92,255,.4); }

#chat { flex:1; overflow-y:auto; padding:16px 14px; display:flex; flex-direction:column; gap:12px; z-index:1; }
#chat::-webkit-scrollbar { width:6px; } #chat::-webkit-scrollbar-thumb { background:var(--border); border-radius:3px; }
.msg { max-width:92%; animation:slideUp .35s cubic-bezier(.2,.9,.3,1.1); }
@keyframes slideUp { from{opacity:0; transform:translateY(12px) scale(.98)} to{opacity:1; transform:none} }
.msg.user { align-self:flex-end; background:linear-gradient(135deg,var(--a1),#5a3ff0); color:#fff; padding:9px 13px; border-radius:14px 14px 4px 14px; font-size:13px; box-shadow:0 4px 14px rgba(124,92,255,.25); }
.msg.ai { align-self:flex-start; background:var(--card); border:1px solid var(--border); padding:10px 13px; border-radius:14px 14px 14px 4px; font-size:13px; line-height:1.55; white-space:pre-wrap; }
.msg.ai code { background:#1e1e36; padding:1px 5px; border-radius:4px; font-size:12px; }

.tool { align-self:flex-start; background:var(--panel); border:1px solid var(--border); border-left:3px solid var(--a1); border-radius:10px; padding:8px 12px; font-size:12px; max-width:92%; animation:slideUp .3s ease; display:flex; align-items:center; gap:8px; }
.tool .spin { width:13px; height:13px; border:2px solid var(--border); border-top-color:var(--a2); border-radius:50%; animation:rot .7s linear infinite; flex:none; }
@keyframes rot { to{transform:rotate(360deg)} }
.tool.done { border-left-color:var(--ok); } .tool.fail { border-left-color:var(--err); }
.tool .tname { font-weight:600; color:var(--a2); }
.tool .tsum { color:var(--dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:280px; }

.typing { align-self:flex-start; display:flex; gap:5px; padding:12px 14px; background:var(--card); border-radius:14px; border:1px solid var(--border); animation:slideUp .3s ease; }
.typing span { width:7px; height:7px; border-radius:50%; background:var(--a1); animation:bounce 1.2s infinite; }
.typing span:nth-child(2){animation-delay:.15s} .typing span:nth-child(3){animation-delay:.3s}
@keyframes bounce { 0%,60%,100%{transform:translateY(0);opacity:.5} 30%{transform:translateY(-6px);opacity:1} }

.confirm { align-self:stretch; background:linear-gradient(135deg,rgba(248,113,113,.12),rgba(124,92,255,.12)); border:1px solid var(--a1); border-radius:12px; padding:12px; animation:slideUp .3s ease; }
.confirm .cmd { font-family:Consolas,monospace; font-size:12px; background:#000; padding:8px; border-radius:8px; margin:8px 0; white-space:pre-wrap; }
.confirm .row { display:flex; gap:8px; }

.input-area { padding:12px 14px; border-top:1px solid var(--border); background:rgba(17,17,31,.85); backdrop-filter:blur(12px); z-index:2; }
.input-box { display:flex; gap:8px; align-items:flex-end; background:var(--card); border:1px solid var(--border); border-radius:14px; padding:8px 8px 8px 14px; transition:border-color .25s, box-shadow .25s; }
.input-box:focus-within { border-color:var(--a1); box-shadow:0 0 0 3px rgba(124,92,255,.15), 0 6px 22px rgba(124,92,255,.15); }
textarea#input { flex:1; background:transparent; border:none; resize:none; font-size:13px; max-height:140px; line-height:1.5; padding:4px 0; color:var(--text); }
textarea#input:focus { box-shadow:none; }
.send-btn { width:36px; height:36px; border-radius:10px; border:none; cursor:pointer; background:linear-gradient(135deg,var(--a1),var(--a2)); color:#fff; font-size:15px; display:flex; align-items:center; justify-content:center; transition:transform .2s, box-shadow .2s; }
.send-btn:hover { transform:translateY(-2px) scale(1.05); box-shadow:0 6px 18px rgba(124,92,255,.5); }
.send-btn:disabled { opacity:.4; cursor:not-allowed; transform:none; box-shadow:none; }
.hint { font-size:10.5px; color:var(--dim); margin-top:6px; display:flex; justify-content:space-between; }

.overlay { position:fixed; inset:0; background:rgba(5,5,12,.72); backdrop-filter:blur(6px); display:none; align-items:center; justify-content:center; z-index:50; animation:fadeIn .25s ease; }
@keyframes fadeIn { from{opacity:0} to{opacity:1} }
.overlay.show { display:flex; }
.drawer { width:400px; max-height:86vh; overflow-y:auto; background:var(--panel); border:1px solid var(--border); border-radius:18px; padding:20px; animation:slideUp .35s cubic-bezier(.2,.9,.3,1.1); box-shadow:0 30px 80px rgba(0,0,0,.6); }
.drawer h2 { font-size:16px; margin-bottom:14px; background:linear-gradient(90deg,var(--a1),var(--a2)); -webkit-background-clip:text; background-clip:text; color:transparent; }
.drawer label { display:block; font-size:11px; color:var(--dim); margin:10px 0 4px; }
.drawer input, .drawer select, .drawer textarea { width:100%; }
.drawer textarea { min-height:80px; resize:vertical; font-size:12px; }
.test-status { font-size:11px; margin-top:6px; }
.test-status.ok { color:var(--ok); } .test-status.err { color:var(--err); }
.pv-item { display:flex; align-items:center; justify-content:space-between; background:var(--card); border:1px solid var(--border); padding:8px 12px; border-radius:10px; margin-bottom:6px; font-size:12px; }
.pv-item .kind { color:var(--a2); font-size:10px; }
.close-x { float:right; cursor:pointer; color:var(--dim); font-size:18px; }
.empty { color:var(--dim); font-size:12px; text-align:center; margin:auto; }
</style>
</head>
<body>
<div class="bg-glow"></div>

<header>
  <div class="h-row">
    <span class="logo">&lt;/&gt; MS Code</span>
    <span class="dot" id="statusDot"></span>
    <span class="spacer"></span>
    <select id="providerSel" title="Provider"></select>
    <select id="modelSel" title="Model"></select>
    <button class="btn ghost" id="btnClear" title="Clear chat">🧹</button>
    <button class="btn ghost" id="btnStop" title="Stop" style="display:none">⏹</button>
    <button class="btn primary" id="btnSettings">⚙ Settings</button>
  </div>
  <div class="h-row">
    <div class="pills" id="modePills">
      <div class="pill" data-mode="safe" title="Confirm every action">Safe</div>
      <div class="pill" data-mode="hybrid" title="Confirm risky commands only">Hybrid</div>
      <div class="pill" data-mode="auto" title="Agent acts fully autonomously">Auto</div>
    </div>
    <span class="spacer"></span>
    <span style="font-size:10.5px;color:var(--dim)" id="modeHint"></span>
  </div>
</header>

<div id="chat">
  <div class="empty">✨ MS Code agent ready.<br>Add a provider in ⚙ Settings, pick a model, and give it a task.</div>
</div>

<div class="input-area">
  <div class="input-box">
    <textarea id="input" rows="1" placeholder="Describe a task… e.g. 'add auth middleware and run the tests'"></textarea>
    <button class="send-btn" id="btnSend">➤</button>
  </div>
  <div class="hint"><span>Enter to send · Shift+Enter newline</span><span id="stepInfo"></span></div>
</div>

<div class="overlay" id="overlay">
  <div class="drawer">
    <span class="close-x" id="btnCloseSettings">✕</span>
    <h2>Provider Settings</h2>
    <div id="pvList"></div>
    <label>Label</label><input id="pvLabel" placeholder="My OpenRouter">
    <label>Type</label>
    <select id="pvKind">
      <option value="openai">OpenAI-compatible (OpenAI, OpenRouter, Groq, Ollama, LM Studio…)</option>
      <option value="anthropic">Anthropic / Claude</option>
      <option value="gemini">Google Gemini</option>
    </select>
    <label>Base URL</label><input id="pvBase" placeholder="https://api.openai.com/v1">
    <label>API Key</label><input id="pvKey" type="password" placeholder="sk-…">
    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="btn" id="btnTest" style="flex:1">🔌 Test &amp; Fetch Models</button>
      <button class="btn primary" id="btnSave" style="flex:1" disabled>💾 Save</button>
    </div>
    <div class="test-status" id="testStatus"></div>
    <h2 style="margin-top:22px">Agent Instructions</h2>
    <textarea id="instr" placeholder="Custom system instructions for the agent…"></textarea>
    <button class="btn primary" id="btnSaveInstr" style="width:100%;margin-top:8px">Save Instructions</button>
  </div>
</div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const chat = $('chat');
let state = { providers: [], activeProviderId: null, mode: 'auto', instructions: '' };
let testedModels = [];

function esc(s){ return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function bottom(){ chat.scrollTop = chat.scrollHeight; }
function clearEmpty(){ const e = chat.querySelector('.empty'); if (e) e.remove(); }

function addMsg(cls, text){
  clearEmpty();
  const d = document.createElement('div');
  d.className = 'msg ' + cls;
  d.textContent = text;
  chat.appendChild(d); bottom(); return d;
}

let aiMsg = null;
function startAI(){ aiMsg = addMsg('ai',''); return aiMsg; }
function appendDelta(t){ if (aiMsg) { aiMsg.textContent += t; bottom(); } }

let toolCard = null;
function toolStart(name, args){
  clearEmpty();
  const d = document.createElement('div');
  d.className = 'tool';
  const brief = args && args.path ? args.path : (args && args.command ? args.command : (args && args.pattern ? args.pattern : ''));
  d.innerHTML = '<div class="spin"></div><span class="tname">' + esc(name) + '</span><span class="tsum">' + esc(brief) + '</span>';
  chat.appendChild(d); bottom(); toolCard = d; return d;
}
function toolResult(ok, summary){
  if (toolCard) {
    toolCard.classList.add(ok ? 'done' : 'fail');
    const spin = toolCard.querySelector('.spin');
    if (spin) spin.outerHTML = ok ? '✅' : '❌';
    if (summary && toolCard.querySelector('.tsum')) toolCard.querySelector('.tsum').textContent = summary;
  }
}

function typing(on){
  let t = chat.querySelector('.typing');
  if (on && !t){ const d=document.createElement('div'); d.className='typing'; d.innerHTML='<span></span><span></span><span></span>'; chat.appendChild(d); bottom(); }
  if (!on && t) t.remove();
}

function confirmRequest(id, cmd){
  clearEmpty();
  const d = document.createElement('div');
  d.className = 'confirm';
  d.innerHTML = '<b>⚠️ Command approval required</b><div class="cmd">' + esc(cmd) + '</div>' +
    '<div class="row"><button class="btn primary" data-a="yes">Allow once</button>' +
    '<button class="btn danger" data-a="no">Deny</button></div>';
  d.querySelectorAll('button').forEach(b => b.onclick = () => {
    vscode.postMessage({ type:'confirm.response', id, approved: b.dataset.a === 'yes' });
    d.remove();
  });
  chat.appendChild(d); bottom();
}

function renderState(){
  $('providerSel').innerHTML = state.providers.length
    ? state.providers.map(p => '<option value="'+esc(p.id)+'"'+(p.id===state.activeProviderId?' selected':'')+'>'+esc(p.label)+'</option>').join('')
    : '<option>No provider</option>';
  const p = state.providers.find(x => x.id === state.activeProviderId);
  $('modelSel').innerHTML = p && p.models.length
    ? p.models.map(m => '<option value="'+esc(m)+'"'+(m===p.defaultModel?' selected':'')+'>'+esc(m)+'</option>').join('')
    : '<option>No model</option>';
  document.querySelectorAll('#modePills .pill').forEach(el => el.classList.toggle('active', el.dataset.mode === state.mode));
  $('modeHint').textContent = { safe:'Every action needs approval', hybrid:'Risky commands need approval', auto:'Fully autonomous' }[state.mode];
  if ($('instr').value !== state.instructions) $('instr').value = state.instructions;
  const pvList = $('pvList');
  pvList.innerHTML = state.providers.map(p =>
    '<div class="pv-item"><span>'+esc(p.label)+' <span class="kind">['+p.kind+']</span></span>' +
    '<button class="btn danger" data-id="'+esc(p.id)+'">Remove</button></div>').join('') || '<div style="font-size:12px;color:var(--dim);padding:6px 0">No providers yet.</div>';
  pvList.querySelectorAll('button').forEach(b => b.onclick = () => vscode.postMessage({ type:'removeProvider', id: b.dataset.id }));
}

window.addEventListener('message', e => {
  const m = e.data;
  switch (m.type) {
    case 'state': state = m; renderState(); break;
    case 'runStart': clearEmpty(); $('btnStop').style.display=''; $('btnSend').disabled=true; $('statusDot').style.background='var(--a2)'; break;
    case 'delta': typing(false); if (!aiMsg) startAI(); appendDelta(m.text); break;
    case 'assistantDone': aiMsg = null; break;
    case 'toolStart': aiMsg = null; typing(false); toolStart(m.name, m.args); break;
    case 'toolResult': toolResult(m.ok, m.summary); break;
    case 'runDone': typing(false); toolResult(true,''); if (m.final) { const last = chat.querySelector('.msg.ai:last-child'); if (!last || !last.textContent) { if (last) last.remove(); addMsg('ai', m.final); } } resetRun(); break;
    case 'chatError': typing(false); addMsg('ai', '❌ ' + m.message); resetRun(); break;
    case 'cleared': chat.innerHTML = '<div class="empty">✨ New session.</div>'; break;
    case 'testResult': {
      const st = $('testStatus');
      if (m.ok) {
        testedModels = m.models || [];
        st.className = 'test-status ok';
        st.textContent = '✓ Connected — ' + testedModels.length + ' models found';
        $('btnSave').disabled = false;
        if (!$('pvLabel').value) $('pvLabel').value = $('pvKind').selectedOptions[0].textContent.split('(')[0].trim();
      } else {
        testedModels = []; $('btnSave').disabled = true;
        st.className = 'test-status err'; st.textContent = '✗ ' + m.error;
      }
      break;
    }
  }
});

function resetRun(){ $('btnStop').style.display='none'; $('btnSend').disabled=false; $('statusDot').style.background='var(--ok)'; aiMsg=null; toolCard=null; }

$('btnSend').onclick = send;
$('input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
$('input').addEventListener('input', e => { e.target.style.height='auto'; e.target.style.height=Math.min(140,e.target.scrollHeight)+'px'; });

function send(){
  const t = $('input').value.trim();
  if (!t) return;
  $('input').value=''; $('input').style.height='auto';
  addMsg('user', t);
  typing(true);
  vscode.postMessage({ type:'send', text:t });
}

$('btnStop').onclick = () => vscode.postMessage({ type:'stop' });
$('btnClear').onclick = () => vscode.postMessage({ type:'clearChat' });
$('providerSel').onchange = e => { vscode.postMessage({ type:'setProvider', id:e.target.value }); };
$('modelSel').onchange = e => vscode.postMessage({ type:'setModel', id: state.activeProviderId, model: e.target.value });
document.querySelectorAll('#modePills .pill').forEach(el =>
  el.onclick = () => vscode.postMessage({ type:'setMode', mode: el.dataset.mode }));

$('btnSettings').onclick = () => $('overlay').classList.add('show');
$('btnCloseSettings').onclick = () => $('overlay').classList.remove('show');
$('overlay').onclick = e => { if (e.target === $('overlay')) $('overlay').classList.remove('show'); };

$('pvKind').onchange = () => {
  const k = $('pvKind').value;
  $('pvBase').value = { openai:'https://api.openai.com/v1', anthropic:'https://api.anthropic.com', gemini:'https://generativelanguage.googleapis.com' }[k];
  $('testStatus').textContent=''; testedModels=[]; $('btnSave').disabled=true;
};

$('btnTest').onclick = () => {
  vscode.postMessage({ type:'testProvider', reqId:'t', kind: $('pvKind').value, baseUrl: $('pvBase').value, apiKey: $('pvKey').value });
  $('testStatus').className='test-status'; $('testStatus').textContent='Testing connection…';
};

$('btnSave').onclick = () => {
  vscode.postMessage({ type:'saveProvider', label: $('pvLabel').value, kind: $('pvKind').value,
    baseUrl: $('pvBase').value, apiKey: $('pvKey').value, models: testedModels });
  $('overlay').classList.remove('show');
  $('pvKey').value=''; $('testStatus').textContent=''; testedModels=[]; $('btnSave').disabled=true;
};

$('btnSaveInstr').onclick = () => {
  state.instructions = $('instr').value;
  vscode.postMessage({ type:'setInstructions', text: $('instr').value });
  $('btnSaveInstr').textContent='✓ Saved';
  setTimeout(()=> $('btnSaveInstr').textContent='Save Instructions', 1500);
};
</script>
</body>
</html>`;
  }
}
