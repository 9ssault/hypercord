import { compile } from './sandbox.js';
import { ensure, jsonCopy, key, LIMITS, message, settingsValues } from '../utils/validation.js';
import { validateTheme } from '../themes/index.js';

function inspect(source, filename) {
  const compiled = compile(source, filename), m = compiled.manifest;
  key(m.id);
  ensure(['plugin', 'theme'].includes(m.kind) && typeof m.name === 'string' && m.name.length > 0 && m.name.length <= 80 && typeof m.version === 'string' && /^\d+\.\d+\.\d+$/.test(m.version), 'Addon needs id, kind, name and a semantic version.');
  ensure(m.description === undefined || typeof m.description === 'string' && m.description.length <= 500, 'Description is too long.');
  m.settings ??= {};
  ensure(m.settings && typeof m.settings === 'object' && !Array.isArray(m.settings) && Object.keys(m.settings).length <= 20, 'Invalid settings schema.');
  for (const [name, field] of Object.entries(m.settings)) {
    key(name);
    ensure(field && typeof field.label === 'string' && field.label.length > 0 && field.label.length <= 80 && ['boolean', 'string', 'number'].includes(field.type), 'Invalid settings field.');
    if (field.type === 'number') ensure(Number.isFinite(field.min) && Number.isFinite(field.max) && field.min <= field.max, 'Number settings require min and max.');
  }
  settingsValues(m.settings);
  if (m.kind === 'theme') { ensure(!compiled.hasHooks, 'Themes cannot contain lifecycle code.'); validateTheme(m.colors); }
  return compiled;
}
export class AddonManager {
  constructor(store, host) {
    this.store = store; this.host = host; this.listeners = new Set(); this.tail = Promise.resolve();
    this.data = { version: 1, entries: [], selectedTheme: null }; this.ready = false; this.startupErrors = Object.create(null);
  }
  subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  snapshot = () => this.data;
  emit() { for (const fn of this.listeners) try { fn(); } catch {} }
  async start() {
    const saved = await this.store.load(data => this.validateArchive(data));
    if (saved) this.data = this.validateArchive(saved);
    this.ready = true;
    for (const entry of this.data.entries.filter(e => e.enabled && e.manifest.kind === 'plugin' && this.host.canActivate?.() !== false)) {
      try { await this.enable(entry.manifest.id, true); }
      catch (error) { this.startupErrors[entry.manifest.id] = `Could not start: ${message(error)}. Saved configuration is preserved.`; }
    }
    this.data = { ...this.data };
    try { await this.host.applyTheme(this.data.entries.find(e => e.manifest.id === this.data.selectedTheme) ?? null); }
    catch (error) { this.themeError = message(error); }
    this.emit();
  }
  validateArchive(data) {
    data = jsonCopy(data, LIMITS.archive - 1024);
    ensure(data.version === 1 && Array.isArray(data.entries) && data.entries.length <= LIMITS.addons, 'Invalid addon backup.');
    const ids = new Set();
    for (const e of data.entries) {
      ensure(e && typeof e === 'object', 'Invalid addon record.');
      const { manifest } = inspect(e.source, e.filename);
      ensure(!ids.has(manifest.id), 'Duplicate addon identifier.'); ids.add(manifest.id);
      e.manifest = manifest;
      e.settings = settingsValues(manifest.settings, e.settings);
      ensure(e.state && typeof e.state === 'object' && !Array.isArray(e.state), 'Invalid plugin state.');
      e.state = jsonCopy(e.state); e.enabled = e.enabled === true && manifest.kind === 'plugin';
      e.error = typeof e.error === 'string' ? e.error.slice(0, 240) : null;
      ensure(typeof e.installedAt === 'string' && e.installedAt.length <= 40 && typeof e.origin === 'string' && e.origin.length <= 2048, 'Invalid addon metadata.');
    }
    ensure(data.selectedTheme === null || data.entries.some(e => e.manifest.id === data.selectedTheme && e.manifest.kind === 'theme'), 'Selected theme is missing.');
    return data;
  }
  transaction(change, rollback) {
    const next = this.tail.then(async () => {
      ensure(this.ready, 'Addon storage is not ready.');
      const draft = jsonCopy(this.data, LIMITS.archive - 1024), effects = [];
      let result;
      try { result = await change(draft, effects); await this.store.save(draft); }
      catch (error) { if (rollback) await rollback(); throw error; }
      this.data = draft; this.emit();
      for (const effect of effects) try { await effect(); } catch (error) { try { this.host.report?.(message(error)); } catch {} }
      return result;
    });
    this.tail = next.catch(() => {});
    return next;
  }
  record(data, id) { const e = data.entries.find(e => e.manifest.id === id); ensure(e, 'Addon was removed.'); return e; }
  hook(entry, name, effects) {
    const compiled = inspect(entry.source, entry.filename);
    let notifications = 0;
    compiled.invoke(name, (method, args) => {
      const [name, value] = args;
      if (method === 'notify') {
        ensure(args.length === 1 && typeof name === 'string' && name.length > 0 && name.length <= 240 && ++notifications <= 3, 'Notification limit exceeded.');
        effects.push(() => this.host.notify(`${entry.manifest.name}: ${name}`)); return null;
      }
      key(name);
      if (method === 'getSetting') { ensure(args.length === 1 && Object.prototype.hasOwnProperty.call(entry.settings, name), 'Unknown setting.'); return entry.settings[name]; }
      if (method === 'getState') { ensure(args.length === 2, 'getState requires a default value.'); return jsonCopy(Object.prototype.hasOwnProperty.call(entry.state, name) ? entry.state[name] : value); }
      if (method === 'setState') {
        ensure(args.length === 2, 'setState requires a value.'); entry.state[name] = jsonCopy(value); jsonCopy(entry.state); return null;
      }
      throw new Error('API access denied.');
    });
  }
  install(source, filename, origin = 'local') {
    const { manifest } = inspect(source, filename);
    ensure(typeof origin === 'string' && origin.length <= 2048, 'Invalid source.');
    return this.transaction(data => {
      ensure(data.entries.length < LIMITS.addons, 'Remove an addon before installing more (32 maximum).');
      ensure(!data.entries.some(e => e.manifest.id === manifest.id), 'This addon is already installed. Remove it before installing a replacement. Export its state first.');
      data.entries.push({ source, filename, origin, installedAt: new Date().toISOString(), manifest, enabled: false, settings: settingsValues(manifest.settings), state: {}, error: null });
    });
  }
  async enable(id, enabled) {
    await this.transaction((data, effects) => {
      ensure(!enabled || this.host.canActivate?.() !== false, 'Disable safe mode before activating plugins.');
      const entry = this.record(data, id); ensure(entry.manifest.kind === 'plugin', 'Use theme selection for themes.');
      if (!enabled && this.host.canActivate?.() === false) { entry.enabled = false; entry.error = null; return; }
      const savedState = jsonCopy(entry.state);
      try { this.hook(entry, enabled ? 'onStart' : 'onStop', effects); entry.enabled = enabled; entry.error = null; }
      catch (error) { entry.state = savedState; effects.length = 0; entry.enabled = false; entry.error = message(error); }
    });
    if (this.startupErrors[id]) { delete this.startupErrors[id]; this.data = { ...this.data }; this.emit(); }
  }
  configure(id, values) {
    return this.transaction((data, effects) => {
      const entry = this.record(data, id); entry.settings = settingsValues(entry.manifest.settings, values);
      if (entry.enabled && !this.startupErrors[id] && this.host.canActivate?.() !== false) {
        const savedState = jsonCopy(entry.state);
        try { this.hook(entry, 'onSettingsChanged', effects); entry.error = null; }
        catch (error) { entry.state = savedState; effects.length = 0; entry.enabled = false; entry.error = message(error); }
      }
    });
  }
  selectTheme(id) {
    return this.transaction(async data => {
      const target = id === null ? null : this.record(data, id);
      ensure(target === null || target.manifest.kind === 'theme', 'Choose a theme.');
      // Apply first; if the durable commit fails, transaction's caller restores the
      // last committed theme below. No selection is reported before both succeed.
      await this.host.applyTheme(target);
      data.selectedTheme = id;
    }, async () => {
      try { await this.host.applyTheme(this.data.entries.find(e => e.manifest.id === this.data.selectedTheme) ?? null); } catch (rollback) { this.themeError = message(rollback); }
    }).then(() => { this.themeError = null; this.emit(); });
  }
  async remove(id) {
    await this.transaction((data, effects) => {
      const entry = this.record(data, id);
      ensure(data.selectedTheme !== id, 'Switch to another theme before removing this one.');
      if (entry.enabled && !this.startupErrors[id] && this.host.canActivate?.() !== false) { try { this.hook(entry, 'onStop', effects); } catch { effects.length = 0; } }
      data.entries = data.entries.filter(e => e !== entry);
    });
    delete this.startupErrors[id];
  }
  async export() { await this.tail; ensure(this.ready, 'Storage is not ready.'); return JSON.stringify(this.validateArchive(this.data)); }
  restore(text) {
    ensure(typeof text === 'string' && text.length * 2 <= LIMITS.archive, 'Backup exceeds the size limit.');
    const restored = this.validateArchive(JSON.parse(text));
    // Backups never auto-activate code or override a running theme.
    restored.entries.forEach(e => { e.enabled = false; }); restored.selectedTheme = null;
    return this.transaction(data => {
      ensure(data.entries.length === 0, 'Restore requires an empty library. Export and remove existing addons first.');
      Object.assign(data, restored);
    });
  }
}
export { inspect as validateAddon };
