import type {
  AuthResult,
  ItemsResult,
  JellyfinItem,
  MediaStream,
  PlaybackInfo,
  PlaybackSession,
  StreamInfo,
  StreamOptions,
} from './types';

const CLIENT_NAME = 'vscode-jellyfin';
const CLIENT_VERSION = '0.1.0';
const DEVICE_NAME = 'VS Code';
const MAX_STREAMING_BITRATE = 120_000_000;
const PAGE_SIZE = 100;

function authHeader(deviceId: string, token?: string): string {
  const parts = [
    `Client="${CLIENT_NAME}"`,
    `Device="${DEVICE_NAME}"`,
    `DeviceId="${deviceId}"`,
    `Version="${CLIENT_VERSION}"`,
  ];
  if (token) {
    parts.push(`Token="${token}"`);
  }
  return `MediaBrowser ${parts.join(', ')}`;
}

export class JellyfinApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class JellyfinClient {
  constructor(
    private serverUrl: string,
    private deviceId: string,
    private getToken: () => string | undefined,
  ) {}

  private get base(): string {
    return this.serverUrl.replace(/\/+$/, '');
  }

  private async send(
    path: string,
    init: { method?: string; body?: unknown; authenticated?: boolean } = {},
  ): Promise<string> {
    const { method = 'GET', body, authenticated = true } = init;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: authHeader(this.deviceId, authenticated ? this.getToken() : undefined),
    };

    const res = await fetch(`${this.base}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new JellyfinApiError(
        `Jellyfin request failed (${res.status} ${res.statusText}): ${path.split('?')[0]}${text ? ` — ${text}` : ''}`,
        res.status,
      );
    }
    return res.text();
  }

  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown; authenticated?: boolean } = {},
  ): Promise<T> {
    const text = await this.send(path, init);
    if (!text) {
      return undefined as T;
    }
    return JSON.parse(text) as T;
  }

  async authenticateByName(username: string, password: string): Promise<AuthResult> {
    return this.request<AuthResult>('/Users/AuthenticateByName', {
      method: 'POST',
      authenticated: false,
      body: { Username: username, Pw: password },
    });
  }

  async getResumeItems(userId: string): Promise<JellyfinItem[]> {
    const result = await this.request<ItemsResult>(`/Users/${userId}/Items/Resume?Limit=12&MediaTypes=Video`);
    return result.Items;
  }

  async getNextUp(userId: string): Promise<JellyfinItem[]> {
    const result = await this.request<ItemsResult>(`/Shows/NextUp?UserId=${userId}&Limit=12`);
    return result.Items;
  }

  async getLatestItems(userId: string): Promise<JellyfinItem[]> {
    return this.request<JellyfinItem[]>(`/Users/${userId}/Items/Latest?Limit=16`);
  }

  async getLibraries(userId: string): Promise<JellyfinItem[]> {
    const result = await this.request<ItemsResult>(`/Users/${userId}/Views`);
    return result.Items;
  }

  async getItem(userId: string, itemId: string): Promise<JellyfinItem> {
    return this.request<JellyfinItem>(`/Users/${userId}/Items/${itemId}`);
  }

  async getChildren(userId: string, parent: JellyfinItem, startIndex: number): Promise<ItemsResult> {
    const params = new URLSearchParams({
      ParentId: parent.Id,
      StartIndex: String(startIndex),
      Limit: String(PAGE_SIZE),
    });
    // Libraries are browsed flat, the way the official clients show them, rather than by disk folder.
    const flatType = { movies: 'Movie', tvshows: 'Series', music: 'MusicAlbum' }[parent.CollectionType ?? ''];
    if (flatType) {
      params.set('Recursive', 'true');
      params.set('IncludeItemTypes', flatType);
    }
    const indexed = parent.Type === 'Series' || parent.Type === 'Season' || parent.Type === 'MusicAlbum';
    params.set('SortBy', indexed ? 'ParentIndexNumber,IndexNumber,SortName' : 'IsFolder,SortName');
    params.set('SortOrder', indexed ? 'Ascending' : 'Descending,Ascending');
    return this.request<ItemsResult>(`/Users/${userId}/Items?${params}`);
  }

  async search(userId: string, term: string): Promise<JellyfinItem[]> {
    const params = new URLSearchParams({
      SearchTerm: term,
      Recursive: 'true',
      IncludeItemTypes: 'Movie,Series,Episode,Video,MusicAlbum,Audio',
      Limit: '50',
    });
    const result = await this.request<ItemsResult>(`/Users/${userId}/Items?${params}`);
    return result.Items;
  }

  /** Images are served without authentication, so no token ends up in the webview. */
  getImageUrl(item: JellyfinItem): string {
    const size = 'fillWidth=320&quality=90';
    if (item.ImageTags?.Primary) {
      return `${this.base}/Items/${item.Id}/Images/Primary?${size}&tag=${item.ImageTags.Primary}`;
    }
    if (item.SeriesId && item.SeriesPrimaryImageTag) {
      return `${this.base}/Items/${item.SeriesId}/Images/Primary?${size}&tag=${item.SeriesPrimaryImageTag}`;
    }
    return '';
  }

  /**
   * Asks the server how to play an item given what the webview can decode: either the
   * original file, or an HLS transcode when the container, codecs or chosen tracks require it.
   */
  async getStreamInfo(
    userId: string,
    item: JellyfinItem,
    deviceProfile: unknown,
    options: StreamOptions,
  ): Promise<StreamInfo> {
    const forceTranscode = Boolean(options.forceTranscode || options.compatible);
    let profile = deviceProfile as { CodecProfiles?: unknown[] } | undefined;
    if (options.maxWidth !== undefined) {
      // Wider video then fails this condition, so the server transcodes it, scaled down to fit.
      const narrow = {
        Type: 'Video',
        Conditions: [
          { Condition: 'LessThanEqual', Property: 'Width', Value: String(options.maxWidth), IsRequired: false },
        ],
      };
      profile = { ...profile, CodecProfiles: [...(profile?.CodecProfiles ?? []), narrow] };
    }
    const info = await this.request<PlaybackInfo>(`/Items/${item.Id}/PlaybackInfo?UserId=${userId}`, {
      method: 'POST',
      body: {
        UserId: userId,
        DeviceProfile: profile,
        MaxStreamingBitrate: MAX_STREAMING_BITRATE,
        AutoOpenLiveStream: true,
        EnableDirectPlay: !forceTranscode,
        EnableDirectStream: !forceTranscode,
        EnableTranscoding: true,
        AudioStreamIndex: options.audioIndex,
        SubtitleStreamIndex: options.subtitleIndex,
      },
    });
    const source = info.MediaSources?.[0];
    if (!source) {
      throw new Error(info.ErrorCode ? `Server refused playback (${info.ErrorCode})` : 'No playable media source');
    }

    const token = encodeURIComponent(this.getToken() ?? '');
    const direct = !forceTranscode && (source.SupportsDirectPlay || source.SupportsDirectStream);
    let url: string;
    if (direct) {
      const kind = item.MediaType === 'Audio' ? 'Audio' : 'Videos';
      const params = new URLSearchParams({ Static: 'true', MediaSourceId: source.Id, DeviceId: this.deviceId });
      if (source.ETag) {
        params.set('Tag', source.ETag);
      }
      const extension = source.Container ? `.${source.Container.split(',')[0]}` : '';
      url = `${this.base}/${kind}/${item.Id}/stream${extension}?${params}&api_key=${token}`;
    } else if (source.TranscodingUrl) {
      url = `${this.base}${source.TranscodingUrl}`;
    } else {
      throw new Error('This item cannot be played or transcoded for VS Code');
    }

    const streams = source.MediaStreams ?? [];
    const label = (stream: MediaStream, kind: string) =>
      stream.DisplayTitle ?? stream.Language ?? `${kind} ${stream.Index}`;

    return {
      url,
      mediaSourceId: source.Id,
      playSessionId: info.PlaySessionId,
      playMethod: direct ? 'DirectPlay' : 'Transcode',
      audioTracks: streams
        .filter((stream) => stream.Type === 'Audio')
        .map((stream) => ({ index: stream.Index, label: label(stream, 'Audio') })),
      subtitleTracks: streams
        .filter((stream) => stream.Type === 'Subtitle')
        .map((stream) => ({
          index: stream.Index,
          label: label(stream, 'Subtitle'),
          language: stream.Language ?? '',
          // Ask for WebVTT, the one format the video element renders, instead of the stored format.
          url:
            stream.DeliveryMethod === 'External'
              ? stream.DeliveryUrl?.replace(/\/Stream\.\w+(?=\?|$)/, '/Stream.vtt')
              : undefined,
        })),
      audioIndex: options.audioIndex ?? source.DefaultAudioStreamIndex,
      subtitleIndex: options.subtitleIndex ?? source.DefaultSubtitleStreamIndex ?? -1,
      videoWidth: streams.find((stream) => stream.Type === 'Video')?.Width,
    };
  }

  /** Fetches a subtitle file through the extension host, which isn't subject to the webview's CORS rules. */
  async getSubtitle(deliveryUrl: string): Promise<string> {
    return this.send(deliveryUrl);
  }

  async reportPlaybackStart(session: PlaybackSession): Promise<void> {
    await this.request('/Sessions/Playing', {
      method: 'POST',
      body: { ...this.playstateBody(session), CanSeek: true, IsPaused: false },
    });
  }

  async reportPlaybackProgress(session: PlaybackSession, isPaused: boolean): Promise<void> {
    await this.request('/Sessions/Playing/Progress', {
      method: 'POST',
      body: { ...this.playstateBody(session), CanSeek: true, IsPaused: isPaused },
    });
  }

  async reportPlaybackStopped(session: PlaybackSession): Promise<void> {
    await this.request('/Sessions/Playing/Stopped', {
      method: 'POST',
      body: this.playstateBody(session),
    });
  }

  private playstateBody(session: PlaybackSession): Record<string, unknown> {
    return {
      ItemId: session.itemId,
      MediaSourceId: session.mediaSourceId,
      PlaySessionId: session.playSessionId,
      PositionTicks: session.positionTicks,
      PlayMethod: session.playMethod,
    };
  }
}
