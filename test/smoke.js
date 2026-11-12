'use strict';

/**
 * 不启动 VS Code，用一个假的 vscode 模块把扩展跑一遍：
 * 添加书 → 状态栏出字 → 翻页 → 章节跳转 → 搜索 → 落盘。
 * 运行：node test/smoke.js
 */

const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

/* ------------------------- 假的 vscode 模块 ------------------------- */

const commands = new Map();
const scripted = { openDialog: [], quickPick: [], input: [] };
const messages = [];

const statusItem = {
  text: '',
  tooltip: '',
  command: '',
  name: '',
  visible: false,
  show() {
    this.visible = true;
  },
  hide() {
    this.visible = false;
  },
  dispose() {}
};

let configListener = null;
let lastQuickPick = null;

const configValues = {
  statusBarAlign: 'left',
  useDefaultKeys: true,
  charsPerLine: 40,
  maxStatusWidth: 720,
  showIcon: true,
  showPercent: false,
  keepFormat: false,
  autoResume: true,
  autoPageSeconds: 0
};

class MarkdownString {
  constructor() {
    this.value = '';
  }
  appendMarkdown(text) {
    this.value += text;
    return this;
  }
}

const vscodeStub = {
  StatusBarAlignment: { Left: 1, Right: 2 },
  ProgressLocation: { Notification: 15 },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  MarkdownString,
  Uri: { file: (p) => ({ fsPath: p, scheme: 'file', toString: () => 'file://' + p }) },
  window: {
    createStatusBarItem: (align, priority) => {
      statusItem.alignment = align;
      statusItem.priority = priority;
      return statusItem;
    },
    showOpenDialog: async () => scripted.openDialog.shift() || undefined,
    createQuickPick: () => {
      const handlers = { accept: null, hide: null };
      const picker = {
        items: [],
        placeholder: '',
        matchOnDescription: false,
        matchOnDetail: false,
        activeItems: [],
        selectedItems: [],
        onDidAccept: (cb) => {
          handlers.accept = cb;
          return { dispose() {} };
        },
        onDidHide: (cb) => {
          handlers.hide = cb;
          return { dispose() {} };
        },
        show: () => {
          lastQuickPick = {
            items: picker.items,
            options: { placeHolder: picker.placeholder, activeItem: picker.activeItems[0] }
          };
          const next = scripted.quickPick.shift();
          let chosen;
          if (typeof next === 'function') {
            chosen = next(picker.items);
          } else if (typeof next === 'number') {
            chosen = picker.items[next];
          } else if (typeof next === 'string') {
            chosen = picker.items.find((item) => String(item.label).includes(next));
          }
          if (chosen) {
            picker.selectedItems = [chosen];
            picker.activeItems = [chosen];
            if (handlers.accept) {
              handlers.accept();
            }
          }
          if (handlers.hide) {
            handlers.hide();
          }
        },
        hide: () => {},
        dispose: () => {}
      };
      return picker;
    },
    showQuickPick: async (items, options) => {
      lastQuickPick = { items, options };
      const next = scripted.quickPick.shift();
      if (typeof next === 'function') {
        return next(items);
      }
      if (typeof next === 'number') {
        return items[next];
      }
      if (typeof next === 'string') {
        return items.find((item) => String(item.label).includes(next));
      }
      return undefined;
    },
    showInputBox: async () => scripted.input.shift(),
    showInformationMessage: async (msg) => {
      messages.push(msg);
      return undefined;
    },
    showWarningMessage: async (msg) => {
      messages.push(msg);
      return undefined;
    },
    showErrorMessage: async (msg) => {
      messages.push(msg);
      return undefined;
    },
    setStatusBarMessage: (msg) => {
      messages.push(msg);
    },
    withProgress: async (options, task) => task()
  },
  commands: {
    registerCommand: (id, handler) => {
      commands.set(id, handler);
      return { dispose: () => commands.delete(id) };
    },
    executeCommand: async (id, ...args) => {
      if (id === 'setContext') {
        return undefined;
      }
      const handler = commands.get(id);
      if (!handler) {
        throw new Error('命令未注册: ' + id);
      }
      return handler(...args);
    }
  },
  workspace: {
    getConfiguration: () => ({
      get: (key) => configValues[key],
      update: async (key, value) => {
        configValues[key] = value;
        if (configListener) {
          configListener({ affectsConfiguration: () => true });
        }
      }
    }),
    onDidChangeConfiguration: (cb) => {
      configListener = cb;
      return { dispose() {} };
    }
  }
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeStub;
  }
  return originalLoad.call(this, request, parent, isMain);
};

/* ----------------------------- 测试数据 ----------------------------- */

function buildBookText() {
  const body = (title) => title + '\n' + '这是一段用来测试状态栏阅读的文字，'.repeat(12) + '\n';
  return (
    body('第一章 开端') +
    body('第二章 转折') +
    body('第三章 高潮') +
    body('第四章 尾声') +
    '全书完。\n'
  );
}

function assert(condition, label) {
  if (!condition) {
    console.error('  ✗ ' + label);
    process.exitCode = 1;
    throw new Error('断言失败: ' + label);
  }
  console.log('  ✓ ' + label);
}

async function main() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'readbar-'));
  const bookFile = path.join(workspace, '测试小说.txt');
  fs.writeFileSync(bookFile, buildBookText(), 'utf8');
  const storage = path.join(workspace, 'storage');
  fs.mkdirSync(storage, { recursive: true });

  const extension = require('../extension');
  const context = { globalStorageUri: { fsPath: storage }, subscriptions: [] };

  console.log('\n[1] 激活扩展');
  extension.activate(context);
  assert(statusItem.visible === true, '状态栏项已显示');
  assert(statusItem.text.includes('点击添加书籍'), '没有书时显示占位文字: ' + statusItem.text);
  assert(statusItem.alignment === 1, '对齐方式 = Left（文字居左）');
  assert(statusItem.priority === 100000, '优先级最高，贴着状态栏左边缘');

  console.log('\n[2] 添加书籍');
  scripted.openDialog.push([vscodeStub.Uri.file(bookFile)]);
  await commands.get('readbar.addBook')();
  assert(statusItem.text.startsWith('$(book) '), '状态栏带书本图标');
  const firstPage = statusItem.text;
  assert(firstPage.includes('第一章'), '状态栏显示第一页内容: ' + firstPage);
  assert(firstPage.length <= 40 + 8, '按每行 40 字截断，长度 ' + firstPage.length);

  console.log('\n[3] 翻页');
  const nextPromise = commands.get('readbar.next')();
  await nextPromise;
  const secondPage = statusItem.text;
  assert(secondPage !== firstPage, '下一页内容变了');
  await commands.get('readbar.prev')();
  assert(statusItem.text === firstPage, '上一页回到原内容');

  // 隐藏时禁止翻页
  await commands.get('readbar.toggleStatusBar')();
  assert(statusItem.visible === false, '状态栏已隐藏');
  await commands.get('readbar.next')();
  await commands.get('readbar.toggleStatusBar')();
  assert(statusItem.visible === true, '状态栏已恢复');
  assert(statusItem.text === firstPage, '隐藏期间按下一页不生效，进度冻结');

  console.log('\n[4] 每行字数可调');
  scripted.quickPick.push(4); // 20 / 30 / 40 / 50 / 60 → 选 60 字
  await commands.get('readbar.setCharsPerLine')();
  assert(configValues.charsPerLine === 60, '每行字数已写入设置: ' + configValues.charsPerLine);
  assert(statusItem.text.length > firstPage.length, '状态栏显示变长: ' + statusItem.text.length + ' > ' + firstPage.length);

  // 窗口放不下 → 按像素裁剪，且翻页步长跟着变，不能跳字
  configValues.charsPerLine = 100;
  configValues.maxStatusWidth = 300; // 300 - 24(图标) = 276px ≈ 18 个汉字
  configListener({ affectsConfiguration: () => true });
  const flat = buildBookText().replace(/\r?\n/g, ' ').replace(/\s{2,}/g, ' ');
  const shown = statusItem.text.replace('$(book) ', '');
  assert(shown.length < 100, '放不下 100 字，按宽度裁到 ' + shown.length + ' 字');
  const at = flat.indexOf(shown);
  assert(at >= 0, '屏幕上的文字来自原文');
  await commands.get('readbar.next')();
  const nextShown = statusItem.text.replace('$(book) ', '');
  assert(flat.indexOf(nextShown) === at + shown.length, '下一页紧接上一页，没有跳字');
  configValues.charsPerLine = 60;
  configValues.maxStatusWidth = 720;
  configListener({ affectsConfiguration: () => true });

  console.log('\n[5] 章节跳转');
  scripted.quickPick.push(2);
  await commands.get('readbar.jumpChapter')();
  assert(statusItem.text.includes('第三章'), '跳到第三章: ' + statusItem.text);

  // 再次打开时，光标应停在当前章节上
  scripted.quickPick.push(2);
  await commands.get('readbar.jumpChapter')();
  assert(
    lastQuickPick.options.activeItem && String(lastQuickPick.options.activeItem.label).includes('第三章'),
    '章节列表默认选中当前章节: ' + (lastQuickPick.options.activeItem || {}).label
  );

  console.log('\n[6] 搜索');
  scripted.input.push('第三章');
  scripted.quickPick.push(0);
  await commands.get('readbar.search')();
  assert(statusItem.text.includes('第三章'), '搜索命中并跳转');

  console.log('\n[7] 跳转百分比');
  scripted.input.push('100');
  await commands.get('readbar.jumpPercent')();
  assert(statusItem.text.includes('全书完') || statusItem.text.includes('尾声'), '跳到末尾: ' + statusItem.text);

  console.log('\n[8] 进度落盘');
  extension.deactivate();
  const dbFile = path.join(storage, 'readbar-db', 'db.json');
  assert(fs.existsSync(dbFile), 'db.json 已写入 ' + dbFile);
  const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  const list = db.docs['readbar/list'];
  assert(list && list.data.length === 1, '书架里有 1 本书');
  assert(list.lastId === list.data[0].id, '记录了上次阅读的书');
  assert(Number(list.data[0].progress) > 0, '阅读进度已保存: ' + list.data[0].progress);

  console.log('\n[9] 灰色边界：文件被删掉后重新启动 VS Code');
  fs.unlinkSync(bookFile);
  messages.length = 0;
  // 清掉 require 缓存，模拟新开一个 VS Code 窗口（内存缓存全部失效）
  delete require.cache[require.resolve('../extension')];
  const freshExtension = require('../extension');
  freshExtension.activate({ globalStorageUri: { fsPath: storage }, subscriptions: [] });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert(
    messages.some((m) => String(m).includes('无法读取')),
    '自动恢复失败时给出提示而不是崩溃: ' + JSON.stringify(messages)
  );

  console.log('\n[10] 状态栏位置可配置');
  configValues.statusBarAlign = 'right';
  configListener({ affectsConfiguration: () => true });
  assert(statusItem.alignment === 2, '设置成 right 后重建为右对齐');
  configValues.statusBarAlign = 'left';
  configListener({ affectsConfiguration: () => true });
  assert(statusItem.alignment === 1, '改回 left 后重新居左');

  console.log('\n[11] 自动翻页：没配间隔时弹框问一次');
  configValues.autoPageSeconds = 0;
  scripted.input.push('2');
  await commands.get('readbar.toggleAutoPage')();
  assert(configValues.autoPageSeconds === 2, '间隔已写入设置: ' + configValues.autoPageSeconds);
  await commands.get('readbar.toggleAutoPage')(); // 停掉计时器，否则测试进程不退出

  console.log('\n[12] 翻页不漂移（每页字数不一致时）');
  const mixed = path.join(workspace, '混排.txt');
  const lines = [];
  for (let i = 1; i <= 40; i++) {
    lines.push('第' + i + '段');
    lines.push('abc'.repeat((i % 7) + 1) + '知道他想做什么，但还是伸手和夏德握了一下。');
  }
  fs.writeFileSync(mixed, lines.join('\n'), 'utf8');
  configValues.maxStatusWidth = 300; // 收窄到放不下整数个汉字，逼出长短不一的页
  configListener({ affectsConfiguration: () => true });
  scripted.openDialog.push([vscodeStub.Uri.file(mixed)]);
  await commands.get('readbar.addBook')();

  const pages = [statusItem.text];
  for (let i = 0; i < 6; i++) {
    await commands.get('readbar.next')();
    pages.push(statusItem.text);
  }
  const lens = pages.map((t) => t.length);
  assert(new Set(lens).size > 1, '各页字数确实不一致: ' + lens.join(','));

  for (let i = pages.length - 2; i >= 0; i--) {
    await commands.get('readbar.prev')();
    assert(statusItem.text === pages[i], '退回第 ' + (i + 1) + ' 页内容完全一致');
  }

  console.log('\n[13] 设置项 schema 与说明一致');
  const pkg = require('../package.json');
  const props = pkg.contributes.configuration.properties;
  assert(props['readbar.maxStatusWidth'].minimum === 0, 'maxStatusWidth 允许填 0（0 = 不限制）');
  assert(props['readbar.autoPageSeconds'].minimum === 0, 'autoPageSeconds 允许填 0（0 = 关闭）');

  console.log('\n全部通过 ✅  数据目录: ' + workspace);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
