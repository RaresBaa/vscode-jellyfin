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

  function setHidden(element, hidden) {
    element.classList.toggle('hidden', hidden);
  }

  // ---- Playback -----------------------------------------------------------

  // The item in the player: { itemId, canRetry, started, paused, position, lastReport }.
  let current = null;
  let subtitleUrl = null;

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
    current = {
      itemId: msg.itemId,
      canRetry: msg.canRetry,
      started: false,
      paused: false,
      position: (msg.positionTicks || 0) / TICKS_PER_SECOND,
      lastReport: 0,
    };
    showPlayer(true);
    video.src = msg.streamUrl;
    // Sound may only start from a click inside this view. The first item is picked in the library
    // view instead, so it loads paused here behind a play button; later ones start by themselves.
    video.play().catch((err) => setHidden(playBtn, !current || err.name !== 'NotAllowedError'));
  }

  function stopPlayback() {
    report('stopped');
    unloadVideo();
    showPlayer(false);
  }

  video.addEventListener('loadedmetadata', () => {
    if (current && !current.started && current.position > 0) {
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
    current.position = video.currentTime;
    const now = Date.now();
    if (now - current.lastReport >= PROGRESS_INTERVAL_MS) {
      current.lastReport = now;
      report('progress');
    }
  });

  video.addEventListener('seeked', () => {
    if (current && current.started) {
      current.position = video.currentTime;
      current.lastReport = Date.now();
      report(video.paused ? 'pause' : 'progress');
    }
  });

  video.addEventListener('ended', () => {
    if (current) {
      stopPlayback();
    }
  });

  video.addEventListener('error', () => {
    if (!current) {
      return;
    }
    const { itemId, canRetry } = current;
    if (canRetry) {
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
  for (const button of document.querySelectorAll('[data-command]')) {
    button.addEventListener('click', () => vscode.postMessage({ type: 'command', command: button.dataset.command }));
  }

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
      deviceProfile: buildDeviceProfile(probed, false),
      compatibleProfile: buildDeviceProfile(probed, true),
    });
  });
})();
