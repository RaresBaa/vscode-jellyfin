import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { AuthManager } from '../jellyfin/auth';
import { renderPage, webviewOptions } from './webview';
import type { AudioTrack, PlaybackSession, StreamOptions, SubtitleTrack } from '../jellyfin/types';

const WEBVIEW_TIMEOUT_MS = 10000;

function timeout(ms: number): Promise<undefined> {
  return new Promise((resolve) => setTimeout(() => resolve(undefined), ms));
}

/** `subtitleIndex` of a session showing a subtitle file loaded from disk. */
const LOCAL_SUBTITLE = -2;

/** WebVTT is what the video element renders; SubRip differs only in its header and decimal separator. */
function toWebVtt(text: string): string {
  const body = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (body.startsWith('WEBVTT')) {
    return body;
  }
  return `WEBVTT\n\n${body.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')}`;
}

/** What the library view shows about the item in the player. */
export interface NowPlaying {
  title: string;
  audioTrackCount: number;
}

interface TrackPick extends vscode.QuickPickItem {
  index?: number;
  action?: () => unknown;
}

/** The video player, which starts out in the Explorer side bar. */
export class PlayerViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'jellyfin.playerView';

  private webviewView: vscode.WebviewView | undefined;
  private session: PlaybackSession | undefined;
  private audioTracks: AudioTrack[] = [];
  private subtitleTracks: SubtitleTrack[] = [];
  private deviceProfile: unknown;
  private compatibleProfile: unknown;
  private onReady: Array<() => void> = [];
  private onUnloaded: Array<(positionTicks: unknown) => void> = [];
  private readonly stopEmitter = new vscode.EventEmitter<void>();

  /** Fires once the server has been told that playback of an item ended. */
  readonly onDidStop = this.stopEmitter.event;

  private readonly nowPlayingEmitter = new vscode.EventEmitter<NowPlaying | undefined>();
  private current: NowPlaying | undefined;
  private restarting = false;

  /** Fires when an item starts playing, and with `undefined` when the player becomes empty. */
  readonly onDidChangeNowPlaying = this.nowPlayingEmitter.event;

  get nowPlaying(): NowPlaying | undefined {
    return this.current;
  }

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly auth: AuthManager,
    private readonly showView: () => Thenable<void>,
  ) {
    // The page's content security policy names the server, so it is rebuilt when that changes.
    auth.onDidChange(() => this.reload());
  }

  get isVisible(): boolean {
    return Boolean(this.webviewView?.visible);
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.webviewView = webviewView;
    webviewView.webview.options = webviewOptions(this.extensionUri);
    webviewView.webview.onDidReceiveMessage((message) => this.handleMessage(message));
    webviewView.onDidDispose(() => {
      this.webviewView = undefined;
      this.deviceProfile = undefined;
      void this.stopSession();
    });
    this.reload();
  }

  sendCommand(command: 'playPause' | 'stop'): void {
    this.post({ type: 'command', command });
  }

  /** Starts an item. `positionTicks` overrides the position saved on the server. */
  async play(itemId: string, options: StreamOptions = {}, positionTicks?: number): Promise<void> {
    const userId = this.auth.getUserId();
    if (!userId) {
      return;
    }
    const client = this.auth.getClient();
    try {
      if (!(await this.reveal())) {
        throw new Error('The Jellyfin player view could not be opened');
      }
      // Text subtitles are drawn by the player, so the server is only told about the ones it must draw itself.
      const chosen = this.subtitleTracks.find((track) => track.index === options.subtitleIndex);
      const serverOptions = chosen?.url || options.subtitleIndex === LOCAL_SUBTITLE ? { ...options, subtitleIndex: -1 } : options;
      await this.stop();

      const item = await client.getItem(userId, itemId);
      const profile = options.compatible ? this.compatibleProfile : this.deviceProfile;
      const streamInfo = await client.getStreamInfo(userId, item, profile, serverOptions);
      const startTicks = positionTicks ?? item.UserData?.PlaybackPositionTicks ?? 0;

      this.session = {
        itemId,
        mediaSourceId: streamInfo.mediaSourceId,
        playSessionId: streamInfo.playSessionId ?? randomUUID(),
        playMethod: streamInfo.playMethod,
        positionTicks: startTicks,
        forceTranscode: Boolean(options.forceTranscode),
        compatible: Boolean(options.compatible),
        audioIndex: streamInfo.audioIndex,
        subtitleIndex: options.subtitleIndex ?? streamInfo.subtitleIndex,
      };
      this.audioTracks = streamInfo.audioTracks;
      this.subtitleTracks = streamInfo.subtitleTracks;

      this.post({
        type: 'play',
        streamUrl: streamInfo.url,
        positionTicks: startTicks,
        itemId,
        canRetry: !options.compatible,
      });
      this.setNowPlaying({
        title: item.SeriesName ? `${item.SeriesName} — ${item.Name}` : item.Name,
        audioTrackCount: streamInfo.audioTracks.length,
      });
      await this.showSubtitle(this.session.subtitleIndex);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setNowPlaying(undefined);
      if (this.webviewView) {
        this.post({ type: 'playError', message });
      } else {
        vscode.window.showErrorMessage(`Jellyfin: ${message}`);
      }
    }
  }

  /** Stops playback, saving the exact position to the server. Returns that position. */
  async stop(): Promise<number | undefined> {
    if (!this.session) {
      return undefined;
    }
    this.post({ type: 'unload' });
    const positionTicks = await Promise.race([
      new Promise<unknown>((resolve) => this.onUnloaded.push(resolve)),
      timeout(WEBVIEW_TIMEOUT_MS),
    ]);
    if (this.session && typeof positionTicks === 'number') {
      this.session.positionTicks = positionTicks;
    }
    const reached = this.session?.positionTicks;
    await this.stopSession();
    return reached;
  }

  async selectAudioTrack(): Promise<void> {
    const session = this.session;
    if (!session) {
      vscode.window.showInformationMessage('Jellyfin: nothing is playing.');
      return;
    }
    const picks: TrackPick[] = this.audioTracks.map((track) => ({
      label: track.label,
      description: track.index === session.audioIndex ? 'current' : undefined,
      index: track.index,
    }));
    const pick = await vscode.window.showQuickPick(picks, { placeHolder: 'Audio track' });
    if (pick?.index !== undefined && pick.index !== session.audioIndex) {
      // The player can't switch tracks inside a file, so the server sends the stream again with the chosen one.
      await this.restart({ audioIndex: pick.index });
    }
  }

  async selectSubtitles(): Promise<void> {
    const session = this.session;
    if (!session) {
      vscode.window.showInformationMessage('Jellyfin: nothing is playing.');
      return;
    }
    const current = (index: number) => (index === session.subtitleIndex ? 'current' : undefined);
    const picks: TrackPick[] = [
      { label: 'Off', description: current(-1), index: -1 },
      ...this.subtitleTracks.map((track) => ({
        label: track.label,
        description: current(track.index),
        detail: track.url ? undefined : 'Image subtitles: the server draws them onto the video',
        index: track.index,
      })),
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      {
        label: '$(folder-opened) Load subtitle file…',
        description: session.subtitleIndex === LOCAL_SUBTITLE ? 'current' : undefined,
        action: () => this.loadSubtitleFile(),
      },
    ];
    const pick = await vscode.window.showQuickPick(picks, { placeHolder: 'Subtitles' });
    if (pick?.action) {
      await pick.action();
    } else if (pick?.index !== undefined && pick.index !== session.subtitleIndex) {
      await this.setSubtitle(pick.index);
    }
  }

  private async setSubtitle(index: number): Promise<void> {
    const session = this.session;
    if (!session) {
      return;
    }
    const drawnByServer = (i: number) => this.subtitleTracks.some((track) => track.index === i && !track.url);
    if (drawnByServer(index) || drawnByServer(session.subtitleIndex)) {
      // Adding or removing subtitles that are part of the picture needs a new stream.
      await this.restart({ subtitleIndex: index });
    } else {
      session.subtitleIndex = index;
      await this.showSubtitle(index);
    }
  }

  /** Has the player draw a text subtitle track, or clears it when the index isn't one. */
  private async showSubtitle(index: number): Promise<void> {
    const itemId = this.session?.itemId;
    const track = this.subtitleTracks.find((subtitle) => subtitle.index === index);
    if (!track?.url) {
      if (index !== LOCAL_SUBTITLE) {
        this.post({ type: 'subtitle', itemId, vtt: null });
      }
      return;
    }
    try {
      const vtt = await this.auth.getClient().getSubtitle(track.url);
      this.post({ type: 'subtitle', itemId, vtt, label: track.label, language: track.language });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Jellyfin: could not load subtitles: ${message}`);
    }
  }

  private async loadSubtitleFile(): Promise<void> {
    const [file] =
      (await vscode.window.showOpenDialog({
        title: 'Load subtitle file',
        canSelectMany: false,
        filters: { Subtitles: ['srt', 'vtt'] },
      })) ?? [];
    const session = this.session;
    if (!file || !session) {
      return;
    }
    try {
      const vtt = toWebVtt(new TextDecoder().decode(await vscode.workspace.fs.readFile(file)));
      const serverDrawn = this.subtitleTracks.some((track) => track.index === session.subtitleIndex && !track.url);
      session.subtitleIndex = LOCAL_SUBTITLE;
      if (serverDrawn) {
        await this.restart({});
      }
      this.post({ type: 'subtitle', itemId: session.itemId, vtt, label: file.path.split('/').pop() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Jellyfin: could not load subtitles: ${message}`);
    }
  }

  /** Requests the current item again with different tracks, carrying on from where it was. */
  private async restart(changes: StreamOptions, positionTicks?: number): Promise<void> {
    const session = this.session;
    if (!session) {
      return;
    }
    const options: StreamOptions = {
      forceTranscode: session.forceTranscode,
      compatible: session.compatible,
      audioIndex: session.audioIndex,
      subtitleIndex: session.subtitleIndex,
      ...changes,
    };
    // The same item carries on, so the library view shouldn't treat this as playback ending.
    this.restarting = true;
    try {
      const reached = await this.stop();
      await this.play(session.itemId, options, positionTicks ?? reached ?? session.positionTicks);
    } finally {
      this.restarting = false;
    }
  }

  private setNowPlaying(nowPlaying: NowPlaying | undefined): void {
    this.current = nowPlaying;
    this.nowPlayingEmitter.fire(nowPlaying);
  }

  private post(message: unknown): void {
    void this.webviewView?.webview.postMessage(message);
  }

  private reload(): void {
    void this.stopSession();
    this.deviceProfile = undefined;
    if (this.webviewView) {
      this.webviewView.webview.html = this.renderHtml(this.webviewView.webview);
    }
  }

  /** Brings the player on screen, opening the view if needed, and waits until its page can take commands. */
  private async reveal(): Promise<boolean> {
    if (!this.webviewView) {
      await this.showView();
    } else if (!this.webviewView.visible) {
      this.webviewView.show(true);
    }
    if (this.deviceProfile === undefined) {
      await Promise.race([new Promise<void>((resolve) => this.onReady.push(resolve)), timeout(WEBVIEW_TIMEOUT_MS)]);
    }
    return this.deviceProfile !== undefined;
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object' || !('type' in message)) {
      return;
    }
    const msg = message as Record<string, unknown>;

    switch (msg.type) {
      case 'ready':
        this.deviceProfile = msg.deviceProfile ?? {};
        this.compatibleProfile = msg.compatibleProfile ?? this.deviceProfile;
        this.onReady.splice(0).forEach((resolve) => resolve());
        this.post({ type: 'state', signedIn: this.auth.isSignedIn() });
        break;
      case 'command':
        if (typeof msg.command === 'string' && msg.command.startsWith('jellyfin.')) {
          await vscode.commands.executeCommand(msg.command);
        }
        break;
      case 'unloaded':
        this.onUnloaded.splice(0).forEach((resolve) => resolve(msg.positionTicks));
        break;
      case 'retryTranscode': {
        // First fall back from the original file to a transcode, then to the most compatible transcode.
        const wasTranscode = this.session?.playMethod === 'Transcode';
        await this.restart(
          { forceTranscode: true, compatible: wasTranscode },
          typeof msg.positionTicks === 'number' ? msg.positionTicks : undefined,
        );
        break;
      }
      case 'playbackEvent':
        await this.handlePlaybackEvent(msg);
        break;
    }
  }

  private async handlePlaybackEvent(msg: Record<string, unknown>): Promise<void> {
    const session = this.session;
    if (!session || msg.itemId !== session.itemId) {
      return;
    }
    if (typeof msg.positionTicks === 'number') {
      session.positionTicks = msg.positionTicks;
    }
    const client = this.auth.getClient();

    try {
      switch (msg.event) {
        case 'start':
          await client.reportPlaybackStart(session);
          break;
        case 'progress':
          await client.reportPlaybackProgress(session, false);
          break;
        case 'pause':
          await client.reportPlaybackProgress(session, true);
          break;
        case 'stopped':
          await this.stopSession();
          break;
      }
    } catch (err) {
      // Playback reporting is best-effort; surface quietly rather than interrupting playback.
      console.error('Jellyfin playback report failed', err);
    }
  }

  /** Tells the server playback ended, which saves the resume position and ends any transcode. */
  private async stopSession(): Promise<void> {
    const session = this.session;
    if (!session) {
      return;
    }
    this.session = undefined;
    try {
      await this.auth.getClient().reportPlaybackStopped(session);
    } catch (err) {
      console.error('Jellyfin playback report failed', err);
    }
    if (!this.restarting) {
      this.setNowPlaying(undefined);
      this.stopEmitter.fire();
    }
  }

  private renderHtml(webview: vscode.Webview): string {
    return renderPage(
      webview,
      this.extensionUri,
      this.auth,
      'player',
      /* html */ `
  <div id="idle">
    <p id="idle-text">Nothing is playing.</p>
    <button id="library-btn" data-command="jellyfin.openLibrary">Open Jellyfin Library</button>
  </div>
  <div id="player" class="hidden">
    <video id="video" controls controlslist="nodownload"></video>
    <button id="play-btn" class="hidden" title="Play" aria-label="Play">▶</button>
  </div>
  <div id="player-error" class="hidden"></div>`,
    );
  }
}
