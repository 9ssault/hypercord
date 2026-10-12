// Explicit, read-only history export. Pages go to disk instead of the capture ring.
globalThis.__ASSAULT_HISTORY_EXPORT__ = (api, config, files, render, notify, retained) => {
    const owned = new Set();
    let cleanupQueue = Promise.resolve(true);
    let active = false, epoch = 0, sequence = 0, status = 'No history archive prepared.';
    const manifestName = 'assault-history-manifest.json';
    const id = value => typeof value === 'string' && /^\d{1,20}$/.test(value);
    const find = (...props) => { try { return api.metro.findByProps?.(...props); } catch { return null; } };
    const remove = async name => {
        try {
            const disk = files();
            if (!disk) throw new Error('file-module-unavailable');
            await disk.removeFile('cache', name);
            owned.delete(name);
            return true;
        } catch { owned.add(name); return false; }
    };
    const cancel = () => {
        epoch++;
        status = 'Clearing history archive; wait for cleanup to finish.';
        cleanupQueue = cleanupQueue.then(async () => {
            // An invalid manifest prevents native saving even if deletion is denied.
            owned.add(manifestName);
            let invalidated = false;
            try {
                const disk = files();
                if (disk) {
                    await disk.writeFile('cache', manifestName, JSON.stringify({ ready: false }), 'utf8');
                    invalidated = true;
                }
            } catch { /* Still try deleting the manifest below. */ }
            const names = [...owned];
            const results = await Promise.all(names.map(remove));
            invalidated = invalidated || results[names.indexOf(manifestName)];
            const cleared = results.every(Boolean);
            if (!cleared) {
                status = invalidated
                    ? 'History cleanup failed; archive saving is disabled. Retry export cancel to remove remaining files.'
                    : 'History cleanup and invalidation failed. Do not save the old archive; restart the client to clear its cache.';
                notify(status);
            } else status = active ? 'History export cancelled; wait for the current operation to finish.' : 'History archive cleared.';
            return cleared;
        });
        return cleanupQueue;
    };
    const timed = task => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 30000);
        Promise.resolve(task).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
    const clean = value => {
        // Retain all API message fields, subject only to the user's privacy choices.
        const copy = JSON.parse(JSON.stringify(value));
        const walk = node => {
            if (!node || typeof node !== 'object') return;
            if (config.redactAuthors && node.author) { node.author = { id: 'redacted', username: 'redacted' }; delete node.member; }
            if (config.captureAttachments === false && node.attachments) node.attachments = [];
            for (const child of Object.values(node)) if (child && typeof child === 'object') walk(child);
        };
        walk(copy); return copy;
    };
    const start = async (extra = '') => {
        if (active) { notify(status); return; }
        const supplied = extra.trim() ? extra.trim().split(/[\s,]+/) : [];
        if (supplied.some(value => !id(value))) { notify('Use export-history query:<channel IDs separated by spaces or commas>.'); return; }
        const disk = files();
        const rest = api.metro.common.RestAPI || find('getAPIBaseURL', 'get') || find('get', 'post', 'patch');
        if (!disk || typeof rest?.get !== 'function') { notify('History export requires a compatible client REST and file module. No archive created.'); return; }
        active = true;
        const cleanup = cancel();
        const token = epoch, run = `${Date.now()}-${++sequence}`;
        const check = () => { if (token !== epoch) throw new Error('cancelled'); };
        const manifest = {
            schemaVersion: 1, ready: true, startedAt: new Date().toISOString(), scope: 'Known client channels plus supplied channel IDs',
            accountComplete: false, channels: [], entries: [], messageCount: 0,
            limitations: ['Closed DMs missing from client stores require their channel IDs. Unknown channels and archived threads may be absent.',
                'Deleted messages and earlier edits are available only in the retained-session supplement.',
                'Message pages include attachment metadata and URLs. See attachmentDownloads in this ZIP for downloaded files and failures; URLs can expire.',
                'Messages sent after a channel scan starts may be absent. This is not a point-in-time account backup.'],
            privacy: { redactAuthors: Boolean(config.redactAuthors), attachmentLinks: config.captureAttachments !== false },
        };
        if (!await cleanup) { active = false; return; }
        let index = 0;
        const write = async (name, value) => {
            check();
            const filename = `assault-history-${run}-${++index}.${name.endsWith('.html') ? 'html' : 'json'}`;
            owned.add(filename);
            await disk.writeFile('cache', filename, value, 'utf8');
            if (token !== epoch) { owned.add(filename); await cancel(); check(); }
            manifest.entries.push({ file: filename, name });
        };
        const get = async (channel, before) => {
            const result = await timed(rest.get({ url: `/channels/${channel}/messages`, query: { limit: 100, ...(before ? { before } : {}) } }));
            check();
            if (result?.status && (result.status < 200 || result.status >= 300)) { const error = new Error('http'); error.status = result.status; throw error; }
            if (!Array.isArray(result?.body)) throw new Error('invalid-response');
            return result.body;
        };
        try {
            check();
            const channels = new Map(supplied.map(value => [value, { id: value, source: 'supplied' }]));
            const add = (value, source) => {
                if (id(value?.id) && !channels.has(value.id)) channels.set(value.id, { id: value.id, name: typeof value.name === 'string' ? value.name : '', type: value.type, source });
            };
            const store = find('getChannel', 'getDMFromUserId');
            for (const method of ['getChannels', 'getMutablePrivateChannels']) {
                try {
                    const values = store?.[method]?.();
                    for (const value of Object.values(values || {})) add(value, 'client-store');
                } catch { manifest.limitations.push(`Client channel discovery failed: ${method}.`); }
            }
            const captured = retained();
            for (const message of captured) add({ id: message.channel_id }, 'retained-session');
            // Categories, directory and forum containers do not have ordinary message histories.
            const targets = [...channels.values()].filter(channel => ![4, 14, 15, 16].includes(channel.type));
            manifest.discoveredChannels = targets.length;
            await write('retained-session.json', JSON.stringify({ source: 'bounded-session-capture', messages: captured }));
            for (const channel of targets) {
                check();
                const report = { ...channel, messages: 0, pages: 0, status: 'incomplete' };
                manifest.channels.push(report);
                let before;
                try {
                    for (;;) {
                        status = `Exporting channel ${channel.id}: ${report.messages} messages; ${manifest.channels.length}/${targets.length} channels.`;
                        const page = await get(channel.id, before);
                        if (!page.length) { report.status = 'reached-end'; break; }
                        if (page.some(m => !id(m?.id) || m.channel_id !== channel.id || (before && BigInt(m.id) >= BigInt(before))) || new Set(page.map(m => m.id)).size !== page.length) throw new Error('invalid-page');
                        const oldest = page.reduce((min, message) => BigInt(message.id) < BigInt(min) ? message.id : min, page[0].id);
                        const messages = page.map(clean);
                        await write(`channels/${channel.id}/${report.pages + 1}.json`, JSON.stringify({ channel: channel.id, messages }));
                        report.pages++; report.messages += page.length; manifest.messageCount += page.length;
                        if (typeof render === 'function') await write(`channels/${channel.id}/${report.pages}.html`, render(messages.map(m => ({ ...m, author: m.author || {}, edits: m.edits || [], attachments: m.attachments || [] })), channel.id));
                        before = oldest;
                        await new Promise(resolve => setTimeout(resolve, 250));
                        check();
                        // Client REST handles its normal scheduling. Do not blindly retry rate limits.
                    }
                } catch (error) {
                    check();
                    report.status = 'incomplete';
                    report.reason = error?.status ? `HTTP ${Number(error.status)}` : ['timeout', 'invalid-response', 'invalid-page'].includes(error?.message) ? error.message : 'request-or-storage-failed';
                    // Authentication and rate limits stop the run; remaining channels stay explicitly unscanned.
                    if ([401, 429].includes(Number(error?.status))) break;
                }
            }
            check();
            for (const channel of targets.slice(manifest.channels.length)) manifest.channels.push({ ...channel, messages: 0, pages: 0, status: 'not-scanned' });
            manifest.finishedAt = new Date().toISOString();
            manifest.scannedChannelsComplete = targets.length > 0 && manifest.channels.every(channel => channel.status === 'reached-end');
            owned.add(manifestName);
            await disk.writeFile('cache', manifestName, JSON.stringify(manifest, null, 2), 'utf8');
            if (token !== epoch) { await cancel(); check(); }
            status = `${manifest.messageCount} server messages in ${manifest.channels.length} known channels. ${manifest.scannedChannelsComplete ? 'Reached the end of every selected channel.' : 'INCOMPLETE: inspect manifest.json for failures or missing channels.'} Unknown closed DMs cannot be guaranteed. Save using AS → Save history archive.`;
            notify(status);
        } catch (error) {
            if (token === epoch && await cancel()) { status = 'History export failed; no ready archive. Check storage and client compatibility.'; notify(status); }
        } finally { active = false; }
    };
    return { start, cancel, status: () => status };
};
