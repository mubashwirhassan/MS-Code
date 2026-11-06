import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  const { MSCodeView } = require('./webview/panel');
  const view = new MSCodeView(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(MSCodeView.viewId, view, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mscode.openChat', () =>
      vscode.commands.executeCommand('mscode.chatView.focus')),
    vscode.commands.registerCommand('mscode.addProvider', async () => {
      await vscode.commands.executeCommand('mscode.chatView.focus');
      await vscode.commands.executeCommand('workbench.action.openSettings', 'mscode');
    }),
    vscode.commands.registerCommand('mscode.setExecutionMode', async () => {
      const pick = await vscode.window.showQuickPick(
        [
          { label: '🛡 Safe — approve every action', value: 'safe' },
          { label: '⚖ Hybrid — approve risky commands only', value: 'hybrid' },
          { label: '⚡ Auto — fully autonomous', value: 'auto' },
        ],
        { placeHolder: 'Select execution mode' },
      );
      if (pick) {
        await vscode.workspace.getConfiguration('mscode')
          .update('executionMode', pick.value, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`MS Code: ${pick.value} mode enabled.`);
      }
    }),
  );
}

export function deactivate(): void { /* noop */ }
