# Jellyfin for VS Code

A small Jellyfin client inside VS Code, in two views:

- **Jellyfin** (activity bar icon) — the library: Continue Watching, Next Up, your
  libraries, Recently Added, folder/series browsing and search.
- **Jellyfin** (a section of the Explorer side bar, next to Outline and Timeline) —
  the video player, and nothing else.

Picking something in the library plays it in the player view. Both are ordinary VS
Code views, so you can drag either one anywhere: the bottom panel, the secondary side
bar, or its own activity bar entry. For example, drag the player to the panel to keep
the library and the video on screen together.

With the Remote Development extensions (SSH, WSL, containers) this extension runs on
your local machine, next to the VS Code window, so it never needs installing on the
remote and reaches the Jellyfin server from your own network.

## Setup

1. `npm install`
2. `npm run compile` (or `npm run watch` while developing)
3. Press `F5` to launch an Extension Development Host.
4. Click the **Jellyfin** icon in the activity bar and choose **Sign In**.

Server URL and username are stored as regular settings (`jellyfin.serverUrl`,
`jellyfin.username`), editable from the Settings UI. Only the access token is kept,
in VS Code's SecretStorage; the password is never stored. Changing the server URL
signs you out.

## Commands / default shortcuts

All default keybindings use a `ctrl+alt+j` chord prefix to avoid clobbering your
existing bindings. Rebind any of them via `Preferences: Open Keyboard Shortcuts`.

| Command | Default key | Notes |
|---|---|---|
| Jellyfin: Sign In | — | |
| Jellyfin: Sign Out | — | |
| Jellyfin: Open Library | `ctrl+alt+j l` | focuses the library view |
| Jellyfin: Show Player | `ctrl+alt+j s` | un-hides and focuses the player view |
| Jellyfin: Hide Player | `ctrl+alt+j h` | removes the player view; stops playback |
| Jellyfin: Toggle Player | `ctrl+alt+j j` | |
| Jellyfin: Play/Pause | `ctrl+alt+j space` | |
| Jellyfin: Stop | `ctrl+alt+j x` | saves the position and closes the video |
| Jellyfin: Select Audio Track | `ctrl+alt+j a` | |
| Jellyfin: Select Subtitles | `ctrl+alt+j c` | pick a track, turn them off, or load a `.srt`/`.vtt` file |
| Jellyfin: Toggle Match Video Resolution to Player Size | `ctrl+alt+j r` | see [Matching the player's size](#matching-the-players-size) |
| Jellyfin: Switch User | — | |
| Jellyfin: Change Server | — | |
| Jellyfin: Refresh | — | reloads the library view |

Hiding the player works wherever you have moved it. It closes the video, so the
position is saved to the server first and the item shows up under Continue Watching.

## Playback

The player asks the server how to play each item (`/Items/{id}/PlaybackInfo`) and
sends it a description of what this VS Code can decode. Files it can decode are
streamed as they are. Everything else is sent by the server as HLS in fMP4 segments:
H.264 and AV1 video is passed through untouched, other video is converted to H.264,
and audio that can't be decoded here is converted to FLAC, which is lossless. If that
stream fails to play, the player retries once with the older MPEG-TS / MP3 format.

Microsoft's VS Code builds cannot decode AAC or Opus audio, or open MKV/WebM files,
even though their Chromium reports that it can — a video with AAC sound plays silent
rather than failing. So the player tests a few tiny samples at startup instead of
trusting what Chromium reports. In practice that means most libraries are transcoded
(audio only, usually) on stock VS Code, while builds with full codecs play directly.
If a file that was expected to play fails anyway, the player retries it as a
transcode.

While something is playing, the bottom of the library view shows its title with
**Audio**, **Subtitles**, **Fit size** and **Stop** buttons (the same actions are in
the player view's `…` menu and the Command Palette). The player view itself is only the video.

### Matching the player's size

A 1080p stream shown in a narrow side bar is mostly wasted bandwidth. With **Fit size**
on (the `jellyfin.matchPlayerSize` setting, off by default), the server scales video
down to the size the player view is drawn at, counting the display's pixel density.

- Sizes go in steps (426, 640, 854, 1280, 1920, 2560, 3840 pixels wide), and video is
  never scaled up: a view wider than the video gets the video as it is.
- Resizing the view, or going fullscreen, into a different step restarts the stream at
  the same position once the size has been still for a moment.
- Scaled video has to be re-encoded by the server, where it would otherwise be sent
  untouched. Leave this off for a server without hardware transcoding, or on a fast
  local network.

- **Subtitles** lists the item's subtitle tracks, plus **Off** and **Load subtitle
  file…** for a `.srt` or `.vtt` on your computer. Text tracks (SRT, ASS, …) are
  fetched from the server as plain text and drawn by the player, so switching them is
  instant; ASS styling and positioning are not kept. Image subtitles (PGS, VobSub)
  have to be drawn onto the video by the server, which restarts the stream.
- **Audio** switches the audio track. The player can't switch tracks inside a file,
  so the server sends the stream again with the chosen one, from the same position.
- A loaded subtitle file only applies to the video being played; nothing is uploaded
  to the server.

The very bottom of the library view shows who is signed in and where, with **Switch
user**, **Change server** and **Sign out**. A new sign-in replaces the current one
only if it succeeds.

Progress is reported through Jellyfin's Playstate API (`/Sessions/Playing`,
`/Progress`, `/Stopped`) on start, pause, seek, stop and every ~10s, so resume
position and watched status update the way they do with official clients.

## Known limitations

- VS Code only lets sound start from a click inside the player view. The first video
  you pick therefore loads paused behind a play button; after you press it once,
  later videos start by themselves until the player view is closed or hidden.
- Transcoding needs the HLS support built into recent VS Code versions (the player
  uses Chromium's native HLS). On older versions only directly playable files work.
- No quality picker and no next-episode queue.
