import * as vscode from 'vscode';
import { AuthManager } from '../jellyfin/auth';
import { JellyfinApiError } from '../jellyfin/client';
import { renderPage, webviewOptions } from './webview';
import type { NowPlaying } from './playerViewProvider';
import type { JellyfinItem } from '../jellyfin/types';

interface ItemView {
  id: string;
  name: string;
  subtitle: string;
  imageUrl: string;
  isFolder: boolean;
  wide: boolean;
  progress: number;
  played: boolean;
}

interface SectionView {
  title: string;
  items: ItemView[];
}

type ViewRequest =
  | { kind: 'home' }
  | { kind: 'folder'; id: string; startIndex?: number }
  | { kind: 'search'; query: string };

/** The library browser that lives behind the Jellyfin icon in the activity bar. */
export class BrowseViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'jellyfin.browseView';

  private webviewView: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly auth: AuthManager,
    private readonly playItem: (itemId: string) => void,
    private readonly getNowPlaying: () => NowPlaying | undefined,
  ) {
    // The page's content security policy names the server, so it is rebuilt when that changes.
    auth.onDidChange(() => this.reload());
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.webviewView = webviewView;
    webviewView.webview.options = webviewOptions(this.extensionUri);
    webviewView.webview.onDidReceiveMessage((message) => this.handleMessage(message));
    webviewView.onDidDispose(() => {
      this.webviewView = undefined;
    });
    this.reload();
  }

  /** Reloads the view being shown. */
  refresh(): void {
    this.post({ type: 'refresh' });
  }

  /** Shows or hides the playback controls for the item in the player view. */
  setNowPlaying(nowPlaying: NowPlaying | undefined): void {
    this.post({ type: 'nowPlaying', nowPlaying });
  }

  /** Reloads only the home page, whose Continue Watching row changes when playback stops. */
  refreshHome(): void {
    this.post({ type: 'refresh', homeOnly: true });
  }

  private post(message: unknown): void {
    void this.webviewView?.webview.postMessage(message);
  }

  private reload(): void {
    if (this.webviewView) {
      this.webviewView.webview.html = this.renderHtml(this.webviewView.webview);
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object' || !('type' in message)) {
      return;
    }
    const msg = message as Record<string, unknown>;

    switch (msg.type) {
      case 'ready':
        this.post({ type: 'state', signedIn: this.auth.isSignedIn(), account: this.auth.describeAccount() });
        this.setNowPlaying(this.getNowPlaying());
        break;
      case 'command':
        if (typeof msg.command === 'string' && msg.command.startsWith('jellyfin.')) {
          await vscode.commands.executeCommand(msg.command);
        }
        break;
      case 'signIn':
        await this.auth.signIn();
        break;
      case 'load':
        if (typeof msg.requestId === 'number' && msg.view && typeof msg.view === 'object') {
          await this.loadView(msg.requestId, msg.view as ViewRequest);
        }
        break;
      case 'playItem':
        if (typeof msg.itemId === 'string') {
          this.playItem(msg.itemId);
        }
        break;
    }
  }

  private async loadView(requestId: number, view: ViewRequest): Promise<void> {
    const userId = this.auth.getUserId();
    if (!userId) {
      return;
    }
    const client = this.auth.getClient();
    const toViews = (items: JellyfinItem[]) => items.map((item) => this.toItemView(item));
    try {
      let title = '';
      let sections: SectionView[];
      let nextIndex: number | undefined;

      if (view.kind === 'home') {
        const [resume, nextUp, libraries, latest] = await Promise.all([
          client.getResumeItems(userId),
          // Next Up only exists for TV libraries; a server without one shouldn't break the home page.
          client.getNextUp(userId).catch(() => []),
          client.getLibraries(userId),
          client.getLatestItems(userId),
        ]);
        sections = [
          { title: 'Continue Watching', items: toViews(resume) },
          { title: 'Next Up', items: toViews(nextUp) },
          { title: 'Libraries', items: toViews(libraries) },
          { title: 'Recently Added', items: toViews(latest) },
        ];
      } else if (view.kind === 'folder') {
        const startIndex = view.startIndex ?? 0;
        const parent = await client.getItem(userId, view.id);
        const children = await client.getChildren(userId, parent, startIndex);
        title = parent.SeriesName && parent.Type === 'Season' ? `${parent.SeriesName} — ${parent.Name}` : parent.Name;
        sections = [{ title: '', items: toViews(children.Items) }];
        const loaded = startIndex + children.Items.length;
        if (children.Items.length > 0 && loaded < (children.TotalRecordCount ?? 0)) {
          nextIndex = loaded;
        }
      } else {
        title = `Results for “${view.query}”`;
        sections = [{ title: '', items: toViews(await client.search(userId, view.query)) }];
      }

      this.post({ type: 'view', requestId, title, sections: sections.filter((s) => s.items.length > 0), nextIndex });
    } catch (err) {
      if (err instanceof JellyfinApiError && err.status === 401) {
        // The saved token was revoked or expired; fall back to the sign-in screen.
        await this.auth.signOut();
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: 'viewError', requestId, message });
    }
  }

  private toItemView(item: JellyfinItem): ItemView {
    const year = item.ProductionYear ? String(item.ProductionYear) : '';
    let name = item.Name;
    let subtitle = year || item.Type;
    if (item.Type === 'Episode') {
      const season = item.ParentIndexNumber !== undefined ? `S${item.ParentIndexNumber}` : '';
      const episode = item.IndexNumber !== undefined ? `E${item.IndexNumber}` : '';
      subtitle = [season + episode, item.SeriesName].filter(Boolean).join(' · ');
    } else if (item.Type === 'CollectionFolder' || item.Type === 'UserView') {
      subtitle = '';
    } else if (item.Type === 'Audio' && item.IndexNumber !== undefined) {
      name = `${item.IndexNumber}. ${item.Name}`;
    }
    return {
      id: item.Id,
      name,
      subtitle,
      imageUrl: this.auth.getClient().getImageUrl(item),
      isFolder: Boolean(item.IsFolder),
      wide: item.Type === 'Episode' || item.Type === 'CollectionFolder' || item.Type === 'UserView',
      progress: item.UserData?.PlayedPercentage ?? 0,
      played: Boolean(item.UserData?.Played),
    };
  }

  private renderHtml(webview: vscode.Webview): string {
    return renderPage(
      webview,
      this.extensionUri,
      this.auth,
      'browse',
      /* html */ `
  <div id="signed-out" class="hidden">
    <p>Connect to your Jellyfin server to browse and play your library.</p>
    <button id="sign-in-btn">Sign In</button>
  </div>
  <div id="main" class="hidden">
    <div id="toolbar">
      <button id="back-btn" class="icon-btn" title="Back" aria-label="Back" disabled>←</button>
      <input id="search" type="search" placeholder="Search library" aria-label="Search library" />
    </div>
    <div id="browse">
      <h2 id="heading" class="hidden"></h2>
      <div id="content"></div>
      <div id="message" class="hidden"></div>
      <button id="more-btn" class="hidden">Load more</button>
    </div>
    <div id="now-playing" class="hidden">
      <div id="now-title"></div>
      <div class="button-row">
        <button id="audio-btn" class="secondary" data-command="jellyfin.selectAudio" title="Choose the audio track">Audio</button>
        <button class="secondary" data-command="jellyfin.selectSubtitles" title="Choose subtitles or load a subtitle file">Subtitles</button>
        <button id="match-size-btn" class="secondary" data-command="jellyfin.toggleMatchPlayerSize" aria-pressed="false" title="Have the server scale the video down to the size of the player. Saves bandwidth; the server has to re-encode the video.">Fit size</button>
        <button class="secondary" data-command="jellyfin.stop" title="Stop and close the video">Stop</button>
      </div>
    </div>
    <div id="account">
      <div id="account-name"></div>
      <div class="button-row">
        <button class="link" data-command="jellyfin.switchUser">Switch user</button>
        <button class="link" data-command="jellyfin.changeServer">Change server</button>
        <button class="link" data-command="jellyfin.signOut">Sign out</button>
      </div>
    </div>
  </div>`,
    );
  }
}
