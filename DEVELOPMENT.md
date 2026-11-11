# 开发与发布

## 目录结构

```
extension.js        扩展入口：命令注册、状态栏渲染、阅读进度
lib/book.js         分页 / 百分比 / 章节 / 搜索 / 按宽度取字（纯函数）
lib/parser.js       txt·epub·mobi 解析与编码识别
lib/store.js        JSON 数据库（与桌面版同构）
test/smoke.js       不启动 VS Code 的冒烟测试
images/icon.png     扩展图标
```

## 本地调试

```bash
npm install
npm test        # 用假的 vscode 模块跑完整流程
```

想真正跑起来：用 VS Code 打开本目录，按 `F5`（`运行扩展`），会弹出一个新的 VS Code 窗口。

## 打包

```bash
npm run package        # 产出 readbar-<version>.vsix
npm run package:file   # 产出固定名 readbar.vsix
npm run install:vsix   # 打包并安装到本机
```

## 发布到 Marketplace

1. 到 https://marketplace.visualstudio.com/manage 创建 publisher，名字必须和
   `package.json` 里的 `publisher`（当前是 `kiryu`）一致，否则会提示找不到。
2. 在 Azure DevOps 生成 Personal Access Token，Scope 选 **Marketplace → Manage**。
3. 登录并发布：

```bash
npx vsce login kiryu
npm run publish:patch    # 等价于 vsce publish patch
```

4. 发布后 https://marketplace.visualstudio.com/items?itemName=kiryu.readbar 即可访问。

> 建议先在 `package.json` 补上 `repository` 字段，Marketplace 页面会多一个仓库入口。

## 两个踩过的坑

**状态栏没有「窗口宽度」这个 API。**
所以「一行能放多少字」只能按像素估算（汉字 15px / 半角 8px），再用
`readbar.maxStatusWidth` 兜底。估大了会溢出被裁，估小了会留白。

**`showQuickPick` 没有 `activeItem` 选项。**
想默认选中某一项，必须用 `createQuickPick()`，在 `show()` 之前设置可写的
`picker.activeItems = [item]`。传 `activeItem` 会被静默忽略。
