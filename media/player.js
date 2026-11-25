const vscode = acquireVsCodeApi();
const byId = (id) => document.getElementById(id);
const audio = byId('audio');
const position = byId('position');
const speed = byId('speed');
const volume = byId('volume');
const status = byId('status');
const play = byId('play');

const preferences = vscode.getState() || {};
if ([...speed.options].some((option) => option.value === preferences.speed)) speed.value = preferences.speed;
if (Number.isFinite(preferences.volume)) volume.value = preferences.volume;
audio.defaultPlaybackRate = Number(speed.value);
audio.playbackRate = audio.defaultPlaybackRate;
audio.volume = Number(volume.value);

let source;
let ready = false;
let changing = false;
let auditioned = false;
let startPending = false;
let failed = false;
let dragging = false;
let lastReported = -1;
let signedIn = false;
let section = 'browse';
let request = 0;
let catalogItems = [];
let chapterItems = [];
const pageSize = 100;
let catalogLimit = pageSize;
let chapterLimit = pageSize;

function time(value) {
  const total = Math.max(0, Math.floor(value));
  const hours = Math.floor(total / 3600);
  const minutes = String(Math.floor(total / 60) % 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${minutes.padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

function current() {
  if (!ready) return source?.position || 0;
  return (source.transcode ? source.position : 0) + audio.currentTime;
}

function duration() {
  if (!source) return 0;
  const actual = Number.isFinite(audio.duration) ? audio.duration : 0;
  if (source.transcode) return source.duration || (audio.ended ? current() : 0);
  return actual || source.duration;
}

function render() {
  const total = duration();
  position.disabled = !ready || !total || changing || failed;
  if (!dragging) {
    position.max = total;
    position.value = current();
    byId('elapsed').value = time(current());
  }
  byId('duration').value = total ? time(total) : '—';
  play.textContent = failed ? '重试' : audio.paused ? '播放' : '暂停';
  play.disabled = !source || changing;
  byId('rewind').disabled = !ready || changing || failed;
  byId('forward').disabled = !ready || !total || changing || failed;
}

function send(type, fields = {}) {
  vscode.postMessage({ type, serial: source?.serial, ...fields });
}

function showSection(next, reload = false) {
  const changed = section !== next;
  section = next;
  byId('signed-out').hidden = signedIn;
  byId('navigation').hidden = !signedIn;
  byId('catalog').hidden = !signedIn || section === 'playback';
  byId('now-playing').hidden = !signedIn || section !== 'playback' || !source;
  byId('no-playback').hidden = !signedIn || section !== 'playback' || Boolean(source);
  for (const tab of ['browse', 'recent', 'playback']) {
    byId(tab).setAttribute('aria-pressed', String(tab === section));
  }
  if (signedIn && section !== 'playback' && (changed || reload)) {
    byId('catalog-search').value = '';
    fetchCatalog();
  }
}

function fetchCatalog() {
  catalogItems = [];
  catalogLimit = pageSize;
  byId('catalog-items').replaceChildren();
  byId('catalog-more').hidden = true;
  byId('catalog-status').textContent = '正在加载…';
  byId('library').hidden = section !== 'browse' || byId('library').options.length < 3;
  send('catalog', { request: ++request, section, libraryId: byId('library').value });
}

function renderItems(kind, items, limit, onSelect) {
  const list = byId(kind + '-items');
  const filter = byId(kind + '-search').value.trim().toLocaleLowerCase();
  const matches = items.filter(({ title, detail }) =>
    (title + ' ' + detail).toLocaleLowerCase().includes(filter));
  const fragment = document.createDocumentFragment();
  for (const item of matches.slice(0, limit)) {
    const entry = document.createElement('li');
    const button = document.createElement('button');
    const title = document.createElement('span');
    button.type = 'button';
    title.textContent = item.title;
    button.append(title);
    if (item.detail) {
      const detail = document.createElement('small');
      detail.textContent = item.detail;
      button.append(detail);
    }
    if (kind === 'chapter' && item.id === source?.index) button.setAttribute('aria-current', 'true');
    button.addEventListener('click', () => onSelect(item.id));
    entry.append(button);
    fragment.append(entry);
  }
  list.replaceChildren(fragment);
  byId(kind + '-more').hidden = matches.length <= limit;
  byId(kind + '-status').textContent = matches.length ? ''
    : filter ? '没有匹配的结果。'
      : section === 'recent' ? '还没有收听记录。' : '当前媒体库没有书籍。';
}

function renderCatalog() {
  renderItems('catalog', catalogItems, catalogLimit, (id) => send('openBook', { id }));
}

function renderChapters() {
  renderItems('chapter', chapterItems, chapterLimit, (index) => {
    switchChapter(index);
    toggleChapters(false);
    byId('chapters').focus();
  });
}

function toggleChapters(show) {
  byId('chapter-list').hidden = !show;
  byId('chapters').setAttribute('aria-expanded', String(show));
  if (show) {
    renderChapters();
    byId('chapter-search').focus();
  }
}

function save({ started = false, ended = false } = {}) {
  if (!auditioned || !ready || failed) return;
  const total = duration();
  const elapsed = total > 0 ? (ended ? total : Math.min(total, current())) : current();
  if (!started && elapsed === lastReported) return;
  lastReported = elapsed;
  send('progress', { position: elapsed, duration: total, started });
}

async function tryPlay() {
  if (!source || changing) return;
  const serial = source.serial;
  try {
    await audio.play();
  } catch (error) {
    if (source?.serial !== serial || error.name === 'AbortError' || failed || changing) return;
    if (error.name === 'NotAllowedError') status.textContent = '点击播放开始收听。';
  }
  render();
}

function load(message) {
  changing = true;
  audio.pause();
  const newBook = source?.bookId !== message.bookId;
  source = message;
  if (newBook) showSection('playback');
  ready = false;
  auditioned = false;
  startPending = false;
  failed = false;
  dragging = false;
  lastReported = -1;
  byId('book').textContent = source.book;
  byId('author').textContent = source.author;
  byId('author').hidden = !source.author;
  byId('chapter').textContent = source.chapter;
  byId('chapter-number').textContent = `${source.index + 1} / ${source.count} 章`;
  byId('previous').disabled = source.index === 0;
  byId('next').disabled = source.index + 1 >= source.count;
  status.textContent = source.transcode ? '正在加载 MP3 转码音频…' : '正在加载音频…';
  audio.src = source.url;
  audio.load();
  changing = false;
  render();
}

function changeSource(type, nextPosition, autoplay) {
  if (!source || changing) return;
  save();
  changing = true;
  audio.pause();
  send(type, { position: nextPosition, autoplay, duration: duration() });
  render();
}

function switchChapter(index) {
  if (!source || changing || index < 0 || index >= source.count || index === source.index) return;
  save({ ended: audio.ended });
  changing = true;
  audio.pause();
  render();
  send('switch', { index });
}

function seek(value) {
  if (!ready || changing || failed) return;
  const nextPosition = Math.max(0, duration() ? Math.min(value, duration()) : value);
  if (source.transcode) {
    changeSource('seek', nextPosition, !audio.paused);
  } else {
    audio.currentTime = nextPosition;
  }
  render();
}

audio.addEventListener('loadedmetadata', () => {
  if (!source || changing || audio.currentSrc !== source.url) return;
  if (!source.transcode && source.position > 0) {
    const end = duration();
    audio.currentTime = end ? Math.min(source.position, Math.max(0, end - 0.1)) : source.position;
  }
  ready = true;
  status.textContent = source.transcode ? 'MP3 转码播放' : '';
  if (source.autoplay) void tryPlay();
  render();
});

audio.addEventListener('play', () => {
  startPending = true;
  render();
});
audio.addEventListener('playing', () => {
  if (!ready || changing) return;
  auditioned = true;
  status.textContent = source.transcode ? 'MP3 转码播放' : '';
  if (startPending) {
    startPending = false;
    save({ started: true });
  }
  render();
});
audio.addEventListener('pause', () => {
  if (!changing && audio.paused && !audio.ended) save();
  render();
});
audio.addEventListener('seeked', () => save());
audio.addEventListener('timeupdate', render);
audio.addEventListener('durationchange', render);
audio.addEventListener('waiting', () => {
  if (ready && !changing && !audio.paused) status.textContent = '正在缓冲…';
});
audio.addEventListener('ended', () => {
  if (!source || changing || !audio.ended) return;
  save({ ended: true });
  if (source.index + 1 < source.count) switchChapter(source.index + 1);
  else status.textContent = '已播到最后一章。';
  render();
});
audio.addEventListener('error', () => {
  if (!source || changing || failed || audio.currentSrc !== source.url) return;
  if (!source.transcode) {
    changeSource('fallback', current(), !ready ? source.autoplay : auditioned || !audio.paused);
    return;
  }
  failed = true;
  status.textContent = '无法播放音频。请检查登录状态、音源和服务端 FFmpeg 后重试。';
  render();
});

for (const tab of ['browse', 'recent', 'playback']) {
  byId(tab).addEventListener('click', () => showSection(tab));
}
byId('sign-in').addEventListener('click', () => send('signIn'));
byId('refresh').addEventListener('click', fetchCatalog);
byId('library').addEventListener('change', fetchCatalog);
byId('catalog-search').addEventListener('input', () => {
  catalogLimit = pageSize;
  renderCatalog();
});
byId('catalog-more').addEventListener('click', () => {
  catalogLimit += pageSize;
  renderCatalog();
});
byId('chapter-search').addEventListener('input', () => {
  chapterLimit = pageSize;
  renderChapters();
});
byId('chapter-more').addEventListener('click', () => {
  chapterLimit += pageSize;
  renderChapters();
});
byId('chapters').addEventListener('click', () => toggleChapters(byId('chapter-list').hidden));
byId('previous').addEventListener('click', () => switchChapter(source.index - 1));
byId('next').addEventListener('click', () => switchChapter(source.index + 1));
byId('rewind').addEventListener('click', () => seek(current() - 15));
byId('forward').addEventListener('click', () => seek(current() + 30));
play.addEventListener('click', () => {
  if (failed) changeSource('retry', current(), true);
  else if (audio.paused) void tryPlay();
  else audio.pause();
});

position.addEventListener('input', () => {
  dragging = true;
  byId('elapsed').value = time(Number(position.value));
});
position.addEventListener('change', () => {
  dragging = false;
  seek(Number(position.value));
});
position.addEventListener('blur', () => {
  dragging = false;
  render();
});
function updatePreferences() {
  audio.defaultPlaybackRate = Number(speed.value);
  audio.playbackRate = audio.defaultPlaybackRate;
  audio.volume = Number(volume.value);
  vscode.setState({ speed: speed.value, volume: audio.volume });
  send('preferences', { speed: speed.value, volume: audio.volume });
}
speed.addEventListener('change', updatePreferences);
volume.addEventListener('input', () => { audio.volume = Number(volume.value); });
volume.addEventListener('change', updatePreferences);

window.addEventListener('message', ({ data }) => {
  if (data.type === 'load') load(data);
  else if (data.type === 'section') showSection(data.section);
  else if (data.type === 'session') {
    signedIn = data.signedIn;
    catalogItems = [];
    byId('catalog-search').value = '';
    byId('library').replaceChildren();
    ++request;
    showSection('browse', true);
  } else if (data.type === 'catalog' && data.request === request && data.section === section) {
    const library = byId('library');
    if (data.libraries) {
      const selected = library.value;
      library.replaceChildren(new Option('全部媒体库', ''),
        ...data.libraries.map(({ id, name }) => new Option(name, id)));
      library.value = data.libraries.some(({ id }) => id === selected) ? selected : '';
      library.hidden = data.libraries.length < 2;
    }
    catalogItems = data.items || [];
    renderCatalog();
    if (data.error) byId('catalog-status').textContent = data.error;
  } else if (data.type === 'chapters') {
    chapterItems = data.items;
    chapterLimit = pageSize;
    byId('chapter-search').value = '';
    toggleChapters(false);
  } else if (data.type === 'reset') {
    source = undefined;
    ready = false;
    audio.removeAttribute('src');
    audio.load();
    toggleChapters(false);
    byId('sync').hidden = true;
    showSection('browse');
  } else if (data.type === 'duration' && data.serial === source?.serial) {
    source.duration = data.duration;
    render();
  }
  else if (data.type === 'snapshot') {
    save();
    send('snapshotComplete', { id: data.id });
  }
  else if (data.type === 'sync') {
    byId('sync').textContent = data.warning;
    byId('sync').hidden = !data.warning;
  } else if (data.type === 'preferences') {
    if ([...speed.options].some((option) => option.value === data.speed)) speed.value = data.speed;
    if (Number.isFinite(data.volume)) volume.value = data.volume;
    audio.defaultPlaybackRate = Number(speed.value);
    audio.playbackRate = audio.defaultPlaybackRate;
    audio.volume = Number(volume.value);
  }
});
setInterval(() => {
  if (!audio.paused && !changing) save();
}, 10000);
send('ready');
