import * as vscode from 'vscode';
import { AuthManager } from '../jellyfin/auth';
import { getNonce } from '../util/nonce';

/** Wraps a view's markup in a page whose content security policy only admits our own assets and the server's media. */
export function renderPage(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  auth: AuthManager,
  name: 'browse' | 'player',
  body: string,
): string {
  const nonce = getNonce();
  const asset = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', file));
  let server = '';
  try {
    server = new URL(auth.getServerUrl()).origin;
  } catch {
    server = '';
  }

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} ${server} data:; media-src ${server} blob:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${asset('common.css')}" rel="stylesheet" />
  <link href="${asset(`${name}.css`)}" rel="stylesheet" />
  <title>Jellyfin</title>
</head>
<body>
${body}
  <script nonce="${nonce}" src="${asset(`${name}.js`)}"></script>
</body>
</html>`;
}

export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
  };
}
