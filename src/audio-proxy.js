const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

class AudioProxy {
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

  dispose() {
    this.clear();
    this.server?.close();
    this.server?.closeAllConnections();
  }

  async serve(request, response) {
    const stream = this.current;
    if (request.method !== 'GET' || !stream || request.url !== stream.path
        || request.headers.host !== this.host) {
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
}

module.exports = { AudioProxy };
