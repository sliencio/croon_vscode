const vscode = require('vscode');
const { randomBytes } = require('node:crypto');
const { AudioProxy } = require('./audio-proxy');

const sidebarId = 'croon.sidebar';

function seconds(value) {
  const total = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(total / 3600);
  const parts = [Math.floor(total / 60) % 60, total % 60].map((part) => String(part).padStart(2, '0'));
  return hours ? [hours, ...parts].join(':') : parts.join(':');
}

function chapterTitle(chapter, index) {
  return chapter.title || `第 ${index + 1} 章`;
}

function html(webview, media, origin) {
  const nonce = randomBytes(18).toString('base64');
  const resource = (name) => webview.asWebviewUri(vscode.Uri.joinPath(media, name));
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src ${origin}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link href="${resource('player.css')}" rel="stylesheet">
  <title>Croon 播放器</title>
</head>
<body>
  <main class="player">
    <section id="signed-out" hidden>
      <p>登录 Croon 后即可浏览书库和同步收听进度。</p>
      <button class="primary" id="sign-in" type="button">登录 Croon</button>
    </section>
    <nav id="navigation" aria-label="Croon" hidden>
      <button id="browse" type="button">书库</button>
      <button id="recent" type="button">续听</button>
      <button id="playback" type="button">播放器</button>
    </nav>
    <section id="catalog" aria-label="书库与收听记录" hidden>
      <div class="catalog-controls">
        <select id="library" aria-label="媒体库" hidden></select>
        <button id="refresh" type="button">刷新</button>
      </div>
      <input id="catalog-search" type="search" aria-label="搜索书籍" placeholder="搜索书名、作者或演播者">
      <p id="catalog-status" role="status"></p>
      <ul id="catalog-items" class="items"></ul>
      <button id="catalog-more" type="button" hidden>显示更多</button>
    </section>
    <p id="no-playback" hidden>从书库或续听记录选择一本书。</p>
    <section id="now-playing" aria-labelledby="book" hidden>
      <header>
        <h1 id="book"></h1>
        <p id="author" hidden></p>
      </header>
      <div class="track">
        <div>
          <p id="chapter-number"></p>
          <h2 id="chapter"></h2>
        </div>
        <button id="chapters" type="button" aria-expanded="false" aria-controls="chapter-list">选章</button>
      </div>
      <label class="visually-hidden" for="position">播放进度</label>
      <input id="position" type="range" min="0" max="0" step="0.1" value="0" disabled>
      <div class="times"><output id="elapsed">0:00</output><output id="duration">0:00</output></div>
      <div class="transport">
        <button id="previous" type="button">上一章</button>
        <button id="rewind" type="button">−15 秒</button>
        <button id="play" type="button" class="primary">播放</button>
        <button id="forward" type="button">+30 秒</button>
        <button id="next" type="button">下一章</button>
      </div>
      <div class="options">
        <label>倍速
          <select id="speed">
            <option value="0.75">0.75×</option>
            <option value="1" selected>1×</option>
            <option value="1.25">1.25×</option>
            <option value="1.5">1.5×</option>
            <option value="1.75">1.75×</option>
            <option value="2">2×</option>
            <option value="2.5">2.5×</option>
            <option value="3">3×</option>
          </select>
        </label>
        <label>音量 <input id="volume" type="range" min="0" max="1" step="0.05" value="1"></label>
      </div>
      <p id="status" role="status"></p>
      <p id="sync" role="status" hidden></p>
      <div id="chapter-list" hidden>
        <input id="chapter-search" type="search" aria-label="搜索章节" placeholder="搜索章节">
        <p id="chapter-status" role="status"></p>
        <ul id="chapter-items" class="items"></ul>
        <button id="chapter-more" type="button" hidden>显示更多</button>
      </div>
    </section>
    <audio id="audio" preload="metadata"></audio>
  </main>
  <script nonce="${nonce}" src="${resource('player.js')}"></script>
</body>
</html>`;
}

class Player {
  constructor(context) {
    this.context = context;
    this.proxy = new AudioProxy();
    this.writes = Promise.resolve();
    this.sequence = 0;
  }

  async reveal(section) {
    this.section = section;
    if (this.view) this.view.show(false);
    else await vscode.commands.executeCommand(sidebarId + '.focus');
    this.postSection();
  }

  revealBook(bookId) {
    if (this.book?.id !== bookId) return false;
    void this.reveal('playback');
    return true;
  }

  async resolveWebviewView(view) {
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    this.view = view;
    this.ready = false;
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const messages = view.webview.onDidReceiveMessage((message) => {
      void this.receive(message).catch((error) => {
        if (this.view === view) void vscode.window.showErrorMessage(`Croon · ${error.message}`);
      });
    });
    view.onDidDispose(() => {
      messages.dispose();
      this.view = undefined;
      this.ready = false;
      this.clearPlayback();
    });
    this.proxyReady ||= this.proxy.start().catch((error) => {
      this.proxyReady = undefined;
      throw error;
    });
    await this.proxyReady;
    if (this.view === view) view.webview.html = html(view.webview, media, this.proxy.origin);
  }

  async open(api, book, chapters, index, progress) {
    await this.reveal('playback');
    await this.proxyReady;
    this.api = api;
    this.book = book;
    this.chapters = chapters;
    this.progress = progress;
    this.postChapters();
    this.loadChapter(index);
  }

  loadChapter(index) {
    const chapter = this.chapters?.[index];
    if (!chapter) return;
    const position = this.progress?.chapter_id === chapter.id
      ? this.progress.position : chapter.progress_position;
    const duration = Math.max(0, Number(chapter.duration) || 0,
      this.progress?.chapter_id === chapter.id ? Number(this.progress.duration) || 0 : 0);
    const offset = Math.max(0, Number(position) || 0);
    this.index = index;
    this.loadSource(false, duration > 0 && offset >= duration - 0.5 ? 0 : offset, true, duration);
  }

  loadSource(transcode, position, autoplay, duration = this.source?.duration || 0) {
    const chapter = this.chapters[this.index];
    const serial = ++this.sequence;
    const url = this.proxy.source(this.api, chapter.id, transcode, transcode ? position : 0, (seconds) => {
      if (this.source?.serial !== serial) return;
      this.source.duration = seconds;
      this.post({ type: 'duration', serial, duration: seconds });
    });
    this.source = {
      type: 'load',
      serial,
      url,
      bookId: this.book.id,
      book: this.book.title || '未命名书籍',
      author: [this.book.author, this.book.narrator].filter(Boolean).join(' · '),
      chapter: chapterTitle(chapter, this.index),
      index: this.index,
      count: this.chapters.length,
      transcode,
      position,
      duration,
      autoplay,
    };
    this.postSource();
  }

  postSource() {
    if (this.source) this.post(this.source);
  }

  post(message) {
    if (this.ready) void this.view?.webview.postMessage(message);
  }

  postSection() {
    if (!this.ready || !this.section) return;
    this.post({ type: 'section', section: this.section });
    this.section = undefined;
  }

  setSignedIn(signedIn) {
    this.signedIn = signedIn;
    this.post({ type: 'session', signedIn });
  }

  postChapters() {
    if (!this.chapters) return;
    this.post({ type: 'chapters', items: this.chapters.map((chapter, index) => ({
      id: index,
      title: chapterTitle(chapter, index),
      detail: [chapter.is_extra ? '番外' : '', chapter.duration > 0 ? seconds(chapter.duration) : '']
        .filter(Boolean).join(' · '),
    })) });
  }

  async receive(message) {
    const view = this.view;
    if (!view || !message) return;
    switch (message.type) {
      case 'ready':
        this.ready = true;
        this.post({
          type: 'preferences', ...this.context.globalState.get('croon.playback'),
        });
        this.setSignedIn(this.signedIn);
        this.postChapters();
        this.postSource();
        this.postSection();
        return;
      case 'preferences':
        await this.context.globalState.update('croon.playback', {
          speed: message.speed, volume: message.volume,
        });
        return;
      case 'snapshotComplete':
        if (message.id === this.snapshot?.id) this.snapshot.finish();
        return;
      case 'signIn':
        await vscode.commands.executeCommand('croon.signIn');
        return;
      case 'catalog':
        await this.onCatalog(message);
        return;
      case 'openBook':
        await this.onOpenBook(message.id);
        return;
    }
    const source = this.source;
    if (!source || message.serial !== source.serial) return;
    if (message.type === 'switch' && Number.isInteger(message.index)) {
      this.loadChapter(message.index);
    } else if (['fallback', 'seek', 'retry'].includes(message.type)
        && Number.isFinite(message.position) && message.position >= 0) {
      const transcode = source.transcode || message.type === 'fallback';
      const duration = source.duration || (Number.isFinite(message.duration) ? Math.max(0, message.duration) : 0);
      const position = duration ? Math.min(message.position, Math.max(0, duration - 0.1)) : message.position;
      this.loadSource(transcode, position, message.autoplay === true, duration);
    } else if (message.type === 'progress') {
      this.saveProgress(message, view);
    }
  }

  saveProgress(message, view) {
    if (!Number.isFinite(message.position) || message.position < 0
        || !Number.isFinite(message.duration) || message.duration < 0) return;
    const api = this.api;
    const payload = {
      book_id: this.book.id,
      chapter_id: this.chapters[this.index].id,
      position: message.position,
      duration: message.duration,
    };
    if (message.started === true) payload.playback_start = payload.position;
    this.chapters[this.index].progress_position = payload.position;
    this.progress = payload;

    this.writes = this.writes.then(async () => {
      let warning = '';
      try {
        await api.saveProgress(payload);
      } catch (error) {
        warning = `进度同步失败 · ${error.message}`;
      }
      if (this.view === view) this.post({ type: 'sync', warning });
    });
  }

  flush() {
    return this.writes;
  }

  async capture() {
    if (this.source && this.view?.visible && this.ready) {
      const id = randomBytes(8).toString('hex');
      await new Promise((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          this.snapshot = undefined;
          resolve();
        };
        const timer = setTimeout(finish, 750);
        this.snapshot = { id, finish };
        this.post({ type: 'snapshot', id });
      });
    }
    return this.flush();
  }

  clearPlayback() {
    this.source = undefined;
    this.book = undefined;
    this.chapters = undefined;
    this.api = undefined;
    this.proxy.clear();
    this.post({ type: 'reset' });
  }

  dispose() {
    this.clearPlayback();
    this.proxy.dispose();
  }
}

module.exports = { Player, sidebarId, seconds };
