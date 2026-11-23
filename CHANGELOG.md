# Changelog

## 0.1.1

- Fix "This item cannot be played or transcoded for VS Code" for every item that needs
  converting. Current VS Code has no HLS support, which the player relied on, so the
  server now sends converted video as one continuous MP4 stream instead.
- A control bar with seeking for converted streams: seeking restarts the stream on the
  server at the new position, and a stream that breaks off resumes where it was.
- Playback speed, from 0.5× to 2×: a **Speed** button next to Audio and Subtitles, in
  the player view's menu, and `ctrl+alt+j p`.
- Run only on the local (UI) side. In Remote Development windows the extension now
  always installs and runs next to the VS Code window, never on the remote.

## 0.1.0

First release.

- Library view in the activity bar: Continue Watching, Next Up, libraries, Recently
  Added, browsing and search.
- Player view that starts in the Explorer side bar and can be moved anywhere.
- Playback negotiated with the server from what this VS Code can actually decode, with
  automatic fallback to a transcode.
- Audio track and subtitle selection, and loading `.srt`/`.vtt` subtitle files.
- Optional scaling of video to the size of the player view.
- Switch user, change server and sign out from the library view.
