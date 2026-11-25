const vscode = require('vscode');
const { TingApi, serverAddress } = require('./api');
const { Player, seconds } = require('./player');

const sessionKey = 'tingReader.session';

function choose(items, placeHolder) {
  return vscode.window.showQuickPick(items, {
    placeHolder, matchOnDescription: true, matchOnDetail: true,
  });
}

async function signIn(context, current) {
  const address = await vscode.window.showInputBox({
    title: 'Ting Reader 服务器',
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
    title: 'Ting Reader 用户名', ignoreFocusOut: true,
    validateInput: (value) => value.trim() ? null : '请输入用户名。',
  });
  if (username === undefined) return;
  const password = await vscode.window.showInputBox({
    title: 'Ting Reader 密码', password: true, ignoreFocusOut: true,
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
  const player = new Player(context);
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

  let busy = false;
  const run = (action) => async () => {
    if (busy) return;
    busy = true;
    try {
      await action();
    } catch (error) {
      void vscode.window.showErrorMessage(`Ting Reader · ${error.message}`);
    } finally {
      busy = false;
    }
  };

  async function ensureSession() {
    api ||= await signIn(context);
    return api;
  }

  async function openBook(book, selectedProgress) {
    if (player.revealBook(book.id)) return;
    const [chapters, progress] = await withProgress('正在加载章节', () => Promise.all([
      api.chapters(book.id), selectedProgress || api.progress(book.id),
    ]));
    if (!chapters.length) {
      void vscode.window.showInformationMessage('这本书还没有可播放的章节。');
      return;
    }
    await player.capture();
    await player.open(api, book, chapters, resumeIndex(chapters, progress), progress);
  }

  async function browse() {
    if (!await ensureSession()) return;
    const libraries = await withProgress('正在加载媒体库', () => api.libraries());
    let libraryId;
    if (libraries.length > 1) {
      const choice = await choose([
        { label: '全部媒体库' },
        ...libraries.map((library) => ({ label: library.name, id: library.id })),
      ], '选择媒体库');
      if (!choice) return;
      libraryId = choice.id;
    }
    const books = await withProgress('正在加载书库', () => api.books(libraryId));
    if (!books.length) {
      void vscode.window.showInformationMessage('当前媒体库没有可收听的书籍。');
      return;
    }
    const choice = await choose(books.map((book) => ({
      label: book.title || '未命名书籍',
      description: [book.author, book.narrator].filter(Boolean).join(' · '),
      book,
    })), '搜索书名、作者或演播者');
    if (choice) await openBook(choice.book);
  }

  async function recent() {
    if (!await ensureSession()) return;
    const history = await withProgress('正在加载最近收听', () => api.recent());
    const byBook = new Map();
    for (const item of history) {
      if (!byBook.has(item.book_id)) byBook.set(item.book_id, item);
    }
    if (!byBook.size) {
      void vscode.window.showInformationMessage('还没有收听记录。');
      return;
    }
    const choice = await choose([...byBook.values()].map((progress) => ({
      label: progress.book_title || '未命名书籍',
      description: [progress.chapter_title, seconds(progress.position)].filter(Boolean).join(' · '),
      progress,
    })), '选择要继续收听的书籍');
    if (!choice) return;
    const book = await api.book(choice.progress.book_id);
    await openBook(book, choice.progress);
  }

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 45);
  status.text = '$(headphones) Ting Reader';
  status.tooltip = '打开 Ting Reader 播放器';
  status.command = 'tingReader.player';
  status.show();
  context.subscriptions.push(
    player,
    status,
    vscode.commands.registerCommand('tingReader.browse', run(browse)),
    vscode.commands.registerCommand('tingReader.recent', run(recent)),
    vscode.commands.registerCommand('tingReader.player', run(async () => {
      if (!player.reveal()) await browse();
    })),
    vscode.commands.registerCommand('tingReader.signIn', run(async () => {
      const next = await signIn(context, api);
      if (next) {
        await player.capture();
        player.close();
        api = next;
      }
    })),
    vscode.commands.registerCommand('tingReader.signOut', run(async () => {
      await player.capture();
      player.close();
      await context.secrets.delete(sessionKey);
      api = undefined;
      void vscode.window.showInformationMessage('已退出 Ting Reader。');
    })),
  );
}

module.exports = { activate };
