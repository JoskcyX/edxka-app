// Tiny fetch wrapper + auth-token helpers shared by every page.
const API = {
  base: '', // same origin as the server

  token() {
    return localStorage.getItem('edxka_token');
  },
  setToken(t) {
    if (t) localStorage.setItem('edxka_token', t);
    else localStorage.removeItem('edxka_token');
  },
  setUser(u) {
    if (u) localStorage.setItem('edxka_user', JSON.stringify(u));
    else localStorage.removeItem('edxka_user');
  },
  user() {
    try { return JSON.parse(localStorage.getItem('edxka_user') || 'null'); }
    catch { return null; }
  },
  signOut() {
    this.setToken(null);
    this.setUser(null);
    window.location.href = '/signin.html';
  },
  requireAuth() {
    if (!this.token()) window.location.href = '/signin.html';
  },

  async request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    const token = this.token();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(this.base + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const err = new Error(data.error || 'Something went wrong. Please try again.');
      err.status = res.status;
      throw err;
    }
    return data;
  },

  get(path) { return this.request('GET', path); },
  post(path, body) { return this.request('POST', path, body); },
  put(path, body) { return this.request('PUT', path, body); },
  del(path) { return this.request('DELETE', path); },
};

function showError(el, message) {
  el.textContent = message;
  el.classList.remove('hidden');
}
function hideError(el) {
  el.classList.add('hidden');
  el.textContent = '';
}
