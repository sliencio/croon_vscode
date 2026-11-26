const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const maxCoverSize = 10 * 1024 * 1024;
const coverType = /^image\/(avif|bmp|gif|jpeg|png|webp)$/;

class CoverCache {
  constructor(directory) {
    this.directory = directory;
  }

  async revision(accountKey) {
    try {
      return await fs.readFile(path.join(this.directory, accountKey + '.revision'), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return '';
      throw error;
    }
  }

  async invalidate(accountKey) {
    await this.replace(accountKey + '.revision', randomUUID());
  }

  async read(key, revision) {
    const file = path.join(this.directory, key + '.cover');
    try {
      const stat = await fs.stat(file);
      if (stat.size > maxCoverSize + 128) return;
      const entry = await fs.readFile(file);
      const separator = entry.indexOf(10);
      if (separator < 0 || separator > 127 || separator + 1 >= entry.length) return;
      const [type, savedRevision = ''] = entry.toString('ascii', 0, separator).split(' ');
      if (savedRevision === revision && coverType.test(type)) {
        return { type, body: entry.subarray(separator + 1) };
      }
    } catch {
      // 缓存不可用时按未命中处理。
    }
  }

  async write(key, revision, { type, body }) {
    const header = Buffer.from(type + (revision ? ' ' + revision : '') + '\n');
    try {
      await this.replace(key + '.cover', Buffer.concat([header, body]));
    } catch {
      // 无法写入磁盘时仍可显示本次获取的封面。
    }
  }

  async replace(name, contents) {
    const file = path.join(this.directory, name);
    const temporary = path.join(this.directory, name + '.' + randomUUID() + '.tmp');
    await fs.mkdir(this.directory, { recursive: true });
    try {
      await fs.writeFile(temporary, contents);
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }
}

module.exports = { CoverCache, coverType, maxCoverSize };