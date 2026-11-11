'use strict';

/**
 * 分页 / 章节 / 搜索：全部照搬 src/App.js 里的算法，
 * 只是把 React 的 this.state 换成了函数参数。
 * 进度用「字符偏移量」表示，和 Electron 版存的是同一个东西。
 */

const CHAPTER_REG = /(正文){0,1}(第)([零〇一二三四五六七八九十壹贰叁肆伍陆柒捌玖拾两百千万a-zA-Z0-9]{1,7})[章节卷篇回](\s+)((?! {4}).)((?!\t{1,4}).){0,30}\r?\n/g;

/** 取第 progress 个字符开始的一页 */
function pageText(content, progress, pageSize, keepFormat) {
  if (!content) {
    return '';
  }
  const start = Math.max(0, Number(progress) || 0);
  const size = Math.max(1, Number(pageSize) || 100);
  const str = content.substring(start, start + size);
  return keepFormat ? str : str.replace(/\n|\r/g, ' ').replace(/\s{2,}/g, ' ');
}

/** 已读百分比，最多 100，和 Electron 版一样保留两位小数 */
function percentOf(content, progress, pageSize) {
  if (!content || !content.length) {
    return 0;
  }
  const end = (Number(progress) || 0) + (Number(pageSize) || 100);
  const pct = Math.round((end / content.length) * 10000) / 100;
  return Math.min(100, Math.max(0, pct));
}

/**
 * 章节列表。原实现靠 String.indexOf 反复查找，
 * 这里改成带 index 的正则匹配，结果一致但不会因为重复章节名错位。
 */
function getChapters(content, cur) {
  if (!content) {
    return [];
  }
  const chapters = [];
  CHAPTER_REG.lastIndex = 0;
  let match = CHAPTER_REG.exec(content);
  while (match) {
    chapters.push({
      name: match[0].replace(/\r?\n$/, '').trim(),
      index: match.index,
      isCur: false
    });
    match = CHAPTER_REG.exec(content);
  }
  const position = Number(cur) || 0;
  for (let i = chapters.length - 1; i >= 0; i--) {
    if (chapters[i].index <= position) {
      chapters[i].isCur = true;
      break;
    }
  }
  if (!chapters.some((item) => item.isCur) && chapters.length) {
    chapters[0].isCur = true;
  }
  return chapters;
}

/** 查找关键字，返回带上下文的命中列表 */
function search(content, keyword, limit) {
  const result = [];
  if (!content || !keyword) {
    return result;
  }
  const max = limit || 30;
  let index = content.indexOf(keyword);
  while (index !== -1 && result.length < max) {
    const begin = Math.max(0, index - 17);
    const end = Math.min(content.length, index + keyword.length + 17);
    const cont = content.substring(begin, end).replace(/\s/g, '');
    const keywordIndex = cont.indexOf(keyword);
    if (keywordIndex >= 0) {
      result.push({
        index,
        before: cont.substring(0, keywordIndex),
        match: cont.substring(keywordIndex, keywordIndex + keyword.length),
        after: cont.substring(keywordIndex + keyword.length)
      });
    } else {
      result.push({ index, before: '', match: keyword, after: cont });
    }
    index = content.indexOf(keyword, index + keyword.length);
  }
  return result;
}

/* 状态栏一行能放多少字，取决于字体像素宽度。
 * 12px 字体下：汉字/全角标点约 15px，半角字符约 8px。
 * 这是估算值，宁可估大不估小——估小了会溢出被窗口裁掉。 */
const CJK_PX = 15;
const ASCII_PX = 8;

function charPx(code) {
  return code > 0x2e7f ? CJK_PX : ASCII_PX;
}

/**
 * 从 raw 里取出宽度不超过 budgetPx 的那一段。
 * 换行/制表符按一个空格算，连续空白合并，和最终显示效果一致。
 * @returns {{text: string, used: number}} used = 消耗掉的原始字符数，用于推进阅读进度
 */
function takeByWidth(raw, budgetPx) {
  if (!raw) {
    return { text: '', used: 0 };
  }
  if (!budgetPx || budgetPx <= 0) {
    return { text: raw, used: raw.length };
  }
  let width = 0;
  let used = 0;
  let out = '';
  let lastSpace = false;
  for (const ch of raw) {
    const shown = ch === '\n' || ch === '\r' || ch === '\t' ? ' ' : ch;
    if (shown === ' ' && lastSpace) {
      used += ch.length;
      continue;
    }
    const w = charPx(shown.codePointAt(0));
    if (width + w > budgetPx) {
      return { text: out, used: used || 1 };
    }
    width += w;
    out += shown;
    lastSpace = shown === ' ';
    used += ch.length;
  }
  return { text: out, used };
}

/**
 * 状态栏是一行纯文本，换行、制表符都要压平；
 * 另外 "$(" 会被 VS Code 当成 codicon 图标，必须拆开。
 */
function toStatusText(text, maxChars) {
  let str = String(text || '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  str = str.replace(/\$\(/g, '$ (');
  const max = Number(maxChars) || 0;
  if (max > 0 && str.length > max) {
    str = str.substring(0, max - 1) + '…';
  }
  return str;
}

module.exports = { pageText, percentOf, getChapters, search, toStatusText, takeByWidth, charPx, CHAPTER_REG };
