import { ensure, jsonCopy, LIMITS } from './validation.js';
// Two independent slots preserve the previous valid revision after an interrupted
// write. A save is acknowledged only after reading the exact bytes back.
export class Journal {
  constructor(io) { this.io = io; this.revision = 0; this.slot = 1; }
  async load(validate = value => value) {
    const candidates = [];
    let present = false;
    for (let slot = 0; slot < 2; slot++) {
      const text = await this.io.read(`assault-addons-${slot}.json`);
      if (text === null) continue;
      present = true;
      try {
        ensure(text.length * 2 <= LIMITS.archive, 'Archive too large.');
        const value = JSON.parse(text);
        ensure(value.format === 1 && Number.isSafeInteger(value.revision) && value.revision > 0 && value.data && typeof value.data === 'object', 'Invalid journal.');
        const data = await validate(value.data);
        candidates.push({ slot, ...value, data });
      } catch { /* The other slot may contain the previous committed revision. */ }
    }
    ensure(!present || candidates.length, 'Addon storage is damaged. Restore a backup; existing files have been preserved.');
    const latest = candidates.sort((a, b) => b.revision - a.revision)[0];
    if (!latest) return null;
    this.revision = latest.revision; this.slot = latest.slot;
    return latest.data;
  }
  async save(data) {
    const envelope = { format: 1, revision: this.revision + 1, data: jsonCopy(data, LIMITS.archive - 1024) };
    const text = JSON.stringify(envelope);
    const slot = 1 - this.slot, path = `assault-addons-${slot}.json`;
    await this.io.write(path, text);
    ensure(await this.io.read(path) === text, 'Storage verification failed. Your previous revision is preserved.');
    this.slot = slot; this.revision = envelope.revision;
  }
}
