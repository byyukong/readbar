'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * 和 electron-main.js 里的本地数据库完全同构：
 *   { docs: { [id]: doc }, attachments: { [id]: 文件绝对路径 } }
 * 这样 Electron 版留下的 db.json 可以直接拷过来用。
 */
class Store {
  constructor(rootDir) {
    this.dir = path.join(rootDir, 'readbar-db');
    this.attachDir = path.join(this.dir, 'attachments');
    this.file = path.join(this.dir, 'db.json');
    this.db = { docs: {}, attachments: {} };
    fs.mkdirSync(this.attachDir, { recursive: true });
    this.db = this.read();
  }

  read() {
    if (!fs.existsSync(this.file)) {
      return { docs: {}, attachments: {} };
    }
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!data || !data.docs || !data.attachments) {
        return { docs: {}, attachments: {} };
      }
      return data;
    } catch (err) {
      return { docs: {}, attachments: {} };
    }
  }

  flush() {
    fs.mkdirSync(this.attachDir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.db), 'utf8');
  }

  get(id) {
    const doc = this.db.docs[id];
    return doc ? JSON.parse(JSON.stringify(doc)) : null;
  }

  put(doc) {
    if (!doc || !doc._id) {
      return { ok: false, message: 'doc._id is required' };
    }
    const saved = JSON.parse(JSON.stringify(doc));
    saved._rev = Date.now().toString() + '-' + Math.random().toString(36).slice(2, 8);
    this.db.docs[saved._id] = saved;
    this.flush();
    return { ok: true, id: saved._id, rev: saved._rev };
  }

  remove(id) {
    if (!id) {
      return { ok: false, message: 'id is required' };
    }
    const attachmentFile = this.db.attachments[id];
    if (attachmentFile) {
      try {
        fs.unlinkSync(attachmentFile);
      } catch (err) {
        /* 文件可能已经被删掉了，忽略 */
      }
      delete this.db.attachments[id];
    }
    if (this.db.docs[id]) {
      delete this.db.docs[id];
    }
    this.flush();
    return { ok: true, id };
  }

  attachmentPath(id) {
    const digest = crypto.createHash('sha1').update(id).digest('hex');
    return path.join(this.attachDir, digest + '.bin');
  }

  postAttachment(id, buffer) {
    if (!id || !buffer || !buffer.length) {
      return { ok: false, message: 'id and data are required' };
    }
    const file = this.attachmentPath(id);
    fs.writeFileSync(file, buffer);
    this.db.attachments[id] = file;
    this.flush();
    return { ok: true, id };
  }

  getAttachment(id) {
    const file = this.db.attachments[id];
    if (!file || !fs.existsSync(file)) {
      return null;
    }
    try {
      return fs.readFileSync(file);
    } catch (err) {
      return null;
    }
  }
}

module.exports = Store;
