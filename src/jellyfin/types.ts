export interface JellyfinUser {
  Id: string;
  Name: string;
}

export interface AuthResult {
  AccessToken: string;
  ServerId: string;
  User: JellyfinUser;
}

export interface JellyfinItem {
  Id: string;
  Name: string;
  Type: string;
  IsFolder?: boolean;
  MediaType?: string;
  CollectionType?: string;
  SeriesName?: string;
  SeriesId?: string;
  SeriesPrimaryImageTag?: string;
  IndexNumber?: number;
  ParentIndexNumber?: number;
  ProductionYear?: number;
  ImageTags?: Record<string, string>;
  UserData?: {
    PlaybackPositionTicks?: number;
    PlayedPercentage?: number;
    Played?: boolean;
  };
}

export interface ItemsResult {
  Items: JellyfinItem[];
  TotalRecordCount?: number;
}

export interface MediaStream {
  Type: string;
  Index: number;
  DisplayTitle?: string;
  Language?: string;
  Codec?: string;
  DeliveryMethod?: string;
  DeliveryUrl?: string;
}

export interface MediaSource {
  Id: string;
  Container?: string;
  ETag?: string;
  SupportsDirectPlay?: boolean;
  SupportsDirectStream?: boolean;
  TranscodingUrl?: string;
  DefaultAudioStreamIndex?: number;
  DefaultSubtitleStreamIndex?: number;
  MediaStreams?: MediaStream[];
}

export interface PlaybackInfo {
  MediaSources?: MediaSource[];
  PlaySessionId?: string;
  ErrorCode?: string;
}

export type PlayMethod = 'DirectPlay' | 'Transcode';

export interface AudioTrack {
  index: number;
  label: string;
}

export interface SubtitleTrack {
  index: number;
  label: string;
  language: string;
  /** Where to fetch the text from; absent for image subtitles, which the server has to draw onto the video. */
  url?: string;
}

/** What the user asked for. Anything left undefined is the server's choice. */
export interface StreamOptions {
  forceTranscode?: boolean;
  /** Use the older, most widely supported transcode format. Implies `forceTranscode`. */
  compatible?: boolean;
  audioIndex?: number;
  /** -1 turns subtitles off. */
  subtitleIndex?: number;
}

export interface StreamInfo {
  url: string;
  mediaSourceId: string;
  playSessionId: string | undefined;
  playMethod: PlayMethod;
  audioTracks: AudioTrack[];
  subtitleTracks: SubtitleTrack[];
  audioIndex: number | undefined;
  subtitleIndex: number;
}

export interface PlaybackSession {
  itemId: string;
  mediaSourceId: string;
  playSessionId: string;
  playMethod: PlayMethod;
  positionTicks: number;
  forceTranscode: boolean;
  compatible: boolean;
  audioIndex: number | undefined;
  /** -1 when subtitles are off. */
  subtitleIndex: number;
}
