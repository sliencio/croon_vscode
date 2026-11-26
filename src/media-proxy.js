const http = require('node:http');
const { createHash, randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { CoverCache, coverType, maxCoverSize } = require('./cover-cache');

function cacheKey(values) {
  return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}

class MediaProxy {
  constructor(cacheDirectory) {
    this.coverCache = new CoverCache(cacheDirectory);
  }

  async start() {
    this.server = http.createServer((request, response) => {
      void this.serve(request, response);
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    this.host = `127.0.0.1:${this.server.address().port}`;
    this.origin = `http://${this.host}`;
  }

  source(api, chapterId, transcode, offset, onDuration) {
    this.clear();
    const path = '/audio/' + randomUUID();
    this.current = { path, api, chapterId, transcode, offset, onDuration, abort: new AbortController() };
    return this.origin + path;
  }

  clear() {
    this.current?.abort.abort();
    this.current = undefined;
  }

  setCovers(api, items) {
    if (this.covers?.api !== api) {
      this.clearCovers();
      this.covers = {
        api, prefix: '/cover/' + randomUUID() + '/', paths: new Map(),
        accountKey: cacheKey([api.address, api.userId || api.token]),
        pending: new Map(), abort: new AbortController(),
      };
    }
    const { prefix, paths } = this.covers;
    return items.map(({ coverPath, libraryId, ...item }) => {
      if (typeof coverPath !== 'string' || !coverPath.trim()) return item;
      const key = cacheKey([api.address, api.userId || api.token, item.id, coverPath]);
      const path = prefix + key;
      paths.set(path, { key, id: item.id, libraryId: libraryId || paths.get(path)?.libraryId, coverPath });
      return { ...item, cover: this.origin + path };
    });
  }

  clearCovers() {
    this.covers?.abort.abort();
    this.covers = undefined;
  }

  async invalidateCovers(api) {
    await this.coverCache.invalidate(cacheKey([api.address, api.userId || api.token]));
    this.clearCovers();
  }

  dispose() {
    this.clear();
    this.clearCovers();
    this.server?.close();
    this.server?.closeAllConnections();
  }

  async serve(request, response) {
    if (request.method !== 'GET' || request.headers.host !== this.host) {
      response.writeHead(404).end();
      return;
    }
    const cover = this.covers?.paths.get(request.url);
    if (cover) {
      await this.serveCover(response, this.covers, cover);
      return;
    }
    const stream = this.current;
    if (!stream || request.url !== stream.path) {
      response.writeHead(404).end();
      return;
    }

    const disconnected = new AbortController();
    response.once('close', () => disconnected.abort());
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, stream.abort.signal, disconnected.signal]);
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const upstream = await stream.api.stream(
        stream.chapterId, stream.transcode, stream.offset, request.headers.range, signal,
      );
      clearTimeout(timeout);
      const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
      if (upstream.status === 416) {
        const contentRange = upstream.headers.get('content-range');
        if (contentRange) headers['content-range'] = contentRange;
        response.writeHead(416, headers).end();
        await upstream.body?.cancel();
        return;
      }
      const type = upstream.headers.get('content-type') || '';
      if (!upstream.ok || !upstream.body || !/^(audio\/|video\/(mp4|ogg)|application\/(octet-stream|ogg))/i.test(type)) {
        response.writeHead(upstream.ok ? 502 : upstream.status, headers).end();
        await upstream.body?.cancel();
        return;
      }
      headers['content-type'] = type;
      const duration = Number(upstream.headers.get('x-audio-duration'));
      if (stream === this.current && Number.isFinite(duration) && duration > 0) {
        stream.onDuration(duration);
      }
      if (!upstream.headers.has('content-encoding')) {
        for (const name of ['content-length', 'content-range', 'accept-ranges']) {
          const value = upstream.headers.get(name);
          if (value) headers[name] = value;
        }
      }
      response.writeHead(upstream.status, headers);
      await pipeline(Readable.fromWeb(upstream.body), response, { signal });
    } catch {
      if (response.destroyed) return;
      if (response.headersSent) response.destroy();
      else response.writeHead(502).end();
    } finally {
      clearTimeout(timeout);
    }
  }

  async serveCover(response, catalog, cover) {
    try {
      let pending = catalog.pending.get(cover.key);
      if (!pending) {
        pending = this.loadCover(catalog, cover).finally(() => catalog.pending.delete(cover.key));
        catalog.pending.set(cover.key, pending);
      }
      const image = await pending;
      if (response.destroyed || catalog.abort.signal.aborted) {
        response.destroy();
        return;
      }
      if (!image) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        'content-type': image.type,
        'content-length': image.body.length,
        'cache-control': 'private, max-age=300',
        'x-content-type-options': 'nosniff',
      }).end(image.body);
    } catch {
      if (response.destroyed) return;
      response.writeHead(502).end();
    }
  }

  async loadCover(catalog, cover) {
    const revision = await this.coverCache.revision(catalog.accountKey).catch(() => undefined);
    const cached = revision === undefined ? undefined : await this.coverCache.read(cover.key, revision);
    if (cached) return cached;

    const signal = AbortSignal.any([catalog.abort.signal, AbortSignal.timeout(12000)]);
    const upstream = await catalog.api.cover(cover.id, cover.libraryId, cover.coverPath, signal);
    const type = upstream.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    const length = Number(upstream.headers.get('content-length'));
    if (!upstream.ok || !upstream.body || length > maxCoverSize || !coverType.test(type || '')) {
      await upstream.body?.cancel();
      return;
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of upstream.body) {
      bytes += chunk.length;
      if (bytes > maxCoverSize) return;
      chunks.push(chunk);
    }
    if (!bytes || signal.aborted) return;
    const image = { type, body: Buffer.concat(chunks, bytes) };
    if (revision !== undefined && revision === await this.coverCache.revision(catalog.accountKey).catch(() => undefined)) {
      await this.coverCache.write(cover.key, revision, image);
    }
    return image;
  }
}

module.exports = { MediaProxy };
