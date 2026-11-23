(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  const video = $('video');
  const idle = $('idle');
  const player = $('player');
  const playerError = $('player-error');
  const playBtn = $('play-btn');

  const TICKS_PER_SECOND = 10000000;
  const PROGRESS_INTERVAL_MS = 10000;
  /** How long after a seek is settled (dragging, arrow keys) before a new stream is requested. */
  const SEEK_SETTLE_MS = 400;
  /** How long the mouse must stay still before the control bar fades out. */
  const CONTROLS_IDLE_MS = 2500;
  /** A stream that fails sooner than this after reconnecting isn't retried again. */
  const RECONNECT_GUARD_MS = 15000;

  function setHidden(element, hidden) {
    element.classList.toggle('hidden', hidden);
  }

  // ---- Playback -----------------------------------------------------------

  // The item in the player: { itemId, canRetry, started, paused, position, lastReport, seekByRestart,
  // offset, duration }. `position` and `duration` are in seconds of the item. A stream that is seeked
  // by restarting begins at `offset`, so the video element's own time counts from there.
  let current = null;
  let subtitleUrl = null;
  let reconnectedAt = 0;
  /** Playback rate chosen in the extension, kept across items and restarted streams. */
  let speed = 1;

  function applySpeed() {
    // Loading a new source resets the rate to the default one, so both are set.
    video.defaultPlaybackRate = speed;
    video.playbackRate = speed;
  }

  function positionTicks() {
    return Math.round(current.position * TICKS_PER_SECOND);
  }

  function report(event) {
    if (current) {
      vscode.postMessage({ type: 'playbackEvent', event, itemId: current.itemId, positionTicks: positionTicks() });
    }
  }

  function unloadVideo() {
    current = null;
    setHidden(playBtn, true);
    video.pause();
    showSubtitle(null);
    video.removeAttribute('src');
    video.load();
  }

  /** Replaces the subtitle track on the video with the given WebVTT text, or removes it. */
  function showSubtitle(msg) {
    video.replaceChildren();
    if (subtitleUrl) {
      URL.revokeObjectURL(subtitleUrl);
      subtitleUrl = null;
    }
    if (!msg || !msg.vtt) {
      return;
    }
    subtitleUrl = URL.createObjectURL(new Blob([msg.vtt], { type: 'text/vtt' }));
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = msg.label || 'Subtitles';
    track.srclang = msg.language || '';
    track.src = subtitleUrl;
    track.addEventListener('load', () => {
      // Styled (ASS) subtitles often repeat a line once per layer of an effect; as plain text that is just clutter.
      const seen = new Set();
      for (const cue of Array.from(track.track.cues || [])) {
        const key = `${cue.startTime}|${cue.endTime}|${cue.text}`;
        if (seen.has(key)) {
          track.track.removeCue(cue);
        }
        seen.add(key);
      }
    });
    video.appendChild(track);
    track.track.mode = 'showing';
  }

  function showPlayer(visible) {
    setHidden(player, !visible);
    setHidden(idle, visible);
  }

  function showPlayerError(text) {
    playerError.textContent = text;
    setHidden(playerError, !text);
  }

  function startPlayback(msg) {
    unloadVideo();
    showPlayerError('');
    const position = (msg.positionTicks || 0) / TICKS_PER_SECOND;
    current = {
      itemId: msg.itemId,
      canRetry: msg.canRetry,
      started: false,
      paused: false,
      position,
      lastReport: 0,
      seekByRestart: Boolean(msg.seekByRestart),
      offset: msg.seekByRestart ? position : 0,
      timesChecked: !msg.seekByRestart,
      duration: msg.durationTicks ? msg.durationTicks / TICKS_PER_SECOND : null,
    };
    // A continuous transcode has no length the video element knows, so its own seek bar is no use.
    video.controls = !current.seekByRestart;
    setHidden(controls, !current.seekByRestart);
    player.classList.remove('idle');
    updateControls();
    showPlayer(true);
    video.src = msg.streamUrl;
    applySpeed();
    // Sound may only start from a click inside this view. The first item is picked in the library
    // view instead, so it loads paused here behind a play button; later ones start by themselves.
    video.play().catch((err) => setHidden(playBtn, !current || err.name !== 'NotAllowedError'));
  }

  /** Has the extension request the stream again, starting at `seconds` into the item. */
  function restartFrom(seconds) {
    const { itemId } = current;
    unloadVideo();
    vscode.postMessage({ type: 'seek', itemId, positionTicks: Math.round(seconds * TICKS_PER_SECOND) });
  }

  function stopPlayback() {
    report('stopped');
    unloadVideo();
    showPlayer(false);
  }

  video.addEventListener('loadedmetadata', () => {
    if (current && !current.seekByRestart && !current.started && current.position > 0) {
      video.currentTime = current.position;
    }
  });

  video.addEventListener('playing', () => {
    if (!current) {
      return;
    }
    if (!current.started) {
      current.started = true;
      current.lastReport = Date.now();
      report('start');
    } else if (current.paused) {
      report('progress');
    }
    current.paused = false;
  });

  video.addEventListener('pause', () => {
    if (current && current.started && !video.ended) {
      current.paused = true;
      report('pause');
    }
  });

  video.addEventListener('timeupdate', () => {
    if (!current || !current.started) {
      return;
    }
    if (!current.timesChecked) {
      // Checked once per stream: the server may have kept the item's own timestamps instead of starting at zero.
      current.timesChecked = true;
      if (current.offset > 30 && video.currentTime > current.offset - 30) {
        current.offset = 0;
      }
    }
    current.position = current.offset + video.currentTime;
    updateControls();
    const now = Date.now();
    if (now - current.lastReport >= PROGRESS_INTERVAL_MS) {
      current.lastReport = now;
      report('progress');
    }
  });

  video.addEventListener('seeked', () => {
    if (current && current.started) {
      current.position = current.offset + video.currentTime;
      current.lastReport = Date.now();
      report(video.paused ? 'pause' : 'progress');
    }
  });

  video.addEventListener('ended', () => {
    if (!current) {
      return;
    }
    // A transcode cut off early can look like the end of the item; pick it up again instead.
    const cutOff = current.seekByRestart && current.duration && current.position < current.duration - 30;
    if (cutOff && Date.now() - reconnectedAt > RECONNECT_GUARD_MS) {
      reconnectedAt = Date.now();
      restartFrom(current.position);
    } else {
      stopPlayback();
    }
  });

  video.addEventListener('error', () => {
    if (!current) {
      return;
    }
    const { itemId, canRetry } = current;
    if (current.seekByRestart && current.started && Date.now() - reconnectedAt > RECONNECT_GUARD_MS) {
      // A transcode that was playing has broken off, typically after a long pause; carry on from here.
      reconnectedAt = Date.now();
      restartFrom(current.position);
    } else if (canRetry) {
      // It should have played but didn't; ask the server for a more conservative stream instead.
      const ticks = positionTicks();
      unloadVideo();
      vscode.postMessage({ type: 'retryTranscode', itemId, positionTicks: ticks });
    } else {
      stopPlayback();
      showPlayerError('This item could not be played.');
    }
  });

  playBtn.addEventListener('click', () => video.play().catch(() => {}));
  video.addEventListener('play', () => setHidden(playBtn, true));

  // ---- Controls for streams seeked by restarting --------------------------

  const controls = $('controls');
  const ctlPlay = $('ctl-play');
  const ctlTime = $('ctl-time');
  const ctlSeek = $('ctl-seek');
  const ctlDuration = $('ctl-duration');
  const ctlMute = $('ctl-mute');
  const ctlVolume = $('ctl-volume');
  let seeking = false;
  let seekTimer;

  function formatTime(seconds) {
    const total = Math.max(0, Math.floor(seconds || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  function itemDuration() {
    if (current.duration) {
      return current.duration;
    }
    return Number.isFinite(video.duration) ? current.offset + video.duration : null;
  }

  function updateControls() {
    if (!current || !current.seekByRestart) {
      return;
    }
    const length = itemDuration();
    ctlSeek.disabled = !length;
    ctlSeek.max = String(Math.floor(length || 0));
    ctlDuration.textContent = length ? formatTime(length) : '--:--';
    if (!seeking) {
      ctlSeek.value = String(Math.floor(current.position));
      ctlTime.textContent = formatTime(current.position);
    }
  }

  /** Moves within the stream when the player can, or else asks for the stream again from the new position. */
  function seekTo(seconds) {
    if (!current) {
      return;
    }
    // A download without byte ranges can't be seeked even where it has already arrived; then this is empty.
    const local = seconds - current.offset;
    const seekable = video.seekable;
    for (let i = 0; i < seekable.length; i++) {
      if (local >= seekable.start(i) && local <= seekable.end(i)) {
        video.currentTime = local;
        return;
      }
    }
    restartFrom(seconds);
  }

  ctlSeek.addEventListener('input', () => {
    seeking = true;
    ctlTime.textContent = formatTime(Number(ctlSeek.value));
  });
  ctlSeek.addEventListener('change', () => {
    clearTimeout(seekTimer);
    seekTimer = setTimeout(() => {
      seeking = false;
      seekTo(Number(ctlSeek.value));
    }, SEEK_SETTLE_MS);
  });

  function togglePlay() {
    if (video.paused) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      player.requestFullscreen().catch(() => {});
    }
  }

  ctlPlay.addEventListener('click', togglePlay);
  video.addEventListener('click', () => current && current.seekByRestart && togglePlay());
  video.addEventListener('dblclick', () => current && current.seekByRestart && toggleFullscreen());
  $('ctl-fullscreen').addEventListener('click', toggleFullscreen);
  for (const event of ['play', 'pause', 'emptied']) {
    video.addEventListener(event, () => {
      ctlPlay.textContent = video.paused ? '▶' : '❚❚';
      ctlPlay.title = video.paused ? 'Play' : 'Pause';
      ctlPlay.setAttribute('aria-label', ctlPlay.title);
    });
  }
  video.addEventListener('durationchange', updateControls);

  // The bar sits over the picture, so it fades out while the video plays and the mouse is still.
  let idleTimer;
  function wakeControls() {
    player.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!video.paused && !seeking && !controls.matches(':hover, :focus-within')) {
        player.classList.add('idle');
      }
    }, CONTROLS_IDLE_MS);
  }
  player.addEventListener('mousemove', wakeControls);
  player.addEventListener('mouseleave', () => {
    if (!video.paused && !seeking) {
      clearTimeout(idleTimer);
      player.classList.add('idle');
    }
  });
  controls.addEventListener('focusin', wakeControls);
  video.addEventListener('play', wakeControls);
  video.addEventListener('pause', () => {
    clearTimeout(idleTimer);
    player.classList.remove('idle');
  });

  // The native controls have their own speed menu; keep the extension's choice in step with it.
  video.addEventListener('ratechange', () => {
    if (current && video.playbackRate !== speed && video.playbackRate > 0) {
      speed = video.playbackRate;
      video.defaultPlaybackRate = speed;
      vscode.postMessage({ type: 'speed', speed });
    }
  });

  ctlMute.addEventListener('click', () => {
    video.muted = !video.muted;
  });
  ctlVolume.addEventListener('input', () => {
    video.volume = Number(ctlVolume.value);
    video.muted = video.volume === 0;
  });
  video.addEventListener('volumechange', () => {
    const silent = video.muted || video.volume === 0;
    ctlMute.textContent = silent ? '🔇' : '🔊';
    ctlMute.title = silent ? 'Unmute' : 'Mute';
    ctlMute.setAttribute('aria-label', ctlMute.title);
    ctlVolume.value = String(video.muted ? 0 : video.volume);
  });
  for (const button of document.querySelectorAll('[data-command]')) {
    button.addEventListener('click', () => vscode.postMessage({ type: 'command', command: button.dataset.command }));
  }

  // ---- Size ---------------------------------------------------------------

  const RESIZE_SETTLE_MS = 1500;
  let resizeTimer;

  /** How many screen pixels wide the picture can be drawn, which is all the resolution worth streaming. */
  function pictureWidth() {
    const fullscreen = Boolean(document.fullscreenElement);
    const width = fullscreen ? screen.width : window.innerWidth;
    const height = fullscreen ? screen.height : window.innerHeight;
    const aspect = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
    return Math.round(Math.min(width, height * aspect) * window.devicePixelRatio);
  }

  // A change of size can mean a new stream, so wait until the view has stopped being dragged.
  function reportSize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => vscode.postMessage({ type: 'size', pictureWidth: pictureWidth() }), RESIZE_SETTLE_MS);
  }

  window.addEventListener('resize', reportSize);
  document.addEventListener('fullscreenchange', reportSize);

  // ---- Capabilities -------------------------------------------------------

  // A tenth of a second of silence in formats that VS Code says it can play but, in Microsoft's
  // builds, cannot: its Chromium reports AAC, Opus and Matroska/WebM as supported, then fails to
  // decode them (video with AAC sound simply plays mute). Loading a real sample is the only honest test.
  const PROBES = {
    aac: ['audio/mp4', 'AAAAHGZ0eXBNNEEgAAACAE00QSBpc29taXNvMgAAAAhmcmVlAAAAEG1kYXQBGCAHARggBwAAAtZtb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAB9AAAADIAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAACJXRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAADIAAAAAAAAAAAAAAAAQEAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAACRlZHRzAAAAHGVsc3QAAAAAAAAAAQAAAyAAAAQAAAEAAAAAAZ1tZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAB9AAAAHIFXEAAAAAAAtaGRscgAAAAAAAAAAc291bgAAAAAAAAAAAAAAAFNvdW5kSGFuZGxlcgAAAAFIbWluZgAAABBzbWhkAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAAEMc3RibAAAAGpzdHNkAAAAAAAAAAEAAABabXA0YQAAAAAAAAABAAAAAAAAAAAAAQAQAAAAAB9AAAAAAAA2ZXNkcwAAAAADgICAJQABAASAgIAXQBUAAAAAAB9AAAABGAWAgIAFFYhW5QAGgICAAQIAAAAgc3R0cwAAAAAAAAACAAAAAQAABAAAAAABAAADIAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAgAAAAEAAAAUc3RzegAAAAAAAAAEAAAAAgAAABRzdGNvAAAAAAAAAAEAAAAsAAAAGnNncGQBAAAAcm9sbAAAAAIAAAAB//8AAAAcc2JncAAAAAByb2xsAAAAAQAAAAIAAAABAAAAPXVkdGEAAAA1bWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAIaWxzdA=='],
    opus: ['audio/ogg', 'T2dnUwACAAAAAAAAAAAAAAAAAAAAAGS5xGoBE09wdXNIZWFkAQE4AUAfAAAAAABPZ2dTAAAAAAAAAAAAAAAAAAABAAAASZW+VAEuT3B1c1RhZ3MGAAAAZmZtcGVnAQAAABQAAABlbmNvZGVyPUxhdmMgbGlib3B1c09nZ1MABPgTAAAAAAAAAAAAAAIAAABBShkFBgcGBgYGBggL5jsjq2AICKyzDsYICKyzDsYICKyzDsYICKyzDsYICKyzDsY='],
    mkv: ['audio/x-matroska', 'GkXfo6NChoEBQveBAULygQRC84EIQoKIbWF0cm9za2FCh4EEQoWBAhhTgGcBAAAAAAAC/RFNm3TAv4QtHLQYTbuLU6uEFUmpZlOsgaFNu4tTq4QWVK5rU6yBzE27jFOrhBJUw2dTrIIBL027jFOrhBxTu2tTrIIC4ewBAAAAAAAAUwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFUmpZqa/hLwp678q17GDD0JATYCETGF2ZldBhExhdmZEiYhAbcAAAAAAABZUrmvev4RhLsw9rgEAAAAAAABP14EBc8WIAAAAAAAAAAGcgQAitZyDdW5kiIEAholBX01QRUcvTDNWqoQIO57Ig4ECI+ODhARKogDhkZ+BAbWIQL9AAAAAAABiZIEQVe6BABJUw2fav4Q7JS0Zc3PRY8CLY8WIAAAAAAAAAAFnyJxFo4dFTkNPREVSRIePTGF2YyBsaWJtcDNsYW1lZ8ihRaOIRFVSQVRJT05Eh5MwMDowMDowMC4yMzgwMDAwMDAAH0O2dUFNv4Q/aWBJ54EAo8yBAACA/+MYxAAAAANIAAAAAExBTUU0LjBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVo8yBAEiA/+MYxDsAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVo8yBAJCA/+MYxHYAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVoNihzIEA2AD/4xjEsQAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVWbgRZ1ooQC+Qg4HFO7a5e/hPtqFjW7j7OBALeK94EB8YIBjvCBCQ=='],
  };
  const PROBE_TIMEOUT_MS = 3000;

  function probe([type, base64]) {
    return new Promise((resolve) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type }));
      const audio = new Audio();
      const finish = (supported) => {
        URL.revokeObjectURL(url);
        resolve(supported);
      };
      audio.addEventListener('loadedmetadata', () => finish(true));
      audio.addEventListener('error', () => finish(false));
      setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
      audio.src = url;
    });
  }

  /** Describes what this webview can decode, so the server knows when it has to transcode. */
  function buildDeviceProfile(probed, compatible) {
    const can = (type) => video.canPlayType(type) !== '';
    const list = (codecs) => Object.keys(codecs).filter((name) => codecs[name]).join(',');
    const union = (...lists) => [...new Set(lists.join(',').split(',').filter(Boolean))].join(',');

    const mp4Video = list({
      h264: can('video/mp4; codecs="avc1.640028"'),
      hevc: can('video/mp4; codecs="hvc1.1.6.L93.B0"'),
      vp9: can('video/mp4; codecs="vp09.00.10.08"'),
      av1: can('video/mp4; codecs="av01.0.05M.08"'),
    });
    const mp4Audio = list({
      aac: probed.aac,
      mp3: can('audio/mpeg'),
      opus: probed.opus,
      flac: can('audio/flac'),
      ac3: can('audio/mp4; codecs="ac-3"'),
      eac3: can('audio/mp4; codecs="ec-3"'),
    });
    const webmVideo = list({
      vp8: can('video/webm; codecs="vp8"'),
      vp9: can('video/webm; codecs="vp9"'),
      av1: can('video/webm; codecs="av01.0.05M.08"'),
    });
    const webmAudio = list({
      vorbis: can('audio/ogg; codecs="vorbis"'),
      opus: probed.opus,
    });

    const directPlay = [];
    if (mp4Video) {
      directPlay.push({ Container: 'mp4,m4v,mov', Type: 'Video', VideoCodec: mp4Video, AudioCodec: mp4Audio });
    }
    if (probed.mkv) {
      directPlay.push({
        Container: 'mkv',
        Type: 'Video',
        VideoCodec: union(mp4Video, webmVideo),
        AudioCodec: union(mp4Audio, webmAudio),
      });
      directPlay.push({ Container: 'webm', Type: 'Video', VideoCodec: webmVideo, AudioCodec: webmAudio });
    }
    const audioContainers = list({
      mp3: can('audio/mpeg'),
      flac: can('audio/flac'),
      wav: can('audio/wav'),
      'aac,m4a,m4b': probed.aac,
      'ogg,oga': can('audio/ogg; codecs="vorbis"'),
      opus: probed.opus,
      'webma,mka': probed.mkv,
    });
    for (const container of audioContainers.split(',').filter(Boolean)) {
      directPlay.push({ Container: container, Type: 'Audio' });
    }

    const transcoding = [
      { Container: 'mp3', Type: 'Audio', AudioCodec: 'mp3', Context: 'Streaming', Protocol: 'http', MaxAudioChannels: '2' },
    ];
    if (can('application/vnd.apple.mpegurl')) {
      // Preferred: fMP4 segments, which can carry AV1 as well as H.264 untouched, and audio converted
      // losslessly to FLAC when the original can't be decoded here. The compatible variant is the
      // older MPEG-TS/MP3 combination, kept as a fallback for servers or files where that fails.
      const copyVideo = list({ h264: true, av1: !compatible && can('video/mp4; codecs="av01.0.05M.08"') });
      const audio = compatible
        ? list({ aac: probed.aac, mp3: true })
        : list({ aac: probed.aac, opus: probed.opus, flac: can('audio/flac'), mp3: !can('audio/flac') });
      transcoding.push({
        Container: compatible ? 'ts' : 'mp4',
        Type: 'Video',
        VideoCodec: copyVideo,
        AudioCodec: audio,
        Context: 'Streaming',
        Protocol: 'hls',
        MaxAudioChannels: '2',
        MinSegments: '1',
        BreakOnNonKeyFrames: true,
      });
    } else {
      // VS Code has neither HLS nor Media Source Extensions, so a transcode has to arrive as one
      // continuous fragmented MP4 download that the video element plays as it comes in.
      transcoding.push({
        Container: 'mp4',
        Type: 'Video',
        VideoCodec: 'h264',
        AudioCodec: compatible ? 'mp3' : list({ aac: probed.aac, flac: can('audio/flac'), mp3: true }),
        Context: 'Streaming',
        Protocol: 'http',
        MaxAudioChannels: '2',
      });
    }

    return {
      Name: 'VS Code',
      MaxStreamingBitrate: 120000000,
      MaxStaticBitrate: 120000000,
      DirectPlayProfiles: directPlay,
      TranscodingProfiles: transcoding,
      CodecProfiles: [
        {
          // Chromium only decodes 8-bit H.264.
          Type: 'Video',
          Codec: 'h264',
          Conditions: [{ Condition: 'LessThanEqual', Property: 'VideoBitDepth', Value: '8', IsRequired: false }],
        },
      ],
      // Text subtitles are fetched separately and drawn by the player, whatever format they are stored in
      // (the server converts them to WebVTT on request). Anything else has to be drawn onto the video.
      SubtitleProfiles: ['vtt', 'srt', 'subrip', 'ass', 'ssa'].map((Format) => ({ Format, Method: 'External' })),
    };
  }

  // ---- Messages from the extension ----------------------------------------

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'play':
        startPlayback(msg);
        break;
      case 'unload': {
        const ticks = current ? positionTicks() : undefined;
        unloadVideo();
        vscode.postMessage({ type: 'unloaded', positionTicks: ticks });
        break;
      }
      case 'playError':
        showPlayer(false);
        showPlayerError(`Could not play this item: ${msg.message}`);
        break;
      case 'speed':
        if (typeof msg.speed === 'number' && msg.speed > 0) {
          speed = msg.speed;
          applySpeed();
        }
        break;
      case 'subtitle':
        if (current && current.itemId === msg.itemId) {
          showSubtitle(msg);
        }
        break;
      case 'state':
        $('idle-text').textContent = msg.signedIn ? 'Nothing is playing.' : 'Not signed in to Jellyfin.';
        break;
      case 'command':
        if (!current) {
          break;
        } else if (msg.command === 'stop') {
          stopPlayback();
        } else if (video.paused) {
          video.play().catch(() => {});
        } else {
          video.pause();
        }
        break;
    }
  });

  Promise.all([probe(PROBES.aac), probe(PROBES.opus), probe(PROBES.mkv)]).then(([aac, opus, mkv]) => {
    const probed = { aac, opus, mkv };
    vscode.postMessage({
      type: 'ready',
      pictureWidth: pictureWidth(),
      deviceProfile: buildDeviceProfile(probed, false),
      compatibleProfile: buildDeviceProfile(probed, true),
    });
  });
})();
