const vscode = require('vscode');
const { randomBytes } = require('node:crypto');
const { AudioProxy } = require('./audio-proxy');

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
  <title>Ting Reader 播放器</title>
</head>
<body>
  <main class="player">
    <header>
      <div class="identity">
        <div class="mark" aria-hidden="true">听</div>
        <div>
          <h1 id="book">Ting Reader</h1>
          <p id="author" hidden></p>
        </div>
      </div>
      <div class="actions">
        <button id="browse" type="button">书库</button>
        <button id="recent" type="button">继续收听</button>
      </div>
    </header>
    <section aria-labelledby="chapter">
      <div class="track">
        <div>
          <p id="chapter-number"></p>
          <h2 id="chapter"></h2>
        </div>
        <button id="chapters" type="button">选章</button>
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

  reveal() {
    if (!this.panel) return false;
    this.panel.reveal(undefined, false);
    return true;
  }

  revealBook(bookId) {
    return this.book?.id === bookId && this.reveal();
  }

  async open(api, book, chapters, index, progress) {
    if (!this.proxy.origin) await this.proxy.start();
    if (!this.panel) {
      const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
      const panel = vscode.window.createWebviewPanel('tingReaderPlayer', 'Ting Reader', {
        viewColumn: vscode.ViewColumn.Active, preserveFocus: false,
      }, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] });
      this.panel = panel;
      this.ready = false;
      panel.webview.onDidReceiveMessage((message) => {
        void this.receive(message).catch((error) => {
          if (this.panel === panel) void vscode.window.showErrorMessage(`Ting Reader · ${error.message}`);
        });
      });
      panel.onDidDispose(() => {
        this.panel = undefined;
        this.ready = false;
        this.proxy.clear();
        this.source = undefined;
        this.book = undefined;
        void this.flush();
      });
      panel.webview.html = html(panel.webview, media, this.proxy.origin);
    } else {
      this.reveal();
    }
    this.api = api;
    this.book = book;
    this.chapters = chapters;
    this.progress = progress;
    this.loadChapter(index);
  }

  loadChapter(index) {
    const chapter = this.chapters?.[index];
    if (!chapter || !this.panel) return;
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
      if (this.ready) void this.panel?.webview.postMessage({ type: 'duration', serial, duration: seconds });
    });
    this.source = {
      type: 'load',
      serial,
      url,
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
    if (this.ready && this.source) void this.panel?.webview.postMessage(this.source);
  }

  async pickChapter(panel) {
    if (this.picking) return;
    this.picking = true;
    const chapters = this.chapters;
    try {
      const choice = await vscode.window.showQuickPick(chapters.map((chapter, index) => ({
        label: chapterTitle(chapter, index),
        description: [index === this.index ? '当前章节' : '', chapter.is_extra ? '番外' : '',
          chapter.duration > 0 ? seconds(chapter.duration) : ''].filter(Boolean).join(' · '),
        index,
      })), { placeHolder: '搜索章节并选择播放', matchOnDescription: true });
      if (choice && this.panel === panel && this.chapters === chapters && choice.index !== this.index) {
        void panel.webview.postMessage({ type: 'switch', index: choice.index });
      }
    } finally {
      this.picking = false;
    }
  }

  async receive(message) {
    const panel = this.panel;
    if (!panel || !message) return;
    switch (message.type) {
      case 'ready':
        this.ready = true;
        void panel.webview.postMessage({
          type: 'preferences', ...this.context.globalState.get('tingReader.playback'),
        });
        this.postSource();
        return;
      case 'preferences':
        await this.context.globalState.update('tingReader.playback', {
          speed: message.speed, volume: message.volume,
        });
        return;
      case 'snapshotComplete':
        if (message.id === this.snapshot?.id) this.snapshot.finish();
        return;
      case 'browse':
        await vscode.commands.executeCommand('tingReader.browse');
        return;
      case 'recent':
        await vscode.commands.executeCommand('tingReader.recent');
        return;
      case 'chapters':
        await this.pickChapter(panel);
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
      this.saveProgress(message, panel);
    }
  }

  saveProgress(message, panel) {
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
      if (this.panel === panel) void panel.webview.postMessage({ type: 'sync', warning });
    });
  }

  flush() {
    return this.writes;
  }

  async capture() {
    if (this.panel?.visible && this.ready) {
      const id = randomBytes(8).toString('hex');
      await new Promise((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          this.snapshot = undefined;
          resolve();
        };
        const timer = setTimeout(finish, 750);
        this.snapshot = { id, finish };
        void this.panel.webview.postMessage({ type: 'snapshot', id });
      });
    }
    return this.flush();
  }

  close() {
    this.panel?.dispose();
  }

  dispose() {
    this.close();
    this.proxy.dispose();
  }
}

module.exports = { Player, chapterTitle, seconds };
