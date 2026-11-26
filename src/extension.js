const vscode = require('vscode');
const { TingApi, serverAddress } = require('./api');
const { Player, sidebarId, seconds } = require('./player');

const sessionKey = 'croon.session';

async function signIn(context, current) {
  const address = await vscode.window.showInputBox({
    title: 'Croon 服务器',
    prompt: '输入直连或反向代理地址，包含端口和路径前缀（如有）。',
    value: current?.address || '',
    placeHolder: 'https://ting.example.com',
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
    title: 'Croon 用户名', ignoreFocusOut: true,
    validateInput: (value) => value.trim() ? null : '请输入用户名。',
  });
  if (username === undefined) return;
  const password = await vscode.window.showInputBox({
    title: 'Croon 密码', password: true, ignoreFocusOut: true,
    validateInput: (value) => value ? null : '请输入密码。',
  });
  if (password === undefined) return;
  const session = await withProgress('正在登录', () => new TingApi(address).signIn(username.trim(), password));
  await context.secrets.store(sessionKey, JSON.stringify(session));
  return new TingApi(session.address, session.token);
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
      if (session.token) api = new TingApi(session.address, session.token);
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

  const openBook = run(async (bookId) => {
    if (!api || typeof bookId !== 'string' || !bookId || player.revealBook(bookId)) return;
    const [book, chapters, progress] = await withProgress('正在加载章节', () => Promise.all([
      api.book(bookId), api.chapters(bookId), api.progress(bookId),
    ]));
    if (!chapters.length) {
      void vscode.window.showInformationMessage('这本书还没有可播放的章节。');
      return;
    }
    await player.capture();
    await player.open(api, book, chapters, resumeIndex(chapters, progress), progress);
  });

  player.onCatalog = async ({ request, section, libraryId }) => {
    const session = api;
    if (!session || !['browse', 'recent'].includes(section)) return;
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
        }));
      }
      if (api === session) player.post({ type: 'catalog', request, section, libraries, items });
    } catch (error) {
      if (api === session) player.post({ type: 'catalog', request, section, error: error.message });
    }
  };
  player.onOpenBook = openBook;

  context.subscriptions.push(
    player,
    vscode.window.registerWebviewViewProvider(sidebarId, player, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('croon.browse', () => player.reveal('browse')),
    vscode.commands.registerCommand('croon.recent', () => player.reveal('recent')),
    vscode.commands.registerCommand('croon.player', () => player.reveal('playback')),
    vscode.commands.registerCommand('croon.signIn', run(async () => {
      const next = await signIn(context, api);
      if (next) {
        await player.capture();
        player.clearPlayback();
        api = next;
        player.setSignedIn(true);
        await player.reveal('browse');
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
