import { outdatedHint, readMobileAuth, refreshMobileAuth } from './mobile-auth.js';

const origin = 'https://portal.skoleplattform.no';

export class MobileClient {
  #auth;
  #refreshing;

  async open() {
    if (this.#auth) return;
    try { this.#auth = await readMobileAuth(); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error('Not signed in to Skolemelding. Run npm run login first.');
      throw error;
    }
  }

  async #refresh() {
    if (!this.#refreshing) {
      this.#refreshing = refreshMobileAuth(this.#auth).then((auth) => { this.#auth = auth; })
        .catch((error) => {
          if ([400, 401, 403].includes(error.httpStatus)) {
            throw new Error(`Skolemelding sign-in has expired or was rejected. Run npm run login again. ${outdatedHint}`);
          }
          throw error;
        })
        .finally(() => { this.#refreshing = undefined; });
    }
    await this.#refreshing;
  }

  async #request(path, options = {}) {
    await this.open();
    if (Date.now() >= this.#auth.expiresAt - 60_000) await this.#refresh();
    const send = async () => {
      try {
        return await fetch(new URL(path, origin), {
          ...options,
          headers: { ...options.headers, Authorization: `Bearer ${this.#auth.accessToken}` },
          redirect: 'manual', signal: AbortSignal.timeout(30_000),
        });
      } catch { throw new Error('Could not connect to Skolemelding. Check network access and retry.'); }
    };
    const sentWith = this.#auth.accessToken;
    let response = await send();
    if (response.status === 401) {
      // Another request may already have replaced the token; only refresh if this one used the current token.
      if (this.#auth.accessToken === sentWith) await this.#refresh();
      response = await send();
    }
    if (!response.ok) throw new Error(`Skolemelding request failed (HTTP ${response.status}).`);
    return response;
  }

  async searchPage(page, pageSize) {
    const response = await this.#request('/api/messagesearchmobile/', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        Page: page, PageSize: pageSize, SearchTerm: '', SearchInbox: true,
        FilterSender: null, FilterUnreadMessages: false, FilterFeedbackRequired: false,
        FilterFeedbackIsQuestion: false, FilterIsAbsentMessage: false,
        OnBehalfOf: '', AuthorUserCategory: null, FilterFavouriteMessages: false,
        SendHiddenMessages: false,
      }),
    });
    const payload = await response.json();
    if (!Array.isArray(payload.Result)) throw new Error('Unexpected mobile message response format.');
    return payload;
  }

  async getChildren() {
    const response = await this.#request('/api/MyProfile/GetChildInfo', { method: 'GET', headers: { Accept: 'application/json' } });
    const payload = await response.json();
    return Array.isArray(payload?.ParentChildOptions) ? payload.ParentChildOptions : [];
  }

  async getAttachment(url) {
    const response = await this.#request(url, { method: 'GET' });
    const mimeType = response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
    if (mimeType === 'text/html') throw new Error('Attachment request returned a sign-in page.');
    const declaredSize = Number(response.headers.get('content-length'));
    if (declaredSize > 10_000_000) throw new Error('Attachment exceeds the 10 MB response limit.');
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body || []) {
      size += chunk.byteLength;
      if (size > 10_000_000) {
        await response.body.cancel().catch(() => {});
        throw new Error('Attachment exceeds the 10 MB response limit.');
      }
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks, size);
    return { bytes, mimeType };
  }
}
