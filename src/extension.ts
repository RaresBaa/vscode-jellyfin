import * as vscode from 'vscode';
import { AuthManager } from './jellyfin/auth';
import { BrowseViewProvider } from './panels/browseViewProvider';
import { PlayerViewProvider } from './panels/playerViewProvider';

// The player view's `when` clause in package.json is `!jellyfin.hidden`. A context key is the
// only way to hide a single view that keeps working wherever the user has dragged it.
const HIDDEN_CONTEXT = 'jellyfin.hidden';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const auth = await AuthManager.create(context);

  const updateSignedIn = () => vscode.commands.executeCommand('setContext', 'jellyfin.signedIn', auth.isSignedIn());
  void updateSignedIn();

  let hidden = false;
  const show = async () => {
    hidden = false;
    await vscode.commands.executeCommand('setContext', HIDDEN_CONTEXT, false);
    await vscode.commands.executeCommand(`${PlayerViewProvider.viewId}.focus`);
  };
  const hide = async () => {
    hidden = true;
    await vscode.commands.executeCommand('setContext', HIDDEN_CONTEXT, true);
  };

  const player = new PlayerViewProvider(context.extensionUri, auth, show);
  const browse = new BrowseViewProvider(
    context.extensionUri,
    auth,
    (itemId) => void player.play(itemId),
    () => player.nowPlaying,
  );

  // Save the playing position while the session it belongs to can still be reported.
  auth.onWillChange = async () => {
    await player.stop();
  };

  const account = async () => {
    if (!auth.isSignedIn()) {
      return auth.signIn();
    }
    const pick = await vscode.window.showQuickPick(
      [
        { label: '$(account) Switch user…', run: () => auth.signIn({ user: true }) },
        { label: '$(server) Change server…', run: () => auth.signIn({ server: true }) },
        { label: '$(sign-out) Sign out', run: () => auth.signOut() },
      ],
      { placeHolder: auth.describeAccount() },
    );
    return pick?.run();
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PlayerViewProvider.viewId, player, {
      // Keep playing while the view is collapsed or another side bar tab is in front.
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(BrowseViewProvider.viewId, browse, {
      // Keep the place in the library while the player or another side bar tab is in front.
      webviewOptions: { retainContextWhenHidden: true },
    }),
    player.onDidStop(() => browse.refreshHome()),
    player.onDidChangeNowPlaying((nowPlaying) => browse.setNowPlaying(nowPlaying)),

    vscode.commands.registerCommand('jellyfin.signIn', () => auth.signIn()),
    vscode.commands.registerCommand('jellyfin.signOut', () => auth.signOut()),

    vscode.commands.registerCommand('jellyfin.show', show),
    vscode.commands.registerCommand('jellyfin.hide', hide),
    vscode.commands.registerCommand('jellyfin.toggle', () => (!hidden && player.isVisible ? hide() : show())),
    vscode.commands.registerCommand('jellyfin.openLibrary', () =>
      vscode.commands.executeCommand(`${BrowseViewProvider.viewId}.focus`),
    ),

    vscode.commands.registerCommand('jellyfin.account', account),
    vscode.commands.registerCommand('jellyfin.switchUser', () => auth.signIn({ user: true })),
    vscode.commands.registerCommand('jellyfin.changeServer', () => auth.signIn({ server: true })),
    vscode.commands.registerCommand('jellyfin.selectAudio', () => player.selectAudioTrack()),
    vscode.commands.registerCommand('jellyfin.selectSubtitles', () => player.selectSubtitles()),
    vscode.commands.registerCommand('jellyfin.playPause', () => player.sendCommand('playPause')),
    vscode.commands.registerCommand('jellyfin.stop', () => player.sendCommand('stop')),
    vscode.commands.registerCommand('jellyfin.refresh', () => browse.refresh()),

    auth.onDidChange(updateSignedIn),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('jellyfin.serverUrl')) {
        void auth.refreshServerUrl();
      }
    }),
  );
}

export function deactivate(): void {}
