import { ensure, LIMITS, utf8Size } from '../utils/validation.js';
export function nativeBridge(files, linking, channel = 'addon') {
  ensure(['addon', 'script'].includes(channel), 'Unknown native channel.');
  const prefix = `assault-${channel}`;
  const constants = files.getConstants();
  const read = async (directory, name) => {
    const path = `${directory}/${name}`;
    return await files.fileExists(path) ? files.readFile(path, 'utf8') : null;
  };
  let busy = false, sequence = 0;
  return {
    io: { read: name => read(constants.DocumentsDirPath, name), write: (name, text) => files.writeFile('documents', name, text, 'utf8') },
    async request(operation, options = {}) {
      ensure(channel !== 'script' || operation === 'runner', 'The script channel only accepts runner requests.');
      ensure(!busy, 'Finish the current file operation first.'); busy = true;
      const id = `${Date.now()}-${++sequence}`, output = `${prefix}-result-${id}.json`;
      let requestTouched = false;
      try {
        const payload = JSON.stringify({ id, operation, ...options });
        ensure(utf8Size(payload) <= LIMITS.archive * 2, 'Request is too large.');
        requestTouched = true;
        await files.writeFile('cache', `${prefix}-request.json`, payload, 'utf8');
        await linking.openURL(`${prefix}s://request/${id}`);
        const deadline = Date.now() + 2 * 60 * 1000;
        while (Date.now() < deadline) {
          const text = await read(constants.CacheDirPath, output);
          if (text !== null) { const result = JSON.parse(text); ensure(!result.error, result.error); return result; }
          await new Promise(resolve => setTimeout(resolve, 300));
        }
        throw new Error('The file operation did not finish within 2 minutes. Close the picker and retry.');
      } finally {
        let cleanupFailed = false;
        try {
          if (requestTouched) for (const name of [output, `${prefix}-request.json`]) {
            try {
              ensure(typeof files.removeFile === 'function', 'File deletion unavailable.');
              await files.removeFile('cache', name);
              ensure(!await files.fileExists(`${constants.CacheDirPath}/${name}`), 'File deletion failed.');
            } catch {
              try {
                await files.writeFile('cache', name, '{}', 'utf8');
                ensure(await read(constants.CacheDirPath, name) === '{}', 'Cleanup verification failed.');
              } catch { cleanupFailed = true; }
            }
          }
        } finally { busy = false; }
        ensure(!cleanupFailed, 'Temporary request cleanup failed. Check device storage before retrying.');
      }
    }
  };
}
