import { randomUUID, createHash } from 'node:crypto';
import { Store } from './store.mjs';
import { AppError, assembleContext, stringInput, booleanInput, providerInput, route, validateSources, MAX_MESSAGE_CHARS, MAX_CONTEXT_CHARS } from './context.mjs';

const now = () => new Date().toISOString();
const parse = (value, fallback = null) => value ? JSON.parse(value) : fallback;
const opposite = provider => provider === 'codex' ? 'claude' : 'codex';
const safeErrors = {
  AUTH_REQUIRED: 'Provider sign-in is required. Complete the supported provider login, then retry.',
  QUOTA_EXHAUSTED: 'The subscription usage limit was reached. Wait for renewal or check your plan, then retry. Paid APIs remain disabled.',
  RATE_LIMITED: 'The provider rate limit was reached. Wait before deliberately retrying.',
  TIMEOUT: 'The provider did not complete in time. Check the provider state before deliberately retrying.',
  ABORTED: 'The provider run was stopped. A submitted provider request may still have consumed subscription usage.',
  CONFIGURATION_ERROR: 'The provider connection is not configured. Check connection details and supported sign-in.',
  POLICY_UNVERIFIED: 'The subscription integration route has not passed eligibility and account verification. Live OpenAI execution remains blocked; no paid API fallback is enabled.',
  PROVIDER_UNAVAILABLE: 'The supported provider client is unavailable or its preflight checks failed. Check the installed client and connection status before retrying.',
  PROVIDER_FAILED: 'The provider did not return a complete successful result. Check connection status before retrying. Raw provider output was not logged.',
  BILLING_ROUTE_BLOCKED: 'The provider did not confirm a subscription or clearly labelled mock billing route. The result was blocked. Paid APIs remain disabled.',
  INVALID_PROVIDER_RESULT: 'The provider returned an invalid or empty result. Check the connection before retrying.',
  PROVIDER_ERROR: 'The provider run failed. Check connection status before retrying. Raw provider output was not logged.',
  RESTART_AMBIGUOUS: 'The worker restarted during a provider call. This stage may have reached the provider. Check its state and deliberately confirm a retry to avoid duplicate usage.',
};
function safeError(error) {
  if (error instanceof AppError) return { code: error.code, message: error.message, details: error.details, ambiguous: Boolean(error.ambiguous) };
  const code = Object.hasOwn(safeErrors, error?.code) ? error.code : 'PROVIDER_ERROR';
  return { code, message: safeErrors[code], ambiguous: Boolean(error?.ambiguous) };
}
function conversation(row) { return row && { id: row.id, title: row.title, createdAt: row.created_at, importedFrom: row.imported_from }; }
function context(row) { return row && { id: row.id, conversationId: row.conversation_id, version: row.version, text: row.text, sources: parse(row.sources_json, []), createdAt: row.created_at, metadata: parse(row.metadata_json, {}) }; }
function message(row) { return row && { id: row.id, sequence: row.seq, conversationId: row.conversation_id, taskId: row.task_id, role: row.role, kind: row.kind, provider: row.provider, text: row.text, replyTo: row.reply_to, createdAt: row.created_at, providerSessionRef: row.provider_session_ref, providerMode: row.provider_mode, model: row.model, metadata: parse(row.metadata_json, {}), jobId: row.job_id, stage: row.stage }; }
function job(row) { return row && { id: row.id, sequence: row.seq, conversationId: row.conversation_id, status: row.status, kind: row.kind, stage: row.stage, primaryProvider: row.primary_provider, reviewProvider: row.review_provider, userMessageId: row.user_message_id, primaryMessageId: row.primary_message_id, reviewMessageId: row.review_message_id, revisionMessageId: row.revision_message_id, autoReview: Boolean(row.auto_review), autoRevision: Boolean(row.auto_revision), error: parse(row.error_json), prompts: parse(row.prompts_json, {}), attempts: parse(row.attempts_json, {}), createdAt: row.created_at, updatedAt: row.updated_at }; }

/**
 * Public contract: synchronous mutation methods, asynchronous drain().
 * submit/manualReview/retry => {job, duplicate}. snapshot => {conversation,messages,jobs,context,contextVersions}.
 * No implicit worker timer or paid API fallback. The server explicitly calls drain().
 * requestKey is an 8-128 character client idempotency token. The database supports one live worker process.
 */
export class Engine {
  constructor({ dbPath, adapters = {} }) {
    if (typeof dbPath !== 'string' || !dbPath) throw new AppError('INVALID_INPUT', 'A database path is required.');
    this.store = new Store(dbPath);
    this.adapters = adapters;
    this.active = null;
    this.draining = null;
    this.closed = false;
    this.recover();
  }
  _conversation(id) {
    stringInput(id, 'Conversation ID', 128);
    const row = this.store.get('SELECT * FROM conversations WHERE id=?', id);
    if (!row) throw new AppError('NOT_FOUND', 'Conversation not found. Select an existing conversation.');
    return conversation(row);
  }
  _message(id) {
    stringInput(id, 'Message ID', 128);
    const row = this.store.get('SELECT * FROM messages WHERE id=?', id);
    if (!row) throw new AppError('NOT_FOUND', 'Message not found. Refresh the conversation and try again.');
    return message(row);
  }
  getJob(id) {
    stringInput(id, 'Job ID', 128);
    const row = this.store.get('SELECT * FROM jobs WHERE id=?', id);
    if (!row) throw new AppError('NOT_FOUND', 'Job not found. Refresh the conversation and try again.');
    return job(row);
  }
  createConversation(title = 'New conversation') {
    stringInput(title, 'Title', 160);
    const id = randomUUID();
    this.store.run('INSERT INTO conversations(id,title,created_at) VALUES(?,?,?)', id, title.trim(), now());
    return this._conversation(id);
  }
  listConversations() { return this.store.all('SELECT * FROM conversations ORDER BY created_at DESC, rowid DESC').map(conversation); }
  snapshot(id) {
    const c = this._conversation(id);
    const versions = this.store.all('SELECT * FROM contexts WHERE conversation_id=? ORDER BY version', id).map(context);
    return { conversation: c, messages: this.store.all('SELECT * FROM messages WHERE conversation_id=? ORDER BY seq', id).map(message),
      jobs: this.store.all('SELECT * FROM jobs WHERE conversation_id=? ORDER BY seq', id).map(job),
      context: versions.at(-1) ?? null, contextVersions: versions };
  }
  _deduplicate(key, action, fn) {
    stringInput(key, 'requestKey', 128);
    if (key.length < 8) throw new AppError('INVALID_INPUT', 'requestKey must contain at least 8 characters. Generate a new UUID for each action.');
    const fingerprint = createHash('sha256').update(JSON.stringify(action)).digest('hex');
    return this.store.transaction(() => {
      const existing = this.store.get('SELECT * FROM requests WHERE request_key=?', key);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new AppError('DUPLICATE_KEY_MISMATCH', 'This request token was already used for different content. Use a new token for a new action.');
        return { job: this.getJob(parse(existing.result_json).jobId), duplicate: true };
      }
      const result = fn();
      this.store.run('INSERT INTO requests VALUES(?,?,?)', key, fingerprint, JSON.stringify({ jobId: result.id }));
      return { job: result, duplicate: false };
    });
  }
  _insertMessage(m) {
    const id = m.id ?? randomUUID();
    this.store.run(`INSERT INTO messages(id,conversation_id,task_id,role,kind,provider,text,reply_to,created_at,
      provider_session_ref,provider_mode,model,metadata_json,job_id,stage) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,m.conversationId,m.taskId ?? null,m.role,m.kind,m.provider,m.text,m.replyTo ?? null,m.createdAt ?? now(),
      m.providerSessionRef ?? null,m.providerMode ?? null,m.model ?? null,JSON.stringify(m.metadata ?? {}),m.jobId ?? null,m.stage ?? null);
    return this._message(id);
  }
  _insertJob(j) {
    this.store.run(`INSERT INTO jobs(id,conversation_id,status,kind,stage,primary_provider,review_provider,user_message_id,
      primary_message_id,auto_review,auto_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      j.id,j.conversationId,'queued',j.kind ?? 'task',j.stage ?? 'primary',j.provider,opposite(j.provider),j.userMessageId,
      j.primaryMessageId ?? null,Number(j.autoReview),Number(j.autoRevision),now(),now());
    return this.getJob(j.id);
  }
  submit({ conversationId, text, provider = 'codex', autoReview = true, autoRevision = false, requestKey, replyTo = null }) {
    this._conversation(conversationId);
    const routed = route(text, provider);
    autoReview = booleanInput(autoReview, 'autoReview', true);
    autoRevision = booleanInput(autoRevision, 'autoRevision', false);
    if (autoRevision && !autoReview) throw new AppError('INVALID_INPUT', 'Automatic revision requires automatic review.');
    if (replyTo && this._message(replyTo).conversationId !== conversationId) throw new AppError('INVALID_INPUT', 'The reply message belongs to another conversation.');
    return this._deduplicate(requestKey, { action: 'submit', conversationId, text, provider: routed.provider, autoReview, autoRevision, replyTo }, () => {
      const id = randomUUID();
      const user = this._insertMessage({ conversationId, taskId: id, role: 'user', kind: 'user', provider: 'user', text, replyTo });
      return this._insertJob({ id, conversationId, provider: routed.provider, userMessageId: user.id, autoReview, autoRevision });
    });
  }
  cancel(id) {
    const j = this.getJob(id);
    if (['completed', 'cancelled'].includes(j.status)) return j;
    const error = { code: 'CANCELLED', message: j.status === 'running' || j.status === 'ambiguous'
      ? 'Stopped locally. A request already submitted to a provider may still finish or consume subscription usage.' : 'Cancelled before further provider work.', ambiguous: ['running', 'ambiguous'].includes(j.status) };
    this.store.run('UPDATE jobs SET status=?,error_json=?,updated_at=? WHERE id=?', 'cancelled', JSON.stringify(error), now(), id);
    if (this.active?.id === id) this.active.controller.abort();
    return this.getJob(id);
  }
  retry(id, { requestKey, confirmAmbiguous = false } = {}) {
    const existing = this.getJob(id);
    booleanInput(confirmAmbiguous, 'confirmAmbiguous', false);
    return this._deduplicate(requestKey, { action: 'retry', id, confirmAmbiguous }, () => {
      if (!['failed', 'ambiguous', 'cancelled'].includes(existing.status)) throw new AppError('INVALID_STATE', 'Only a failed, ambiguous, or cancelled job can be retried.');
      if ((existing.status === 'ambiguous' || existing.error?.ambiguous) && !confirmAmbiguous)
        throw new AppError('RETRY_CONFIRMATION_REQUIRED', 'This stage may already have reached the provider. Check its state and explicitly confirm retry.');
      if ((existing.attempts[existing.stage] ?? 0) >= 5) throw new AppError('RETRY_LIMIT', 'This stage reached five attempts. Review the provider connection, then create a new user request.');
      this.store.run('UPDATE jobs SET status=?,error_json=NULL,updated_at=? WHERE id=?', 'queued', now(), id);
      return this.getJob(id);
    });
  }
  manualReview(messageId, { requestKey } = {}) {
    const primary = this._message(messageId);
    if (!['primary', 'revision'].includes(primary.kind)) throw new AppError('INVALID_INPUT', 'Manual review requires a completed primary or revised answer.');
    const originalJob = this.getJob(primary.taskId);
    return this._deduplicate(requestKey, { action: 'manualReview', messageId }, () => {
      // A successful auto/manual review cannot accidentally be duplicated by a second control click.
      const already = this.store.get("SELECT * FROM jobs WHERE primary_message_id=? AND status IN ('queued','running','completed','ambiguous') AND (auto_review=1 OR kind='manualReview') ORDER BY seq LIMIT 1", messageId);
      if (already) throw new AppError('REVIEW_EXISTS', 'This answer already has an active or completed review. Retry a failed review or submit a new request instead.');
      return this._insertJob({ id: randomUUID(), conversationId: primary.conversationId, provider: primary.provider,
        kind: 'manualReview', stage: 'review', userMessageId: originalJob.userMessageId, primaryMessageId: primary.id,
        autoReview: false, autoRevision: false });
    });
  }
  setContext(conversationId, { text, sources = [] }) {
    this._conversation(conversationId);
    stringInput(text, 'Shared context', MAX_CONTEXT_CHARS, { empty: true });
    const checkedSources = validateSources(sources);
    return this.store.transaction(() => {
      const version = (this.store.get('SELECT MAX(version) AS version FROM contexts WHERE conversation_id=?', conversationId).version ?? 0) + 1;
      this.store.run('INSERT INTO contexts(id,conversation_id,version,text,sources_json,created_at) VALUES(?,?,?,?,?,?)', randomUUID(),conversationId,version,text,JSON.stringify(checkedSources),now());
      return context(this.store.get('SELECT * FROM contexts WHERE conversation_id=? AND version=?', conversationId,version));
    });
  }
  previewContext(conversationId, text = '') {
    const state = this.snapshot(conversationId);
    stringInput(text, 'Preview request', MAX_MESSAGE_CHARS, { empty: true });
    return assembleContext({ context: state.context, messages: state.messages, request: text });
  }
  _stageContext(j) {
    const state = this.snapshot(j.conversationId);
    const seqByTask = new Map(state.jobs.map(task => [task.id, task.sequence]));
    const history = state.messages.filter(m => m.id !== j.userMessageId && (seqByTask.get(m.taskId) ?? 0) < j.sequence);
    return assembleContext({ context: state.context, messages: history, request: this._message(j.userMessageId).text,
      role: j.stage, primary: j.primaryMessageId ? this._message(j.primaryMessageId) : null,
      review: j.reviewMessageId ? this._message(j.reviewMessageId) : null });
  }
  recover() {
    if (this.active) throw new AppError('INVALID_STATE', 'Cannot run restart recovery while a provider call is active.');
    const error = JSON.stringify({ code: 'RESTART_AMBIGUOUS', message: safeErrors.RESTART_AMBIGUOUS, ambiguous: true });
    return Number(this.store.run("UPDATE jobs SET status='ambiguous',error_json=?,updated_at=? WHERE status='running'", error,now()).changes);
  }
  async drain() {
    if (this.closed) throw new AppError('INVALID_STATE', 'The engine is closed.');
    if (this.draining) return this.draining;
    this.draining = this._drainLoop();
    try { await this.draining; } finally { this.draining = null; }
  }
  async _drainLoop() {
    while (!this.closed) {
      // A pending ambiguous stage blocks newer work in that room until retry or cancellation.
      const row = this.store.get(`SELECT j.* FROM jobs j WHERE j.status='queued' AND NOT EXISTS (
        SELECT 1 FROM jobs earlier WHERE earlier.conversation_id=j.conversation_id AND earlier.seq<j.seq
        AND earlier.status IN ('queued','running','ambiguous')) ORDER BY j.seq LIMIT 1`);
      if (!row) return;
      await this._runStage(job(row));
    }
  }
  async _runStage(j) {
    const provider = j.stage === 'review' ? j.reviewProvider : j.primaryProvider;
    const controller = new AbortController();
    this.active = { id: j.id, controller };
    try {
      const assembled = j.prompts[j.stage] ?? this._stageContext(j);
      const prompts = { ...j.prompts, [j.stage]: assembled };
      const attempts = { ...j.attempts, [j.stage]: (j.attempts[j.stage] ?? 0) + 1 };
      this.store.run('UPDATE jobs SET status=?,prompts_json=?,attempts_json=?,updated_at=? WHERE id=?',
        'running',JSON.stringify(prompts),JSON.stringify(attempts),now(),j.id);
      const adapter = this.adapters[provider];
      if (!adapter?.run) throw Object.assign(new Error(), { code: 'CONFIGURATION_ERROR' });
      const output = await adapter.run({ provider, prompt: assembled.prompt, role: j.stage, signal: controller.signal });
      if (this.getJob(j.id).status === 'cancelled') return;
      if (!output || !['subscription', 'mock'].includes(output.billing)) throw Object.assign(new Error(), { code: 'BILLING_ROUTE_BLOCKED', ambiguous: true });
      if (typeof output.text !== 'string' || !output.text.trim() || output.text.length > 500000)
        throw Object.assign(new Error(), { code: 'INVALID_PROVIDER_RESULT', ambiguous: true });
      const sessionRef = typeof output.sessionRef === 'string' ? output.sessionRef.slice(0, 500) : null;
      const model = typeof output.model === 'string' ? output.model.slice(0, 200) : null;
      let evidence = output.evidence ?? null;
      if (JSON.stringify(evidence).length > 50000) evidence = { limitation: 'Provider evidence exceeded the storage limit. Only the final answer is available for review.' };
      this.store.transaction(() => {
        // Stage output and transition commit together. A restart can never retain one without the other.
        const current = this.getJob(j.id);
        if (current.status !== 'running') return;
        const completed = this._insertMessage({ conversationId: j.conversationId, taskId: j.id, jobId: j.id,
          stage: j.stage, role: 'assistant', kind: j.stage, provider, text: output.text,
          replyTo: j.stage === 'primary' ? j.userMessageId : j.stage === 'review' ? j.primaryMessageId : j.reviewMessageId,
          providerSessionRef: sessionRef, providerMode: output.billing, model,
          metadata: { evidence, contextVersion: assembled.contextVersion, contextMessageIds: assembled.messageIds,
            reviewLimitation: j.stage === 'review' ? 'Final answer and explicitly recorded evidence only; tools are disabled by the provider adapter.' : undefined,
            mock: output.billing === 'mock' } });
        const field = { primary: 'primary_message_id', review: 'review_message_id', revision: 'revision_message_id' }[j.stage];
        const next = j.stage === 'primary' && j.autoReview ? 'review' : j.stage === 'review' && j.autoRevision ? 'revision' : null;
        this.store.run(`UPDATE jobs SET ${field}=?,status=?,stage=?,error_json=NULL,updated_at=? WHERE id=?`,
          completed.id,next ? 'queued' : 'completed',next ?? j.stage,now(),j.id);
      });
    } catch (error) {
      if (this.getJob(j.id).status !== 'cancelled') {
        const safe = safeError(error);
        this.store.run('UPDATE jobs SET status=?,error_json=?,updated_at=? WHERE id=?',safe.ambiguous ? 'ambiguous' : 'failed',JSON.stringify(safe),now(),j.id);
      }
    } finally { this.active = null; }
  }
  exportConversation(id) {
    return { format: 'ai-group-chat-export', version: 1, exportedAt: now(), ...this.snapshot(id),
      importedOriginals: this.store.all('SELECT original_json FROM imports WHERE conversation_id=?',id).map(r => parse(r.original_json)) };
  }
  importConversation(data) {
    if (!data || data.format !== 'ai-group-chat-export' || data.version !== 1 || !data.conversation || !Array.isArray(data.messages) || !Array.isArray(data.contextVersions) || !Array.isArray(data.jobs))
      throw new AppError('INVALID_IMPORT', 'Select a version 1 ai-group-chat-export JSON file.');
    const serialized = JSON.stringify(data);
    if (serialized.length > 10000000 || data.messages.length > 10000 || data.jobs.length > 5000)
      throw new AppError('INVALID_IMPORT', 'The import exceeds the 10 MB or record-count limit.');
    stringInput(data.conversation.title, 'Imported title',160);
    const id = this.store.get('SELECT id FROM conversations WHERE id=?',String(data.conversation.id)) ? randomUUID() : stringInput(data.conversation.id,'Imported conversation ID',128);
    const messageIds = new Map();
    const jobIds = new Map();
    for (const m of data.messages) {
      stringInput(m.id,'Imported message ID',128);
      if (messageIds.has(m.id)) throw new AppError('INVALID_IMPORT','The import contains duplicate message IDs.');
      stringInput(m.text,'Imported message',500000);
      if (!['user','assistant'].includes(m.role) || !['user','primary','review','revision'].includes(m.kind) || !['user','codex','claude'].includes(m.provider))
        throw new AppError('INVALID_IMPORT','The import contains an unsupported message role, kind, or provider.');
      if (m.providerMode != null && !['subscription','mock'].includes(m.providerMode)) throw new AppError('INVALID_IMPORT','The import contains an unsupported provider mode.');
      messageIds.set(m.id,this.store.get('SELECT id FROM messages WHERE id=?',m.id) ? randomUUID() : m.id);
    }
    for (const j of data.jobs) {
      stringInput(j.id,'Imported job ID',128);
      providerInput(j.primaryProvider);
      if (jobIds.has(j.id)) throw new AppError('INVALID_IMPORT','The import contains duplicate task IDs.');
      jobIds.set(j.id,this.store.get('SELECT id FROM jobs WHERE id=?',j.id) ? randomUUID() : j.id);
    }
    for (const c of data.contextVersions) { stringInput(c.text,'Imported context',MAX_CONTEXT_CHARS,{empty:true}); validateSources(c.sources); }
    for (const m of data.messages) {
      if ((m.replyTo && !messageIds.has(m.replyTo)) || (m.taskId && !jobIds.has(m.taskId))) throw new AppError('INVALID_IMPORT','A message references a missing reply or task.');
    }
    const mapped = value => value == null ? null : messageIds.get(value);
    for (const j of data.jobs) {
      if (!['primary','review','revision'].includes(j.stage) || !['task','manualReview'].includes(j.kind) || !messageIds.has(j.userMessageId) || [j.primaryMessageId,j.reviewMessageId,j.revisionMessageId].some(v => v && !messageIds.has(v)))
        throw new AppError('INVALID_IMPORT','A task contains an invalid stage or missing message reference.');
    }
    return this.store.transaction(() => {
      this.store.run('INSERT INTO conversations(id,title,created_at,imported_from) VALUES(?,?,?,?)',id,data.conversation.title,now(),String(data.conversation.id));
      for (const j of data.jobs) {
        const importedId = jobIds.get(j.id);
        this.store.run(`INSERT INTO jobs(id,conversation_id,status,kind,stage,primary_provider,review_provider,user_message_id,
          primary_message_id,review_message_id,revision_message_id,auto_review,auto_revision,error_json,prompts_json,attempts_json,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,importedId,id,j.status === 'completed' ? 'completed' : 'cancelled',j.kind,j.stage,
          j.primaryProvider,opposite(j.primaryProvider),mapped(j.userMessageId),mapped(j.primaryMessageId),mapped(j.reviewMessageId),mapped(j.revisionMessageId),
          Number(Boolean(j.autoReview)),Number(Boolean(j.autoRevision)),j.status === 'completed' ? null : JSON.stringify({code:'IMPORTED_PAUSED',message:'Imported unfinished work is paused. Review its provider state and deliberately retry.',ambiguous:true}),
          // Unfinished imported work must rebuild a prompt from validated visible records.
          // Its original frozen prompts remain preserved in the original export archive.
          JSON.stringify(j.status === 'completed' ? j.prompts ?? {} : {}),JSON.stringify({}),typeof j.createdAt === 'string' ? j.createdAt : now(),now());
      }
      for (const m of data.messages) this._insertMessage({ ...m,id:messageIds.get(m.id),conversationId:id,taskId:jobIds.get(m.taskId) ?? null,
        jobId:m.jobId ? jobIds.get(m.jobId) : null,replyTo:mapped(m.replyTo),metadata:{...(m.metadata ?? {}),importedOriginalId:m.id} });
      let version = 0;
      for (const c of data.contextVersions) this.store.run('INSERT INTO contexts(id,conversation_id,version,text,sources_json,created_at,metadata_json) VALUES(?,?,?,?,?,?,?)',
        randomUUID(),id,++version,c.text,JSON.stringify(c.sources ?? []),typeof c.createdAt === 'string' ? c.createdAt : now(),JSON.stringify({ importedOriginalId:c.id, importedOriginalVersion:c.version }));
      this.store.run('INSERT INTO imports VALUES(?,?,?,?)',randomUUID(),id,serialized,now());
      return this.snapshot(id);
    });
  }
  close() {
    if (this.active) throw new AppError('INVALID_STATE','Stop the active job and await drain() before closing the engine.');
    this.closed = true;
    this.store.close();
  }
}
export { AppError };
