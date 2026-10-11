import { Journal } from '../utils/store.js';
import { ensure, jsonCopy, utf8Size } from '../utils/validation.js';

export const runtimes = { javascript: 'JavaScript', python: 'Python', shell: 'Shell' };
const active = new Set(['starting', 'running', 'stopping', 'unknown']);
const id = () => `s${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
export function scriptValues(value) {
  ensure(value && typeof value.name === 'string' && value.name.trim() && value.name.length <= 80, 'Use a project name of 1–80 characters.');
  ensure(Object.prototype.hasOwnProperty.call(runtimes, value.runtime), 'Choose a supported runtime.');
  ensure(typeof value.source === 'string' && value.source.trim() && utf8Size(value.source) <= 65536, 'Use a nonempty script of at most 64 KiB.');
  const args = typeof value.args === 'string' ? JSON.parse(value.args) : value.args ?? [];
  ensure(Array.isArray(args) && args.length <= 32 && args.every(item => typeof item === 'string' && item.length <= 2048 && !item.includes('\0')), 'Arguments must be a JSON array of at most 32 strings.');
  ensure(utf8Size(JSON.stringify(args)) <= 65536, 'Arguments exceed the 64 KiB encoded limit.');
  const module = value.module ?? 'commonjs';
  ensure(['commonjs', 'esm'].includes(module), 'Choose CommonJS or ES modules.');
  const setup = value.setup ?? '';
  ensure(typeof setup === 'string' && utf8Size(setup) <= 8192, 'Setup commands must be at most 8 KiB.');
  return { name: value.name.trim(), runtime: value.runtime, source: value.source, args, setup, module, restart: value.restart === true };
}

export class ScriptManager {
  constructor(io, bridge, canRun = () => true) {
    this.store = new Journal({ read: name => io.read(name.replace('assault-addons-', 'assault-scripts-')), write: (name, value) => io.write(name.replace('assault-addons-', 'assault-scripts-'), value) });
    this.bridge = bridge; this.canRun = canRun;
    this.data = { format: 1, projects: [] }; this.listeners = new Set(); this.queue = Promise.resolve();
  }
  subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  snapshot = () => this.data;
  emit() { for (const listener of this.listeners) listener(); }
  serial(action) { const next = this.queue.then(action); this.queue = next.catch(() => {}); return next; }
  async commit(data) { await this.store.save(data); this.data = data; this.emit(); }
  validateArchive(value) {
    const saved = jsonCopy(value, 4 * 1024 * 1024);
    ensure(saved.format === 1 && Array.isArray(saved.projects) && saved.projects.length <= 24, 'Script storage is invalid. Existing files are preserved.');
    const identifiers = new Set();
    saved.projects = saved.projects.map(project => {
      ensure(project && typeof project.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(project.id) && !identifiers.has(project.id), 'Script project identifier is invalid.');
      identifiers.add(project.id);
      if (project.run) ensure(typeof project.run.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(project.run.id) && ['starting', 'running', 'stopping', 'stopped', 'exited', 'failed', 'interrupted', 'missing', 'unknown'].includes(project.run.state), 'Script run record is invalid.');
      return { ...project, ...scriptValues(project) };
    });
    return saved;
  }
  async start() {
    const saved = await this.store.load(data => this.validateArchive(data));
    if (saved) this.data = this.validateArchive(saved);
    this.emit();
  }
  async resume() {
    for (const project of this.data.projects) {
      if (!project.restart || !this.canRun()) continue;
      try {
        if (project.run) await this.poll(project.id);
        const latest = this.find(project.id);
        if (!latest.run || !active.has(latest.run.state)) await this.run(project.id);
      } catch { /* Preserve the run for explicit reconciliation in the runner screen. */ }
    }
  }
  check() { return this.serial(() => this.bridge.request('runner', { request: { operation: 'check' } })); }
  find(projectId) { const project = this.data.projects.find(p => p.id === projectId); ensure(project, 'Project no longer exists.'); return project; }
  save(value, projectId) {
    return this.serial(async () => {
      const values = scriptValues(value), data = jsonCopy(this.data, 4 * 1024 * 1024);
      if (projectId) {
        const index = data.projects.findIndex(p => p.id === projectId); ensure(index >= 0, 'Project no longer exists.');
        data.projects[index] = { ...data.projects[index], ...values };
      } else {
        ensure(data.projects.length < 24, 'Export or remove a project before adding another (24 projects maximum).');
        data.projects.push({ ...values, id: id(), createdAt: new Date().toISOString(), run: null });
      }
      await this.commit(data);
      return projectId ?? data.projects[data.projects.length - 1].id;
    });
  }
  run(projectId, setup = false) {
    return this.serial(async () => {
      ensure(this.canRun(), 'Scripts are paused in safe mode.');
      const project = this.find(projectId);
      ensure(!project.run || !active.has(project.run.state), 'Refresh or stop the existing run before starting another.');
      if (setup) ensure(project.setup?.trim(), 'Enter a setup command first.');
      const run = { id: id(), phase: setup ? 'setup' : 'script', state: 'starting', startedAt: new Date().toISOString(), console: '' };
      const data = jsonCopy(this.data, 4 * 1024 * 1024);
      data.projects.find(p => p.id === projectId).run = run;
      await this.commit(data); // Acknowledged durable ID BEFORE dispatch, including crash/timeout recovery.
      try {
        const result = await this.bridge.request('runner', { request: { operation: 'start', project: projectId, run: run.id, runtime: setup ? 'shell' : project.runtime, module: project.module ?? 'commonjs', source: setup ? project.setup : project.source, args: setup ? [] : project.args } });
        await this.record(projectId, result);
      } catch (error) {
        await this.record(projectId, { state: 'unknown', error: `Launch result is unknown. Refresh before retrying. ${error.message}` });
        throw error;
      }
    });
  }
  async record(projectId, result) {
    const data = jsonCopy(this.data, 4 * 1024 * 1024), project = data.projects.find(p => p.id === projectId);
    ensure(project?.run, 'Run no longer exists.');
    ensure(['starting', 'running', 'stopping', 'stopped', 'exited', 'failed', 'interrupted', 'missing', 'unknown'].includes(result.state), 'Invalid runner response.');
    project.run = { id: project.run.id, phase: project.run.phase ?? 'script', startedAt: project.run.startedAt, state: result.state, console: String(result.console ?? project.run.console ?? '').slice(-16384), error: String(result.error ?? '').slice(0, 400), exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null, truncated: result.truncated === true };
    if (JSON.stringify(project.run) !== JSON.stringify(this.find(projectId).run)) await this.commit(data);
  }
  poll(projectId) {
    return this.serial(async () => {
      const project = this.find(projectId); if (!project.run) return;
      const result = await this.bridge.request('runner', { request: { operation: 'poll', project: projectId, run: project.run.id } });
      await this.record(projectId, result);
    });
  }
  control(projectId, operation, text = '') {
    return this.serial(async () => {
      ensure(['stop', 'input'].includes(operation), 'Invalid process control.');
      const project = this.find(projectId); ensure(project.run, 'Start a script first.');
      ensure(utf8Size(JSON.stringify({ operation, data: text })) < 4000, 'Input is too long.');
      await this.bridge.request('runner', { request: { operation, project: projectId, run: project.run.id, data: text } });
    });
  }
  remove(projectId) {
    return this.serial(async () => {
      const project = this.find(projectId);
      ensure(!project.run || !active.has(project.run.state), 'Stop and refresh the run before removing this project.');
      await this.commit({ ...this.data, projects: this.data.projects.filter(p => p.id !== projectId) });
    });
  }
  export() { return this.serial(async () => JSON.stringify({ format: 'assault-scripts-1', projects: this.data.projects }, null, 2)); }
  restore(text) {
    return this.serial(async () => {
      ensure(this.data.projects.length === 0, 'Restore into an empty project library to preserve existing work.');
      const backup = JSON.parse(text);
      ensure(backup.format === 'assault-scripts-1' && Array.isArray(backup.projects) && backup.projects.length <= 24, 'Invalid script backup.');
      const projects = backup.projects.map(project => ({ ...scriptValues(project), restart: false, id: id(), createdAt: new Date().toISOString(), run: null }));
      await this.commit({ format: 1, projects });
    });
  }
}
