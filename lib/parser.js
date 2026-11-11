'use strict';

const fs = require('fs');
const path = require('path');

const safeRequire = (name) => {
  try {
    return require(name);
  } catch (err) {
    return null;
  }
};

const iconv = safeRequire('iconv-lite');
const jschardet = safeRequire('jschardet');
const EPub = safeRequire('epub');
// js-mobi 的 main 指向 dist/index.js，那个文件在 require 时就去读作者的本地样例，必崩；
// 所以只能直接引 dist/Mobi
const mobiModule = safeRequire('js-mobi/dist/Mobi');
const mobi = mobiModule && mobiModule.default ? mobiModule.default : mobiModule;

/**
 * 原样搬运 public/preload.js 里的清洗规则：去掉制表符、合并多余空格和空行。
 */
function cleanText(str) {
  return str
    .replace(/\t/g, '')
    .replace(/[，]\s{2,}(?!第)/g, '， ')
    .replace(/[。]\s{2,}(?!第)/g, '。 ')
    .replace(/[？]\s{2,}(?!第)/g, '？ ')
    .replace(/[！]\s{2,}(?!第)/g, '！ ')
    .replace(/[,]\s{2,}(?!第)/g, ', ')
    .replace(/[.]\s{2,}(?!第)/g, '. ')
    .replace(/[?]\s{2,}(?!第)/g, '? ')
    .replace(/[!]\s{2,}(?!第)/g, '! ')
    .replace(/["]\s{2,}(?!第)/g, '" ')
    .replace(/[”]\s{2,}(?!第)/g, '” ')
    .replace(/[……]\s{2,}(?!第)/g, '…… ')
    .replace(/\n\n\n/g, '\n')
    .replace(/\n\n/g, '\n');
}

/**
 * 用 jschardet 猜编码再用 iconv 解码，和 Electron 版保持一致。
 */
function decodeBuffer(buffer, keepFormat) {
  if (!buffer || buffer.length <= 0) {
    return null;
  }
  let encodingCheck = {};
  if (jschardet && iconv) {
    if (buffer.byteLength > 2500) {
      const head = Buffer.alloc(2500);
      buffer.copy(head, 0, 0, 2500);
      encodingCheck = jschardet.detect(head);
    } else {
      encodingCheck = jschardet.detect(buffer);
    }
  }
  let str;
  if (iconv && encodingCheck && encodingCheck.confidence > 0.45 && encodingCheck.encoding) {
    str = iconv.decode(buffer, encodingCheck.encoding);
  } else if (iconv) {
    str = iconv.decode(buffer, 'utf-8');
  } else {
    str = buffer.toString('utf-8');
  }
  return keepFormat ? str : cleanText(str);
}

function chunkBuffer(buffer, size = 9500000) {
  const chunks = [];
  for (let i = 0; i < Math.ceil(buffer.length / size); i++) {
    chunks.push(Buffer.from(buffer.subarray(i * size, Math.min((i + 1) * size, buffer.length))));
  }
  return chunks;
}

function readFileAsync(file) {
  return new Promise((resolve) => {
    fs.readFile(file, (err, buffer) => resolve(err ? null : buffer));
  });
}

function getChapter(epub, id) {
  return new Promise((resolve, reject) => {
    epub.getChapter(id, (err, text) => (err ? reject(err) : resolve(text)));
  });
}

function getImage(epub, id) {
  return new Promise((resolve, reject) => {
    epub.getImage(id, (err, buf) => (err ? reject(err) : resolve(buf)));
  });
}

/** 解析 epub，返回 { error_no, error_info, content: Buffer[], cover?: Buffer } */
function epubInfo(filePath) {
  return new Promise((resolve) => {
    if (!EPub) {
      resolve({ error_no: 97, error_info: 'epub 模块不可用' });
      return;
    }
    let epub;
    try {
      epub = new EPub(filePath);
    } catch (err) {
      resolve({ error_no: 999, error_info: String((err && err.message) || err) });
      return;
    }
    epub.on('error', (err) => {
      resolve({ error_no: 999, error_info: String((err && err.message) || err) });
    });
    epub.on('end', async () => {
      try {
        if (!epub.flow || epub.flow.length === 0) {
          resolve({ error_no: 1, error_info: '解析 epub 内容失败' });
          return;
        }
        let str = '';
        for (const chapter of epub.flow) {
          const title = chapter.title || '';
          if (String(chapter.id).indexOf('cover') !== -1 || title === '封面' || title === '目录' || title === 'cover' || title === 'menu') {
            continue;
          }
          const text = await getChapter(epub, chapter.id);
          str += String(text).replace(/<\/?.+?>/g, '') + '\n';
        }
        const buffer = Buffer.from(str);
        if (!buffer.length) {
          resolve({ error_no: 1, error_info: '未获取到 epub 书籍内容' });
          return;
        }
        const result = { error_no: 0, error_info: '解析成功', content: chunkBuffer(buffer) };
        if (epub.metadata && epub.metadata.cover) {
          try {
            result.cover = await getImage(epub, epub.metadata.cover);
          } catch (err) {
            /* 没有封面不影响阅读 */
          }
        }
        resolve(result);
      } catch (err) {
        resolve({ error_no: 999, error_info: String((err && err.message) || err) });
      }
    });
    epub.parse();
  });
}

/** 解析 mobi，返回结构同 epubInfo（mobi 没有封面） */
async function mobiInfo(filePath) {
  if (!mobi || typeof mobi.read !== 'function') {
    return { error_no: 97, error_info: 'mobi 模块不可用' };
  }
  const buffer = await readFileAsync(filePath);
  if (!buffer) {
    return { error_no: 98, error_info: '读取文件出错' };
  }
  let book;
  try {
    book = mobi.read(Uint8Array.from(buffer));
  } catch (err) {
    return { error_no: 98, error_info: '读取文件出错，错误信息：' + String((err && err.message) || err) };
  }
  const list = String(book.getTextContent()).split('<mbp:pagebreak/>');
  list.splice(0, 1);
  const chapterReg = /(第)([零〇一二三四五六七八九十壹贰叁肆伍陆柒捌玖拾两百千万a-zA-Z0-9]{1,7})[章节卷篇回]/g;
  const titleReg = /(第)([零〇一二三四五六七八九十壹贰叁肆伍陆柒捌玖拾两百千万a-zA-Z0-9]{1,7})[章节卷篇回](\s+)((?!<).){0,30}/g;
  let allStr = '';
  list.forEach((element, idx) => {
    let ele = element;
    const matched = ele.match(chapterReg);
    if (matched && matched.length >= 10) {
      return; // 目录页
    }
    let str = '';
    const title = ele.match(titleReg);
    if (title && title.length > 0) {
      ele = ele.replace(titleReg, '');
      str += title[0] + '\n';
    }
    str += ele.replace(/<\/?.+?>/g, '') + '\n';
    if (idx === list.length - 1 && str.length < 100) {
      return; // 最后一段通常是版权页
    }
    allStr += str;
  });
  if (!allStr || allStr.length <= 100) {
    return { error_no: 99, error_info: '解析失败' };
  }
  return { error_no: 0, error_info: '解析成功', content: chunkBuffer(Buffer.from(allStr)) };
}

/**
 * 读取一本书的正文。
 * txt 直接读磁盘；epub / mobi 读本地数据库里的附件（和 Electron 版一致）。
 * @returns {Promise<string|null>} 失败返回 null
 */
async function readBookText(store, book, keepFormat) {
  if (!book || !book.path) {
    return null;
  }
  if (book.type === 'epub' || book.type === 'mobi') {
    const ids = String(book.path).split(',').filter(Boolean);
    if (!ids.length) {
      return null;
    }
    const parts = [];
    for (const id of ids) {
      const part = store.getAttachment(id);
      if (!part || part.length <= 0) {
        return null;
      }
      parts.push(part);
    }
    return decodeBuffer(Buffer.concat(parts), keepFormat);
  }
  if (!isReadableFile(book.path)) {
    return null;
  }
  const buffer = await readFileAsync(book.path);
  if (!buffer) {
    return null;
  }
  return decodeBuffer(buffer, keepFormat);
}

function isReadableFile(file) {
  try {
    fs.accessSync(file, fs.constants.R_OK);
    return true;
  } catch (err) {
    return false;
  }
}

/** 文件名 → 书名（最多 20 个字，和 Electron 版一致） */
function guessName(filePath) {
  let name = path.basename(filePath).replace(/\.(txt|epub|mobi)$/i, '');
  if (name.length > 20) {
    name = name.substring(0, 20) + '...';
  }
  return name;
}

module.exports = { readBookText, epubInfo, mobiInfo, isReadableFile, guessName, decodeBuffer };
