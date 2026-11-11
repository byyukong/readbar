'use strict';

const vscode = require('vscode');

const Store = require('./lib/store');
const { readBookText, epubInfo, mobiInfo, guessName } = require('./lib/parser');
const { pageText, percentOf, getChapters, search, toStatusText, takeByWidth } = require('./lib/book');

/** 和 Electron 版共用同一个 id，方便直接把老 db.json 拷过来 */
const DEVICE_ID = 'readbar';
const LIST_DOC = DEVICE_ID + '/list';

const state = {
  store: null,
  statusItem: null,
  books: [],
  currentId: null,
  content: '',
  contentKey: '',
  visible: true,
  autoTimer: null,
  autoPausedByHide: false,
  saveTimer: null,
  opening: false,
  settings: {}
};

function readSettings() {
  const conf = vscode.workspace.getConfiguration('readbar');
  return {
    charsPerLine: Math.min(300, Math.max(10, Math.round(Number(conf.get('charsPerLine')) || 40))),
    showIcon: conf.get('showIcon') !== false,
    showPercent: conf.get('showPercent') === true,
    keepFormat: conf.get('keepFormat') === true,
    statusBarAlign: conf.get('statusBarAlign') === 'right' ? 'right' : 'left',
    useDefaultKeys: conf.get('useDefaultKeys') !== false,
    autoResume: conf.get('autoResume') !== false,
    autoPageSeconds: Number(conf.get('autoPageSeconds')) || 0,
    maxStatusWidth: Number(conf.get('maxStatusWidth')) >= 0 ? Number(conf.get('maxStatusWidth')) : 720
  };
}

function currentBook() {
  return state.books.find((book) => book && book.id === state.currentId) || null;
}

/* ------------------------------------------------------------------ *
 * 持久化
 * ------------------------------------------------------------------ */

function loadBooks() {
  const doc = state.store.get(LIST_DOC);
  const data = doc && Array.isArray(doc.data) ? doc.data.filter(Boolean) : [];
  state.books = data;
  return doc;
}

function persistList(immediate) {
  if (state.saveTimer) {
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
  }
  const write = () => {
    state.store.put({ _id: LIST_DOC, data: state.books, lastId: state.currentId });
  };
  if (immediate) {
    write();
  } else {
    state.saveTimer = setTimeout(write, 600);
  }
}

/* ------------------------------------------------------------------ *
 * 状态栏渲染（红框那一块）
 * ------------------------------------------------------------------ */

/** 按设置创建状态栏项；对齐方式变了必须重建，因为 alignment / priority 是只读的 */
function createStatusItem() {
  if (state.statusItem) {
    state.statusItem.dispose();
    state.statusItem = null;
  }
  const onRight = state.settings.statusBarAlign === 'right';
  state.statusItem = vscode.window.createStatusBarItem(
    onRight ? vscode.StatusBarAlignment.Right : vscode.StatusBarAlignment.Left,
    onRight ? 1000 : 100000 // 左侧用最高优先级，紧贴左边缘
  );
  state.statusItem.name = '摸鱼阅读';
  render();
}

function buildTooltip(book, progress) {
  const s = state.settings;
  const pageSize = state.pageLength || s.charsPerLine;
  const pct = percentOf(state.content, progress, pageSize);
  const percentLabel = pct.toFixed(2) + '%';
  const tip = new vscode.MarkdownString();
  tip.appendMarkdown(`**${book.name || '未命名'}**  \n`);
  tip.appendMarkdown(`进度 ${percentLabel} · 本页 ${pageSize} 字  \n`);
  tip.appendMarkdown('`Alt+]` 下一页 · `Alt+[` 上一页 · `Alt+M` 菜单');
  return tip;
}

let activeContext = null;

function render() {
  const active = !!state.currentId && state.visible;
  if (active !== activeContext) {
    activeContext = active;
    // 让 Alt+] / Alt+[ 只在有书打开时生效，不抢占编辑器里的同名按键
    void vscode.commands.executeCommand('setContext', 'readbar.active', active);
  }
  const item = state.statusItem;
  if (!item) {
    return;
  }
  if (!state.visible) {
    item.hide();
    return;
  }
  const s = state.settings;
  const icon = s.showIcon ? '$(book) ' : '';
  const book = currentBook();

  if (!book) {
    state.pageLength = 0;
    item.text = icon + '摸鱼阅读 · 点击添加书籍';
    item.tooltip = '还没有打开的书，点击选择或添加一本';
    item.command = 'readbar.menu';
    item.show();
    return;
  }

  const progress = Number(book.progress) || 0;
  // 状态栏宽度有限：先按像素预算裁出这一页，再决定翻页步长，保证不会「翻了却看不到」
  const budget = s.maxStatusWidth > 0 ? Math.max(60, s.maxStatusWidth - (s.showIcon ? 24 : 0) - (s.showPercent ? 64 : 0)) : 0;
  const raw = state.content ? state.content.substring(progress, progress + s.charsPerLine) : '';
  const fitted = takeByWidth(raw, budget);
  state.pageLength = fitted.used;
  const pageSize = state.pageLength || s.charsPerLine;
  let text = toStatusText(fitted.text, 0);
  if (!text) {
    text = state.content ? '（本页已到末尾）' : '读取中…';
  }
  const percent = s.showPercent ? ' ' + percentOf(state.content, progress, pageSize).toFixed(2) + '%' : '';
  item.text = icon + text + percent;
  item.tooltip = buildTooltip(book, progress);
  item.command = 'readbar.menu';
  item.show();
}

/* ------------------------------------------------------------------ *
 * 阅读
 * ------------------------------------------------------------------ */

async function ensureContent(book) {
  const key = book.id + (state.settings.keepFormat ? '|keep' : '|raw');
  if (state.contentKey === key) {
    return true;
  }
  const text = await readBookText(state.store, book, state.settings.keepFormat);
  if (text === null || text === undefined) {
    return false;
  }
  state.content = text;
  state.contentKey = key;
  return true;
}

async function openBook(id) {
  const book = state.books.find((one) => one && one.id === id);
  if (!book || state.opening) {
    return false;
  }
  state.opening = true;
  try {
    const ok = await ensureContent(book);
    if (!ok) {
      vscode.window.showWarningMessage(`摸鱼阅读：无法读取《${book.name}》，文件可能已被移动、删除或编码不支持。`);
      return false;
    }
    state.currentId = id;
    persistList(true);
    render();
    return true;
  } finally {
    state.opening = false;
  }
}

function flash(message) {
  vscode.window.setStatusBarMessage('摸鱼阅读：' + message, 2000);
}

function step(direction) {
  if (!state.visible) {
    return; // 隐藏状态下不翻页，避免"看不见却在走"
  }
  const book = currentBook();
  if (!book) {
    return;
  }
  if (!state.content) {
    void openBook(book.id);
    return;
  }
  const size = state.pageLength || state.settings.charsPerLine;
  const progress = Number(book.progress) || 0;
  if (direction > 0) {
    if (progress + size >= state.content.length) {
      flash('已经是最后一页了');
      return;
    }
    book.progress = progress + size;
  } else {
    if (progress <= 0) {
      flash('已经是第一页了');
      return;
    }
    book.progress = Math.max(0, progress - size);
  }
  persistList(false);
  render();
}

function goto(progress) {
  if (!state.visible) {
    return;
  }
  const book = currentBook();
  if (!book) {
    return;
  }
  book.progress = Math.max(0, Math.min(Number(progress) || 0, Math.max(0, state.content.length - 1)));
  persistList(false);
  render();
}

/* ------------------------------------------------------------------ *
 * 命令
 * ------------------------------------------------------------------ */

/**
 * showQuickPick 没有 activeItem 选项，只能用 createQuickPick 手动设置可写的 activeItems，
 * 这样长列表打开时光标（和滚动位置）就落在指定项上。
 */
function pickWithFocus(items, activeItem, options) {
  return new Promise((resolve) => {
    const picker = vscode.window.createQuickPick();
    picker.items = items;
    picker.placeholder = (options && options.placeHolder) || '';
    picker.matchOnDescription = !!(options && options.matchOnDescription);
    picker.matchOnDetail = !!(options && options.matchOnDetail);
    if (activeItem) {
      picker.activeItems = [activeItem];
    }
    let result;
    picker.onDidAccept(() => {
      result = picker.selectedItems[0] || picker.activeItems[0];
      picker.hide();
    });
    picker.onDidHide(() => {
      picker.dispose();
      resolve(result);
    });
    picker.show();
  });
}

async function addBook() {
  const uris = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: '添加书籍',
    filters: { 电子书: ['txt', 'epub', 'mobi'] }
  });
  if (!uris || !uris.length) {
    return;
  }
  const file = uris[0].fsPath;
  const name = guessName(file);
  if (state.books.some((book) => book && book.name === name)) {
    vscode.window.showWarningMessage('书架中已有该书籍！');
    return;
  }

  const bookId = Date.now().toString();
  let book = null;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `摸鱼阅读：正在导入 ${name}` },
    async () => {
      if (/\.epub$/i.test(file)) {
        const res = await epubInfo(file);
        if (res.error_no !== 0 || !res.content || !res.content.length) {
          vscode.window.showErrorMessage('读取 epub 书籍失败：' + (res.error_info || '未知错误'));
          return;
        }
        book = { id: bookId, type: 'epub', name, progress: 0, showRight: false, ...saveAttachments(bookId, res.content, res.cover) };
      } else if (/\.mobi$/i.test(file)) {
        const res = await mobiInfo(file);
        if (res.error_no !== 0 || !res.content || !res.content.length) {
          vscode.window.showErrorMessage('读取 mobi 书籍失败：' + (res.error_info || '未知错误'));
          return;
        }
        book = { id: bookId, type: 'mobi', name, progress: 0, showRight: false, ...saveAttachments(bookId, res.content, res.cover) };
      } else {
        book = { id: bookId, type: 'txt', name, path: file, cover: '', progress: 0, showRight: false };
      }
    }
  );

  if (!book) {
    return;
  }
  state.books.push(book);
  persistList(true);
  await openBook(bookId);
}

function saveAttachments(bookId, chunks, cover) {
  let coverId = '';
  if (cover && cover.length) {
    coverId = `${DEVICE_ID}/${bookId}/cover`;
    state.store.postAttachment(coverId, cover);
  }
  const ids = chunks.map((buffer, index) => {
    const id = `${DEVICE_ID}/${bookId}/content${index}`;
    state.store.postAttachment(id, buffer);
    return id;
  });
  return { path: ids.join(','), cover: coverId };
}

async function pickBook() {
  if (!state.books.length) {
    const choice = await vscode.window.showInformationMessage('书架还是空的，先添加一本书吧。', '添加书籍');
    if (choice === '添加书籍') {
      await addBook();
    }
    return;
  }
  const bookItems = state.books.map((book) => ({
    label: (book.id === state.currentId ? '$(check) ' : '$(book) ') + book.name,
    description: book.type + ' · ' + book.progress + ' 字',
    detail: book.type === 'txt' ? book.path : '本地数据库',
    id: book.id
  }));
  const picked = await pickWithFocus(bookItems, bookItems.find((item) => item.id === state.currentId), {
    placeHolder: '选择要阅读的书籍',
    matchOnDescription: true
  });
  if (picked) {
    await openBook(picked.id);
  }
}

async function removeBook() {
  if (!state.books.length) {
    return;
  }
  const picked = await vscode.window.showQuickPick(
    state.books.map((book) => ({ label: book.name, description: book.type, id: book.id })),
    { placeHolder: '选择要删除的书籍' }
  );
  if (!picked) {
    return;
  }
  const confirm = await vscode.window.showWarningMessage(`确定从书架删除《${picked.label}》吗？`, { modal: true }, '删除');
  if (confirm !== '删除') {
    return;
  }
  const book = state.books.find((one) => one && one.id === picked.id);
  if (book && (book.type === 'epub' || book.type === 'mobi')) {
    String(book.path || '')
      .split(',')
      .filter(Boolean)
      .forEach((id) => state.store.remove(id));
    if (book.cover) {
      state.store.remove(book.cover);
    }
  }
  state.books = state.books.filter((one) => one && one.id !== picked.id);
  if (state.currentId === picked.id) {
    state.currentId = null;
    state.content = '';
    state.contentKey = '';
  }
  persistList(true);
  render();
}

async function jumpChapter() {
  const book = currentBook();
  if (!book) {
    await pickBook();
    return;
  }
  if (!(await ensureContent(book))) {
    vscode.window.showWarningMessage('摸鱼阅读：读取书籍内容失败。');
    return;
  }
  const chapters = getChapters(state.content, Number(book.progress) || 0);
  if (!chapters.length) {
    vscode.window.showInformationMessage('这本书没有识别到章节，试试「跳转到百分比」。');
    return;
  }
  const items = chapters.map((chapter, index) => ({
    label: (chapter.isCur ? '$(check) ' : '') + chapter.name,
    description: '第 ' + (index + 1) + ' 章',
    detail: percentOf(state.content, chapter.index, 0).toFixed(2) + '%',
    index: chapter.index
  }));
  // 打开时把光标停在当前章节上，长书不用自己翻
  const currentIndex = chapters.findIndex((chapter) => chapter.isCur);
  const picked = await pickWithFocus(items, currentIndex >= 0 ? items[currentIndex] : undefined, {
    placeHolder: `共 ${chapters.length} 章`,
    matchOnDescription: true
  });
  if (picked) {
    goto(picked.index);
  }
}

async function searchBook() {
  const book = currentBook();
  if (!book) {
    await pickBook();
    return;
  }
  if (!(await ensureContent(book))) {
    return;
  }
  const keyword = await vscode.window.showInputBox({ prompt: '输入要搜索的内容', value: '' });
  if (!keyword) {
    return;
  }
  const hits = search(state.content, keyword, 50);
  if (!hits.length) {
    vscode.window.showInformationMessage(`没有找到「${keyword}」。`);
    return;
  }
  const picked = await vscode.window.showQuickPick(
    hits.map((hit) => ({
      label: `${hit.before}${hit.match}${hit.after}`,
      description: percentOf(state.content, hit.index, 0).toFixed(2) + '%',
      index: hit.index
    })),
    { placeHolder: `找到 ${hits.length} 处`, matchOnDescription: false }
  );
  if (picked) {
    goto(picked.index);
  }
}

async function jumpPercent() {
  const book = currentBook();
  if (!book) {
    return;
  }
  const input = await vscode.window.showInputBox({
    prompt: '跳转到百分之多少（0 - 100）',
    value: percentOf(state.content, Number(book.progress) || 0, state.settings.charsPerLine).toFixed(2),
    validateInput: (value) => {
      const num = Number(value);
      if (Number.isNaN(num) || num < 0 || num > 100) {
        return '请输入 0 到 100 之间的数字';
      }
      return null;
    }
  });
  if (input === undefined) {
    return;
  }
  const size = state.settings.charsPerLine;
  const target = Math.floor((state.content.length * Number(input)) / 100);
  goto(Math.floor(target / size) * size);
}

function stopAutoPage() {
  if (state.autoTimer) {
    clearInterval(state.autoTimer);
    state.autoTimer = null;
    return true;
  }
  return false;
}

function startAutoPage(seconds) {
  stopAutoPage();
  if (!seconds) {
    return false;
  }
  state.autoTimer = setInterval(() => step(1), Math.max(1, seconds) * 1000);
  return true;
}

async function toggleAutoPage() {
  if (stopAutoPage()) {
    flash('自动翻页已暂停');
    return;
  }
  let seconds = state.settings.autoPageSeconds;
  if (!seconds) {
    const input = await vscode.window.showInputBox({
      prompt: '每隔多少秒翻一页（回车开始，之后可在设置里改 readbar.autoPageSeconds）',
      value: '30',
      validateInput: (text) => {
        const num = Number(text);
        if (!text || Number.isNaN(num) || num <= 0 || num > 600) {
          return '请输入 1 到 600 之间的数字';
        }
        return null;
      }
    });
    if (input === undefined) {
      return;
    }
    seconds = Math.round(Number(input));
    await vscode.workspace.getConfiguration('readbar').update('autoPageSeconds', seconds, vscode.ConfigurationTarget.Global);
    state.settings.autoPageSeconds = seconds;
  }
  startAutoPage(seconds);
  flash(`自动翻页已开启，每 ${seconds} 秒一页`);
}

async function openSettings() {
  await vscode.commands.executeCommand('workbench.action.openSettings', 'readbar');
}

function toggleStatusBar() {
  state.visible = !state.visible;
  if (!state.visible) {
    // 隐藏期间冻结：自动翻页计时器停掉，翻页命令在 step() 里直接返回
    if (stopAutoPage()) {
      state.autoPausedByHide = true;
    }
  } else if (state.autoPausedByHide) {
    state.autoPausedByHide = false;
    startAutoPage(state.settings.autoPageSeconds);
  }
  render();
  if (!state.visible) {
    vscode.window.showInformationMessage('状态栏阅读区已隐藏，阅读进度已冻结；执行命令「摸鱼阅读: 显示 / 隐藏状态栏」可以恢复。');
  } else {
    flash('已恢复显示');
  }
}

async function setCharsPerLine() {
  const current = state.settings.charsPerLine;
  const presets = [20, 30, 40, 50, 60, 80, 100, 120];
  const items = presets.map((value) => ({
    label: `${value} 字`,
    description: value === current ? '当前' : '',
    value
  }));
  items.push({ label: '$(pencil) 自定义…', description: '10 - 300', value: -1 });
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `状态栏一行显示多少字（当前 ${current}）`
  });
  if (!picked) {
    return;
  }
  let value = picked.value;
  if (value === -1) {
    const input = await vscode.window.showInputBox({
      prompt: '每行显示多少字（10 - 300）',
      value: String(current),
      validateInput: (text) => {
        const num = Number(text);
        if (!text || Number.isNaN(num) || num < 10 || num > 300) {
          return '请输入 10 到 300 之间的数字';
        }
        return null;
      }
    });
    if (input === undefined) {
      return;
    }
    value = Math.round(Number(input));
  }
  await vscode.workspace.getConfiguration('readbar').update('charsPerLine', value, vscode.ConfigurationTarget.Global);
  flash(`每行 ${value} 字`);
}

async function customizeKeys() {
  try {
    // 直接打开 VS Code 自带的键盘快捷方式编辑器，并预置好搜索词
    await vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', '摸鱼阅读');
  } catch (err) {
    vscode.window.showInformationMessage('可以手动执行「首选项: 打开键盘快捷方式」后搜索「摸鱼阅读」。');
  }
}

async function menu() {
  const book = currentBook();
  const items = [
    { label: '$(add) 添加书籍', id: 'readbar.addBook' },
    { label: '$(library) 切换书籍', id: 'readbar.pickBook', description: book ? book.name : '书架为空' },
    { label: '$(chevron-right) 下一页', id: 'readbar.next', description: 'Alt+]' },
    { label: '$(chevron-left) 上一页', id: 'readbar.prev', description: 'Alt+[' },
    { label: '$(list-unordered) 章节跳转', id: 'readbar.jumpChapter' },
    { label: '$(search) 搜索内容', id: 'readbar.search' },
    { label: '$(dashboard) 跳转到百分比', id: 'readbar.jumpPercent' },
    {
      label: (state.autoTimer ? '$(debug-pause) 暂停自动翻页' : '$(play) 开始自动翻页'),
      id: 'readbar.toggleAutoPage'
    },
    {
      label: state.visible ? '$(eye-closed) 隐藏状态栏' : '$(eye) 显示状态栏',
      id: 'readbar.toggleStatusBar'
    },
    { label: '$(symbol-number) 设置每行字数', id: 'readbar.setCharsPerLine' },
    { label: '$(gear) 打开设置', id: 'readbar.openSettings' },
    { label: '$(keyboard) 自定义快捷键', id: 'readbar.customizeKeys' },
    { label: '$(trash) 删除书籍', id: 'readbar.removeBook' }
  ];
  const picked = await vscode.window.showQuickPick(items, { placeHolder: '摸鱼阅读' });
  if (picked) {
    await vscode.commands.executeCommand(picked.id);
  }
}

/* ------------------------------------------------------------------ *
 * 激活
 * ------------------------------------------------------------------ */

function activate(context) {
  state.store = new Store(context.globalStorageUri.fsPath);
  state.settings = readSettings();

  createStatusItem();
  context.subscriptions.push({
    dispose() {
      if (state.statusItem) {
        state.statusItem.dispose();
      }
    }
  });

  const register = (id, handler) => context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  register('readbar.menu', menu);
  register('readbar.addBook', addBook);
  register('readbar.pickBook', pickBook);
  register('readbar.removeBook', removeBook);
  register('readbar.next', () => step(1));
  register('readbar.prev', () => step(-1));
  register('readbar.jumpChapter', jumpChapter);
  register('readbar.search', searchBook);
  register('readbar.jumpPercent', jumpPercent);
  register('readbar.toggleAutoPage', toggleAutoPage);
  register('readbar.toggleStatusBar', toggleStatusBar);
  register('readbar.customizeKeys', customizeKeys);
  register('readbar.setCharsPerLine', setCharsPerLine);
  register('readbar.openSettings', openSettings);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('readbar')) {
        return;
      }
      const previous = state.settings;
      state.settings = readSettings();
      if (previous.statusBarAlign !== state.settings.statusBarAlign) {
        createStatusItem();
        return;
      }
      if (previous.keepFormat !== state.settings.keepFormat) {
        state.content = '';
        state.contentKey = '';
        const book = currentBook();
        if (book) {
          void openBook(book.id);
          return;
        }
      }
      render();
    })
  );

  const doc = loadBooks();
  render();

  if (state.settings.autoResume) {
    const lastId = doc && doc.lastId;
    const target = state.books.find((book) => book && book.id === lastId) || state.books[0];
    if (target) {
      void openBook(target.id);
    }
  }

  context.subscriptions.push({
    dispose() {
      if (state.autoTimer) {
        clearInterval(state.autoTimer);
        state.autoTimer = null;
      }
      persistList(true);
    }
  });
}

function deactivate() {
  if (state.autoTimer) {
    clearInterval(state.autoTimer);
    state.autoTimer = null;
  }
  if (state.store) {
    persistList(true);
  }
}

module.exports = { activate, deactivate };
