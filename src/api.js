class ApiError extends Error {
  constructor(status) {
    super({
      401: '登录信息无效或已过期，请重新登录。',
      403: '当前账号没有访问权限。',
      404: '服务端找不到请求的内容，请检查服务器地址或刷新书库。',
      429: '请求过于频繁，请稍后重试。',
    }[status] || `Croon 服务端返回 HTTP ${status}。`);
    this.status = status;
  }
}

function serverAddress(value) {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.search || url.hash) {
    throw new Error('请输入 HTTP 或 HTTPS 服务地址，可包含反向代理路径。');
  }
  return url.href.replace(/\/+$/, '');
}

function segment(value) {
  return encodeURIComponent(value);
}

class CroonApi {
  constructor(address, token, userId) {
    this.address = serverAddress(address);
    this.token = token;
    this.userId = userId;
  }

  async json(path, { body, notFound } = {}) {
    const headers = { accept: 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';

    let response;
    try {
      response = await fetch(this.address + path, {
        method: body === undefined ? 'GET' : 'POST',
        body: body === undefined ? undefined : JSON.stringify(body),
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new Error('无法连接 Croon，请检查地址、网络或 HTTPS 证书后重试。');
    }

    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404 && notFound) return null;
      throw new ApiError(response.status);
    }
    try {
      return await response.json();
    } catch {
      throw new Error('服务器未返回有效的 Croon 数据，请检查服务地址。');
    }
  }

  async signIn(username, password) {
    const result = await this.json('/api/auth/login', { body: { username, password } });
    if (!result?.user?.id || typeof result.token !== 'string' || !result.token) {
      throw new Error('服务端未返回有效的登录会话。');
    }
    return { address: this.address, token: result.token, userId: result.user.id };
  }

  libraries() {
    return this.json('/api/libraries');
  }

  books(libraryId) {
    const query = libraryId ? '?' + new URLSearchParams({ library_id: libraryId }) : '';
    return this.json('/api/v1/books' + query);
  }

  book(id) {
    return this.json('/api/v1/books/' + segment(id));
  }

  async chapters(bookId) {
    const chapters = await this.json('/api/v1/books/' + segment(bookId) + '/chapters');
    return chapters.sort((a, b) => Number(Boolean(a.is_extra)) - Number(Boolean(b.is_extra))
      || a.chapter_index - b.chapter_index);
  }

  recent() {
    return this.json('/api/progress/recent');
  }

  async serverVersion() {
    const health = await this.json('/api/health');
    return typeof health?.version === 'string' ? health.version.trim() : '';
  }

  progress(bookId) {
    return this.json('/api/progress/' + segment(bookId), { notFound: true });
  }

  saveProgress(body) {
    return this.json('/api/progress', { body });
  }

  cover(bookId, libraryId, path, signal) {
    const query = new URLSearchParams({ path, book_id: bookId });
    if (libraryId) query.set('library_id', libraryId);
    return fetch(this.address + '/api/proxy/cover?' + query, {
      headers: { authorization: `Bearer ${this.token}` },
      redirect: 'error',
      signal,
    });
  }

  stream(chapterId, transcode, offset, range, signal) {
    const query = new URLSearchParams();
    if (transcode) {
      query.set('transcode', 'mp3');
      if (offset > 0) query.set('seek', offset.toFixed(3));
    }
    const headers = { authorization: `Bearer ${this.token}`, 'accept-encoding': 'identity' };
    if (range && !transcode) headers.range = range;
    const suffix = query.size ? '?' + query : '';
    return fetch(this.address + '/api/stream/' + segment(chapterId) + suffix, { headers, signal });
  }
}

module.exports = { CroonApi, serverAddress };
