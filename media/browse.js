(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  const signedOut = $('signed-out');
  const main = $('main');
  const backBtn = $('back-btn');
  const searchInput = $('search');
  const heading = $('heading');
  const content = $('content');
  const message = $('message');
  const moreBtn = $('more-btn');

  // ---- Browsing -----------------------------------------------------------

  let stack = [{ kind: 'home' }];
  let requestId = 0;
  let nextIndex;
  let appending = false;

  function setHidden(element, hidden) {
    element.classList.toggle('hidden', hidden);
  }

  function showMessage(text) {
    message.textContent = text;
    setHidden(message, !text);
  }

  function load(append) {
    const view = stack[stack.length - 1];
    requestId++;
    appending = append;
    backBtn.disabled = stack.length <= 1;
    setHidden(moreBtn, true);
    if (!append) {
      content.replaceChildren();
      setHidden(heading, true);
      showMessage('Loading…');
    }
    vscode.postMessage({ type: 'load', requestId, view: append ? { ...view, startIndex: nextIndex } : view });
  }

  function navigate(view) {
    stack.push(view);
    load(false);
  }

  function createCard(item) {
    const card = document.createElement('button');
    card.className = item.wide ? 'item-card wide' : 'item-card';
    card.title = item.name;

    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    thumb.textContent = item.name.charAt(0);
    if (item.imageUrl) {
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('error', () => img.remove());
      img.src = item.imageUrl;
      thumb.appendChild(img);
    }
    if (item.played) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = '✓';
      thumb.appendChild(badge);
    } else if (item.progress > 0) {
      const bar = document.createElement('div');
      bar.className = 'progress';
      const fill = document.createElement('div');
      fill.style.width = `${Math.min(100, item.progress)}%`;
      bar.appendChild(fill);
      thumb.appendChild(bar);
    }

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = item.name;

    const subtitle = document.createElement('div');
    subtitle.className = 'subtitle';
    subtitle.textContent = item.subtitle;

    card.append(thumb, title, subtitle);
    card.addEventListener('click', () => {
      if (item.isFolder) {
        navigate({ kind: 'folder', id: item.id });
      } else {
        vscode.postMessage({ type: 'playItem', itemId: item.id });
      }
    });
    return card;
  }

  function renderView(view, append) {
    showMessage('');
    heading.textContent = view.title;
    setHidden(heading, !view.title);
    nextIndex = view.nextIndex;
    setHidden(moreBtn, nextIndex === undefined);

    const lists = content.querySelectorAll('.item-list');
    if (append && lists.length > 0) {
      for (const section of view.sections) {
        lists[lists.length - 1].append(...section.items.map(createCard));
      }
      return;
    }

    content.replaceChildren();
    for (const section of view.sections) {
      if (section.title) {
        const title = document.createElement('h3');
        title.textContent = section.title;
        content.appendChild(title);
      }
      const list = document.createElement('div');
      list.className = 'item-list';
      list.append(...section.items.map(createCard));
      content.appendChild(list);
    }
    if (view.sections.length === 0) {
      showMessage('Nothing here.');
    }
  }

  backBtn.addEventListener('click', () => {
    if (stack.length > 1) {
      stack.pop();
      const view = stack[stack.length - 1];
      searchInput.value = view.kind === 'search' ? view.query : '';
      load(false);
    }
  });

  moreBtn.addEventListener('click', () => load(true));

  // Fires on Enter and when the field is cleared.
  searchInput.addEventListener('search', () => {
    const query = searchInput.value.trim();
    const onSearch = stack[stack.length - 1].kind === 'search';
    if (onSearch) {
      stack.pop();
    }
    if (query) {
      navigate({ kind: 'search', query });
    } else if (onSearch) {
      load(false);
    }
  });

  $('sign-in-btn').addEventListener('click', () => vscode.postMessage({ type: 'signIn' }));

  for (const button of document.querySelectorAll('[data-command]')) {
    button.addEventListener('click', () => vscode.postMessage({ type: 'command', command: button.dataset.command }));
  }

  // ---- Messages from the extension ----------------------------------------

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'state':
        setHidden(signedOut, msg.signedIn);
        setHidden(main, !msg.signedIn);
        $('account-name').textContent = msg.account;
        if (msg.signedIn) {
          stack = [{ kind: 'home' }];
          load(false);
        }
        break;
      case 'view':
        if (msg.requestId === requestId) {
          renderView(msg, appending);
        }
        break;
      case 'viewError':
        if (msg.requestId === requestId) {
          showMessage(msg.message);
        }
        break;
      case 'nowPlaying':
        setHidden($('now-playing'), !msg.nowPlaying);
        if (msg.nowPlaying) {
          $('now-title').textContent = msg.nowPlaying.title;
          $('now-title').title = msg.nowPlaying.title;
          $('audio-btn').disabled = msg.nowPlaying.audioTrackCount < 2;
        }
        break;
      case 'refresh':
        if (!main.classList.contains('hidden') && (!msg.homeOnly || stack.length === 1)) {
          load(false);
        }
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
