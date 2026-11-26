const vscode = require('vscode');
const { CroonApi, serverAddress } = require('./api');
const { Player, sidebarId, seconds } = require('./player');

const sessionKey = 'croon.session';

async function signIn(context, current) {
  const address = await vscode.window.showInputBox({
    title: 'Croon 登录 · 1/3 服务器地址',
    prompt: '输入 Croon 服务器地址，包含协议、端口和代理路径（如有）。',
    value: current?.address || '',
    placeHolder: '服务器地址，例如 https://croon.example.com',
    ignoreFocusOut: true,
    validateInput(value) {
      try {
        serverAddress(value);
        return null;
      } catch {
        return '请输入有效的 HTTP 或 HTTPS 服务地址。';
      }
    },
  });
  if (address === undefined) return;
  const username = await vscode.window.showInputBox({
    title: 'Croon 登录 · 2/3 用户名',
    placeHolder: '输入 Croon 用户名',
    prompt: '使用你在 Croon 服务器上的用户名。',
    ignoreFocusOut: true,
    validateInput: (value) => value.trim() ? null : '请输入用户名。',
  });
  if (username === undefined) return;
  const password = await vscode.window.showInputBox({
    title: 'Croon 登录 · 3/3 密码',
    placeHolder: '输入 Croon 密码',
    prompt: '输入当前账号的密码，按 Enter 登录。',
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => value ? null : '请输入密码。',
  });
  if (password === undefined) return;
  const session = await withProgress('正在登录', () => new CroonApi(address).signIn(username.trim(), password));
  await context.secrets.store(sessionKey, JSON.stringify(session));
  return new CroonApi(session.address, session.token, session.userId);
}

function withProgress(title, task) {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task);
}

function resumeIndex(chapters, progress) {
  const index = chapters.findIndex((chapter) => chapter.id === progress?.chapter_id);
  if (index < 0) return 0;
  const duration = Number(progress.duration) || Number(chapters[index].duration);
  const finished = duration > 0 && progress.position >= duration - 0.5;
  if (finished && index + 1 < chapters.length) return index + 1;
  return index;
}

async function activate(context) {
  const stored = await context.secrets.get(sessionKey);
  let api;
  if (stored) {
    try {
      const session = JSON.parse(stored);
      if (session.token) api = new CroonApi(session.address, session.token, session.userId);
    } catch {
      await context.secrets.delete(sessionKey);
    }
  }
  const player = new Player(context);
  player.setSignedIn(Boolean(api));

  let busy = false;
  const run = (action) => async (...args) => {
    if (busy) return;
    busy = true;
    try {
      await action(...args);
    } catch (error) {
      void vscode.window.showErrorMessage(`Croon · ${error.message}`);
    } finally {
      busy = false;
    }
  };

  const openBook = run(async (bookId, section) => {
    if (!api || typeof bookId !== 'string' || !bookId || player.revealBook(bookId)) return;
    const [book, chapters, progress] = await withProgress('正在加载章节', () => Promise.all([
      api.book(bookId), api.chapters(bookId), api.progress(bookId),
    ]));
    if (!chapters.length) {
      void vscode.window.showInformationMessage('这本书还没有可播放的章节。');
      return;
    }
    await player.capture();
    await player.open(api, book, chapters, resumeIndex(chapters, progress), progress, section === 'browse');
  });

  let pendingCatalog;
  player.onCatalog = async (query) => {
    const { request, section, libraryId } = query;
    const session = api;
    if (!session || !['browse', 'recent'].includes(section)) return;
    pendingCatalog = query;
    try {
      let items;
      let libraries;
      if (section === 'recent') {
        const byBook = new Map();
        for (const item of await session.recent()) {
          if (!byBook.has(item.book_id)) byBook.set(item.book_id, item);
        }
        items = [...byBook.values()].map((item) => ({
          id: item.book_id,
          title: item.book_title || '未命名书籍',
          detail: [item.chapter_title, seconds(item.position)].filter(Boolean).join(' · '),
          coverPath: item.cover_url,
          libraryId: item.library_id,
        }));
      } else {
        const [available, books] = await Promise.all([
          session.libraries(),
          session.books(typeof libraryId === 'string' ? libraryId : undefined),
        ]);
        libraries = available.map(({ id, name }) => ({ id, name }));
        items = books.map((book) => ({
          id: book.id,
          title: book.title || '未命名书籍',
          detail: [book.author, book.narrator].filter(Boolean).join(' · '),
          coverPath: book.cover_url,
          libraryId: book.library_id,
        }));
      }
      if (api === session && pendingCatalog === query) {
        const entries = player.setCatalogCovers(session, items);
        player.post({ type: 'catalog', request, section, libraries, items: entries });
      }
    } catch (error) {
      if (api === session && pendingCatalog === query) {
        player.post({ type: 'catalog', request, section, error: error.message });
      }
    }
  };
  player.onOpenBook = openBook;
  player.onAbout = async (request) => {
    const session = api;
    let version = '未连接服务器';
    if (session) {
      try {
        version = await session.serverVersion() || '服务器未返回版本号';
      } catch {
        version = '无法读取服务器版本';
      }
    }
    if (api === session) player.post({ type: 'about', request, version });
  };

  context.subscriptions.push(
    player,
    vscode.window.registerWebviewViewProvider(sidebarId, player, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('croon.browse', () => player.reveal('browse')),
    vscode.commands.registerCommand('croon.recent', () => player.reveal('recent')),
    vscode.commands.registerCommand('croon.player', () => player.reveal('playback')),
    vscode.commands.registerCommand('croon.about', () => player.reveal('about')),
    vscode.commands.registerCommand('croon.forceSync', run(async () => {
      if (!api) {
        void vscode.window.showInformationMessage('请先登录 Croon。');
        return;
      }
      await player.invalidateCovers(api);
      pendingCatalog = undefined;
      player.post({ type: 'catalogInvalidated' });
      void vscode.window.setStatusBarMessage('Croon · 书库、续听和封面将从服务器重新同步', 4000);
    })),
    vscode.commands.registerCommand('croon.signIn', run(async () => {
      const next = await signIn(context, api);
      if (next) {
        await player.capture();
        player.clearPlayback();
        api = next;
        player.setSignedIn(true);
        await player.reveal('recent');
      }
    })),
    vscode.commands.registerCommand('croon.signOut', run(async () => {
      await player.capture();
      player.clearPlayback();
      await context.secrets.delete(sessionKey);
      api = undefined;
      player.setSignedIn(false);
      void vscode.window.showInformationMessage('已退出 Croon。');
    })),
  );
}

module.exports = { activate };
