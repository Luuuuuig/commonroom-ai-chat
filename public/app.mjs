const $ = (id) => document.getElementById(id);
const state = { snapshot: null, room: null, selectedId: null, renderSignature: '', jobsActive: false, timer: null, fetching: false, submitting: false, preparingSubmit: false, authenticated: false, sources: [], toastTimer: null, pendingSubmit: null, sessionEpoch: 0 };
const pendingStorageKey = 'commonroom.pending-submit.v1';
try {
  const pending = JSON.parse(sessionStorage.getItem(pendingStorageKey) || 'null');
  if (pending && typeof pending.requestKey === 'string' && typeof pending.conversationId === 'string' && typeof pending.text === 'string' && ['codex', 'claude'].includes(pending.provider)) state.pendingSubmit = pending;
} catch { /* Storage is optional; current-tab retries still retain their key. */ }
function savePending(value) {
  state.pendingSubmit = value;
  try { if (value) sessionStorage.setItem(pendingStorageKey, JSON.stringify(value)); else sessionStorage.removeItem(pendingStorageKey); } catch { /* Retain the in-memory key when storage is unavailable. */ }
  $('pending-send').hidden = !value;
}
const names = { codex: 'ChatGPT', claude: 'Claude', user: 'You', system: 'System' };
const activeStatuses = new Set(['queued', 'running', 'pending', 'cancelling']);
const retryStatuses = new Set(['failed', 'ambiguous', 'cancelled']);
const roles = { primary: 'Answer', answer: 'Answer', review: 'Peer review', revision: 'Revision' };

function element(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}
function showError(error) {
  if (error?.unauthorized) return;
  $('error-message').textContent = error instanceof Error ? error.message : String(error);
  $('global-error').hidden = false;
}
function showDialogError(dialog, error) {
  let alert = dialog.querySelector('.dialog-error');
  if (!alert) { alert = element('p', 'dialog-error error-text'); alert.setAttribute('role', 'alert'); dialog.querySelector('.dialog-header').after(alert); }
  alert.textContent = error.message || String(error);
}
function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000);
}
function showLogin() {
  state.sessionEpoch += 1;
  state.authenticated = false;
  $('workspace').hidden = true;
  $('login-screen').hidden = false;
  clearTimeout(state.timer);
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
}
async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch {
    if (response.ok) throw new Error('The server response could not be confirmed. Retry the original request.');
    data = { error: 'The server returned an unreadable response.' };
  }
  if (!response.ok) {
    const detail = typeof data.error === 'object' ? (data.error.message || JSON.stringify(data.error)) : data.error;
    const error = new Error(detail || data.message || `Request failed (${response.status}).`);
    error.status = response.status;
    if (response.status === 401) { error.unauthorized = true; showLogin(); }
    throw error;
  }
  return data;
}
function newKey() { return crypto.randomUUID(); }
function getMessages() { return state.room?.messages || []; }
function getJobs() { return state.room?.jobs || []; }
function getContext() { return state.room?.context || {}; }
function setBusy(button, value) { if (button) button.disabled = value; }
function displayTime(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '' : new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date);
}
function escapeSafeHref(value) {
  try { const parsed = new URL(value, location.origin); return ['https:', 'http:'].includes(parsed.protocol) ? parsed.href : null; } catch { return null; }
}
// Text nodes and DOM construction keep provider content inert. Raw HTML is never interpreted.
function appendInline(target, text) {
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^\s)]+\))/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) target.append(document.createTextNode(text.slice(last, match.index)));
    const value = match[0];
    if (value.startsWith('`')) target.append(element('code', '', value.slice(1, -1)));
    else if (value.startsWith('**')) target.append(element('strong', '', value.slice(2, -2)));
    else {
      const parts = value.match(/^\[([^\]]+)\]\((.+)\)$/);
      const href = escapeSafeHref(parts[2]);
      if (href) { const link = element('a', '', parts[1]); link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; target.append(link); }
      else target.append(document.createTextNode(value));
    }
    last = match.index + value.length;
  }
  if (last < text.length) target.append(document.createTextNode(text.slice(last)));
}
function markdown(text) {
  const fragment = document.createDocumentFragment();
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  let paragraph = [], code = null, list = null, quote = null;
  function flushParagraph() { if (paragraph.length) { const p = element('p'); appendInline(p, paragraph.join('\n')); p.style.whiteSpace = 'pre-wrap'; fragment.append(p); paragraph = []; } }
  function breakBlocks() { flushParagraph(); list = null; quote = null; }
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      breakBlocks();
      if (code !== null) { const pre = element('pre'); pre.tabIndex = 0; pre.append(element('code', '', code.join('\n'))); fragment.append(pre); code = null; }
      else code = [];
      continue;
    }
    if (code !== null) { code.push(line); continue; }
    if (!line.trim()) { breakBlocks(); continue; }
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) { breakBlocks(); const h = element('h3'); appendInline(h, heading[1]); fragment.append(h); continue; }
    const bullet = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+)$/);
    if (bullet) {
      flushParagraph(); quote = null;
      const type = /^\s*\d/.test(line) ? 'OL' : 'UL';
      if (!list || list.tagName !== type) { list = element(type.toLowerCase()); fragment.append(list); }
      const li = element('li'); appendInline(li, bullet[1]); list.append(li); continue;
    }
    const quoted = line.match(/^>\s?(.*)$/);
    if (quoted) { flushParagraph(); list = null; if (!quote) { quote = element('blockquote'); fragment.append(quote); } else quote.append(document.createElement('br')); appendInline(quote, quoted[1]); continue; }
    list = null; quote = null; paragraph.push(line);
  }
  flushParagraph();
  if (code !== null) { const pre = element('pre'); pre.tabIndex = 0; pre.append(element('code', '', code.join('\n'))); fragment.append(pre); }
  return fragment;
}
function renderSidebar() {
  const conversations = state.snapshot?.conversations || [];
  $('conversation-count').textContent = conversations.length;
  const list = $('conversation-list'); list.replaceChildren();
  const mobile = $('mobile-conversations'); mobile.replaceChildren();
  if (!conversations.length) { const option = element('option', '', 'Start a conversation'); option.value = ''; mobile.append(option); }
  for (const conversation of conversations) { const option = element('option', '', conversation.title || 'Untitled conversation'); option.value = conversation.id; option.selected = conversation.id === state.selectedId; mobile.append(option); }
  if (!conversations.length) { list.append(element('p', 'nav-empty', 'Your conversations will appear here.')); return; }
  for (const conversation of conversations) {
    const button = element('button', `conversation-item${conversation.id === state.selectedId ? ' active' : ''}`);
    button.type = 'button';
    if (conversation.id === state.selectedId) button.setAttribute('aria-current', 'page');
    button.append(element('span', 'chat-symbol', '◧'), element('span', '', conversation.title || 'Untitled conversation'));
    button.title = conversation.title || 'Untitled conversation';
    button.addEventListener('click', () => selectConversation(conversation.id).catch(showError));
    list.append(button);
  }
}
function renderMode() {
  const mode = state.snapshot?.mode;
  const banner = $('mode-banner'); banner.classList.toggle('live', mode === 'subscription');
  banner.replaceChildren(element('span', 'banner-label', mode === 'subscription' ? 'SUBSCRIPTION' : 'DEMO'), element('span', '', mode === 'subscription' ? (state.snapshot.liveIntegrationVerified ? 'Subscription providers verified. Separately billed model APIs disabled.' : 'Subscription mode. Live integration unverified. Separately billed model APIs disabled.') : 'Mock responses only. No AI providers connected.'));
}
function connectionStatus(status) {
  const raw = String(status || 'unverified');
  return raw.replace(/[_-]/g, ' ');
}
function renderConnections() {
  const connections = state.snapshot?.connections || [];
  const list = $('connection-list'); list.replaceChildren();
  if (!connections.length) list.append(element('p', 'dialog-description', 'No provider connections reported by the server.'));
  for (const connection of connections) {
    const id = connection.id || connection.provider;
    const card = element('div', 'connection-card');
    const avatar = element('span', `avatar ${id === 'claude' ? 'claude' : 'codex'}`, id === 'claude' ? 'C' : 'O'); avatar.setAttribute('aria-hidden', 'true');
    const main = element('div', 'connection-main');
    const heading = element('div', 'connection-heading');
    heading.append(element('span', '', connection.name || names[id] || id || 'Provider'));
    const status = element('span', `connection-status${['connected', 'ready'].includes(connection.status) && state.snapshot?.mode === 'subscription' ? ' connected' : ''}`, connectionStatus(connection.status));
    heading.append(status); main.append(heading);
    main.append(element('p', 'connection-detail', typeof connection.detail === 'string' ? connection.detail : JSON.stringify(connection.detail || 'Connection has not been verified.')));
    card.append(avatar, main); list.append(card);
  }
}
function actionButton(text, callback) {
  const button = element('button', 'message-action', text); button.type = 'button';
  button.addEventListener('click', async () => { setBusy(button, true); try { await callback(); } catch (error) { showError(error); } finally { setBusy(button, false); } });
  return button;
}
function renderMessages() {
  const messages = getMessages(); const jobs = getJobs();
  const signature = JSON.stringify([state.selectedId, messages, jobs]);
  if (signature === state.renderSignature) return;
  state.renderSignature = signature;
  const scroll = $('message-scroll'); const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120;
  const list = $('messages'); list.replaceChildren();
  $('empty-state').hidden = messages.length > 0 || jobs.length > 0;
  for (const message of messages) {
    const isUser = message.role === 'user' || message.provider === 'user' || message.kind === 'user';
    const provider = isUser ? 'user' : (message.provider || message.sender || 'system');
    const kind = message.kind || (message.role === 'assistant' ? 'primary' : message.role);
    const article = element('article', 'message'); article.id = `message-${message.id}`;
    const avatar = element('div', `avatar ${provider}`, isUser ? 'Y' : provider === 'claude' ? 'C' : 'O'); avatar.setAttribute('aria-hidden', 'true');
    const main = element('div', 'message-main'); const topline = element('div', 'message-topline');
    topline.append(element('span', 'message-name', names[provider] || String(provider)));
    if (!isUser) topline.append(element('span', `message-role ${kind}`, roles[kind] || 'Response'));
    if (message.providerMode === 'mock') topline.append(element('span', 'message-role', 'Demo'));
    const time = element('time', 'message-time', displayTime(message.createdAt || message.timestamp));
    if (message.createdAt || message.timestamp) time.dateTime = message.createdAt || message.timestamp;
    topline.append(time); main.append(topline);
    const body = message.text ?? message.body ?? message.content ?? '';
    const content = element('div', 'message-content'); content.append(markdown(typeof body === 'string' ? body : JSON.stringify(body, null, 2))); main.append(content);
    if (!isUser && message.id) {
      const footer = element('div', 'message-footer');
      footer.append(actionButton('Copy', async () => { await navigator.clipboard.writeText(String(body)); toast('Copied to clipboard.'); }));
      if (['primary', 'answer', 'revision'].includes(kind) && ['codex', 'claude'].includes(provider)) {
        const hasReview = messages.some((other) => other.kind === 'review' && other.replyTo === message.id);
        if (!hasReview) footer.append(actionButton('Request peer review', async () => { await api(`/api/messages/${encodeURIComponent(message.id)}/review`, { method: 'POST', body: { requestKey: newKey() } }); await refresh(); }));
      }
      main.append(footer);
    }
    const contextVersion = message.contextVersion ?? message.metadata?.contextVersion;
    if (contextVersion !== undefined) main.append(element('div', 'message-meta', `Shared context v${contextVersion}`));
    article.append(avatar, main); list.append(article);
  }
  renderJobs(jobs);
  if (nearBottom || messages.length === 1) requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
}
function renderJobs(jobs) {
  const container = $('jobs'); container.replaceChildren();
  for (const job of jobs.filter((j) => activeStatuses.has(j.status) || retryStatuses.has(j.status) || j.status === 'cancelled')) {
    const failed = retryStatuses.has(job.status);
    const card = element('div', `job-card${failed ? ' error' : ''}`);
    if (activeStatuses.has(job.status)) { const spinner = element('span', 'job-spinner'); spinner.setAttribute('aria-hidden', 'true'); card.append(spinner); }
    const info = element('div', 'job-info');
    const stage = roles[job.stage] || roles[job.kind] || job.stage || 'Response';
    info.append(element('strong', '', `${names[job.provider || (job.stage === 'review' ? job.reviewProvider : job.primaryProvider)] || 'Assistant'} · ${stage} · ${connectionStatus(job.status)}`));
    const detail = typeof job.error === 'string' ? job.error : job.error?.message || job.error?.code || job.detail;
    if (detail) info.append(element('span', 'job-detail', typeof detail === 'string' ? detail : JSON.stringify(detail)));
    else if (job.status === 'ambiguous') info.append(element('span', 'job-detail', 'The outcome is unknown. Check the provider before retrying to avoid a duplicate request.'));
    else if (job.status === 'cancelled') info.append(element('span', 'job-detail', 'This request was stopped.'));
    card.append(info);
    if (activeStatuses.has(job.status)) {
      const button = actionButton('Stop', async () => { await api(`/api/jobs/${encodeURIComponent(job.id)}/cancel`, { method: 'POST', body: {} }); await refresh(); }); button.className = 'job-action'; card.append(button);
    } else if (failed) {
      const button = actionButton('Retry', async () => {
        const ambiguous = job.status === 'ambiguous' || Boolean(job.error?.ambiguous);
        if (ambiguous && !window.confirm('The provider may already have handled this request. Retrying can create a duplicate response. Retry anyway?')) return;
        await api(`/api/jobs/${encodeURIComponent(job.id)}/retry`, { method: 'POST', body: { requestKey: newKey(), confirmAmbiguous: ambiguous } }); await refresh();
      }); button.className = 'job-action'; card.append(button);
    }
    container.append(card);
  }
}
function renderRoom() {
  $('conversation-title').textContent = state.room?.conversation?.title || 'Start a conversation';
  const context = getContext();
  const sourceCount = (context.sources || []).length;
  $('context-count').textContent = sourceCount + (String(context.text || '').trim() ? 1 : 0);
  $('context-button').disabled = !state.selectedId;
  $('export-button').disabled = !state.selectedId;
  state.jobsActive = getJobs().some((job) => activeStatuses.has(job.status));
  renderMessages();
}
async function selectConversation(id) {
  if (id === state.selectedId && state.room) return;
  const epoch = state.sessionEpoch;
  const room = await api(`/api/conversations/${encodeURIComponent(id)}`);
  if (epoch !== state.sessionEpoch) return;
  state.selectedId = id; state.room = room; state.renderSignature = '';
  renderSidebar(); renderRoom();
  requestAnimationFrame(() => { $('message-scroll').scrollTop = $('message-scroll').scrollHeight; });
}
async function refresh({ initial = false } = {}) {
  if (state.fetching) return;
  state.fetching = true;
  const epoch = state.sessionEpoch;
  clearTimeout(state.timer);
  try {
    const snapshot = await api('/api/state');
    if (epoch !== state.sessionEpoch) return;
    state.snapshot = snapshot; state.authenticated = true;
    $('login-screen').hidden = true; $('workspace').hidden = false; $('pending-send').hidden = !state.pendingSubmit;
    const conversations = snapshot.conversations || [];
    if (state.selectedId && !conversations.some((room) => room.id === state.selectedId)) { state.selectedId = null; state.room = null; state.renderSignature = ''; }
    if (!state.selectedId && conversations.length) state.selectedId = conversations[0].id;
    const currentId = state.selectedId;
    if (currentId) { const room = await api(`/api/conversations/${encodeURIComponent(currentId)}`); if (epoch !== state.sessionEpoch) return; if (state.selectedId === currentId) state.room = room; }
    renderMode(); renderSidebar(); renderConnections(); renderRoom();
    if (initial) $('compose').focus({ preventScroll: true });
  } catch (error) {
    showError(error);
    if (!state.authenticated && !error.unauthorized) { showLogin(); $('login-error').textContent = `Workspace unavailable: ${error.message}`; }
  }
  finally {
    state.fetching = false;
    if (state.authenticated) state.timer = setTimeout(() => refresh(), state.jobsActive ? 1500 : 5000);
  }
}
function updateRouteHint() {
  const provider = $('provider').value;
  const peer = provider === 'codex' ? 'claude' : 'codex';
  $('route-hint').textContent = `${names[provider]} answers.${$('auto-review').checked ? ` ${names[peer]} reviews.${$('auto-revision').checked ? ` ${names[provider]} revises.` : ''}` : ''}`;
  $('auto-revision').disabled = !$('auto-review').checked;
}
function renderSources() {
  const list = $('context-sources'); list.replaceChildren();
  for (const [index, source] of state.sources.entries()) {
    const row = element('li'); row.append(element('span', 'source-name', typeof source === 'string' ? source : source.name || source.filename || source.title || source.id || `Source ${index + 1}`));
    const body = source.text ?? source.content;
    if (typeof body === 'string') row.append(element('span', 'source-meta', `${body.length.toLocaleString()} characters`));
    const remove = element('button', '', '×'); remove.type = 'button'; remove.setAttribute('aria-label', `Remove ${source.name || `source ${index + 1}`}`);
    remove.addEventListener('click', () => { state.sources.splice(index, 1); renderSources(); }); row.append(remove); list.append(row);
  }
}
async function openContext() {
  if (!state.selectedId) return;
  const context = getContext();
  $('context-text').value = context.text || '';
  $('context-version').textContent = `Version ${context.version ?? 0}`;
  state.sources = structuredClone(context.sources || []);
  $('context-file').value = '';
  renderSources(); $('context-dialog').querySelector('.dialog-error')?.remove(); $('context-dialog').showModal();
}
async function createConversation(title) {
  const epoch = state.sessionEpoch;
  const result = await api('/api/conversations', { method: 'POST', body: { title } });
  if (epoch !== state.sessionEpoch) throw new Error('Workspace sign-in changed. Sign in again before sending.');
  const conversation = result.conversation || result;
  if (!conversation.id) throw new Error('The server created no identifiable conversation. Refresh and try again.');
  state.selectedId = conversation.id; state.room = null; state.renderSignature = '';
  await refresh();
  return conversation.id;
}
function download(data, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = element('a'); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = event.submitter; setBusy(button, true); $('login-error').textContent = '';
  try { await api('/api/login', { method: 'POST', body: { password: $('password').value } }); $('password').value = ''; await refresh({ initial: true }); }
  catch (error) { $('login-error').textContent = error.message; }
  finally { setBusy(button, false); }
});
$('dismiss-error').addEventListener('click', () => { $('global-error').hidden = true; });
$('new-chat').addEventListener('click', () => { $('new-chat-name').value = ''; $('new-chat-dialog').showModal(); });
$('new-chat-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const title = $('new-chat-name').value.trim(); if (!title) return;
  const button = event.submitter; setBusy(button, true);
  try { await createConversation(title); $('new-chat-dialog').close(); $('compose').focus(); }
  catch (error) { $('new-chat-dialog').close(); showError(error); }
  finally { setBusy(button, false); }
});
async function sendPendingRequest() {
  if (state.submitting || !state.pendingSubmit) return;
  const payload = state.pendingSubmit;
  state.submitting = true; setBusy($('send-button'), true); setBusy($('retry-send'), true);
  try {
    await api('/api/submit', { method: 'POST', body: payload });
    savePending(null);
    if (state.selectedId === payload.conversationId && $('compose').value.trim() === payload.text) { $('compose').value = ''; $('compose').style.height = ''; }
    $('provider').value = payload.provider; updateRouteHint(); await refresh();
    requestAnimationFrame(() => { $('message-scroll').scrollTop = $('message-scroll').scrollHeight; });
  } catch (error) {
    if (error.status >= 400 && error.status < 500 && error.status !== 401) { savePending(null); showError(error); }
    else if (!error.unauthorized) showError(new Error(`Delivery is unconfirmed. Use “Retry original” to send the same request ID without creating duplicate work. ${error.message}`));
  } finally { state.submitting = false; setBusy($('send-button'), false); setBusy($('retry-send'), false); $('compose').focus({ preventScroll: true }); }
}
$('compose-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (state.submitting || state.preparingSubmit) return;
  const text = $('compose').value.trim(); if (!text) return;
  let provider = $('provider').value;
  const mention = text.match(/^@(codex|chatgpt|claude)\b/i);
  if (mention) provider = mention[1].toLowerCase() === 'claude' ? 'claude' : 'codex';
  const choices = { text, provider, autoReview: $('auto-review').checked, autoRevision: $('auto-review').checked && $('auto-revision').checked };
  if (state.pendingSubmit) {
    const pending = state.pendingSubmit;
    if (pending.conversationId !== state.selectedId || Object.entries(choices).some(([key, value]) => pending[key] !== value)) {
      showError(new Error('Resolve the unconfirmed send with “Retry original” or “Clear pending” before sending a changed request. Your draft is preserved.'));
      return;
    }
    await sendPendingRequest(); return;
  }
  state.preparingSubmit = true; setBusy($('send-button'), true);
  try {
    if (!state.selectedId) await createConversation(text.replace(/^@(codex|chatgpt|claude)\s+/i, '').slice(0, 65) || 'New conversation');
    savePending({ conversationId: state.selectedId, ...choices, requestKey: newKey() });
    await sendPendingRequest();
  } catch (error) { showError(error); }
  finally { state.preparingSubmit = false; setBusy($('send-button'), false); }
});
$('retry-send').addEventListener('click', () => sendPendingRequest());
$('discard-send').addEventListener('click', () => {
  if (state.submitting) return;
  if (window.confirm('The original request may already have been accepted. Clear its retry record? Check the conversation before sending it as a new request.')) savePending(null);
});
$('compose').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('compose-form').requestSubmit(); } });
$('compose').addEventListener('input', () => { $('compose').style.height = 'auto'; $('compose').style.height = `${Math.min($('compose').scrollHeight, 190)}px`; const mention = $('compose').value.match(/^@(codex|chatgpt|claude)\b/i); if (mention) { $('provider').value = mention[1].toLowerCase() === 'claude' ? 'claude' : 'codex'; updateRouteHint(); } });
for (const id of ['provider', 'auto-review', 'auto-revision']) $(id).addEventListener('change', updateRouteHint);
$('mobile-conversations').addEventListener('change', () => { if ($('mobile-conversations').value) selectConversation($('mobile-conversations').value).catch(showError); });
$('logout-button').addEventListener('click', async () => { try { await api('/api/logout', { method: 'POST', body: {} }); showLogin(); state.room = null; state.snapshot = null; state.selectedId = null; state.renderSignature = ''; state.sources = []; savePending(null); $('compose').value = ''; $('context-text').value = ''; $('context-sources').replaceChildren(); $('preview-content').textContent = ''; $('messages').replaceChildren(); $('jobs').replaceChildren(); $('conversation-list').replaceChildren(); $('mobile-conversations').replaceChildren(); $('connection-list').replaceChildren(); $('conversation-title').textContent = 'Start a conversation'; $('new-chat-name').value = ''; $('error-message').textContent = ''; $('global-error').hidden = true; $('login-error').textContent = ''; $('toast').hidden = true; } catch (error) { showError(error); } });
$('connections-button').addEventListener('click', () => { renderConnections(); $('connections-dialog').showModal(); });
$('context-button').addEventListener('click', () => openContext().catch(showError));
$('context-file').addEventListener('change', async () => {
  try {
    for (const file of $('context-file').files) {
      if (!/\.(txt|md|markdown)$/i.test(file.name)) throw new Error('Choose a .txt, .md, or .markdown file.');
      if (file.size > 12000) throw new Error(`${file.name} is too large. Attachments and their references share a 12,000-character limit. Paste longer text into project notes.`);
      const source = { id: newKey(), name: file.name, text: await file.text() };
      if (JSON.stringify([...state.sources, source]).length > 12000) throw new Error('These attachments exceed the shared 12,000-character limit. Remove a file or paste selected text into project notes.');
      if (state.sources.length >= 50) throw new Error('You can include up to 50 source references.');
      state.sources.push(source);
    }
    renderSources();
  } catch (error) { showDialogError($('context-dialog'), error); }
  finally { $('context-file').value = ''; }
});
$('context-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = event.submitter; setBusy(button, true);
  try {
    await api(`/api/conversations/${encodeURIComponent(state.selectedId)}/context`, { method: 'PUT', body: { text: $('context-text').value, sources: state.sources } });
    $('context-dialog').close(); await refresh(); toast('Shared context saved.');
  } catch (error) { showDialogError($('context-dialog'), error); }
  finally { setBusy(button, false); }
});
$('preview-button').addEventListener('click', async () => {
  const button = $('preview-button'); setBusy(button, true);
  try {
    if (!state.selectedId) throw new Error('Create a conversation first, then inspect its shared prompt.');
    const result = await api('/api/context-preview', { method: 'POST', body: { conversationId: state.selectedId, text: $('compose').value } });
    $('preview-content').textContent = JSON.stringify(result, null, 2); $('preview-dialog').showModal();
    document.querySelector('.more-options').open = false;
  } catch (error) { showError(error); }
  finally { setBusy(button, false); }
});
$('export-button').addEventListener('click', async () => {
  if (!state.selectedId) return;
  setBusy($('export-button'), true);
  try { const result = await api(`/api/conversations/${encodeURIComponent(state.selectedId)}/export`); const name = (state.room?.conversation?.title || 'conversation').replace(/[^a-z0-9_-]/gi, '_').slice(0, 65); download(result, `${name}.json`); }
  catch (error) { showError(error); }
  finally { setBusy($('export-button'), false); }
});
$('import-button').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async () => {
  const file = $('import-file').files[0]; if (!file) return;
  try {
    if (file.size > 10000000) throw new Error('Choose a conversation export smaller than 10 MB.');
    let data; try { data = JSON.parse(await file.text()); } catch { throw new Error('The selected file is not valid JSON. Choose a conversation export.'); }
    const result = await api('/api/import', { method: 'POST', body: { data } });
    state.selectedId = result.conversation?.id || result.id || result.conversationId || state.selectedId;
    state.renderSignature = ''; await refresh(); toast('Conversation imported.');
  } catch (error) { showError(error); }
  finally { $('import-file').value = ''; }
});
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => button.closest('dialog').close());
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', (event) => { if (event.target === dialog) { const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close(); } });
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.authenticated) refresh(); });
updateRouteHint();
refresh({ initial: true });
