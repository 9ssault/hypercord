// Native Hermes extension. No network client, database, timer-based capture or UI framework.
(() => {
    if (globalThis.assault || globalThis.__assaultPending) return;
    const config = { ...(globalThis.__ASSAULT_CONFIG__ || {}) };
    const bound = (value, fallback, min, max) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Math.floor(Number(value)))) : fallback;
    const limit = bound(config.maxMessages, 500, 25, 1000);
    const editLimit = bound(config.maxEdits, 20, 0, 50);
    const budget = bound(config.memoryKiB, 4096, 64, 8192) * 1024;
    const ttl = bound(config.retentionMinutes, 0, 0, 1440) * 60000;
    const sessionNotes = [];
    const captured = new Map(), costs = new WeakMap(), received = new WeakMap();
    const stats = { evicted: 0, blockedAnalytics: 0, blockedCrashes: 0, blockedTyping: 0, captureErrors: 0 };
    let capturing = config.captureEnabled !== false;
    const ghostPings = () => [...captured.values()].filter(message => message.ghost_ping);
    let bytes = 0, nextExpiry = Infinity;
    const text = (value, max = 16000) => typeof value === 'string' ? value.slice(0, max) : '';
    const valid = m => m && typeof m.id === 'string' && m.id.length > 0 && m.id.length <= 64 && typeof m.channel_id === 'string' && m.channel_id.length > 0 && m.channel_id.length <= 64;
    const keyFor = m => `${m.channel_id}:${m.id}`;
    function remove(key, evicted = false) {
        const old = captured.get(key);
        if (!old) return;
        bytes -= costs.get(old) || 0;
        captured.delete(key);
        if (evicted) stats.evicted++;
    }
    function clear(channel) {
        for (const [key, m] of captured) if (!channel || m.channel_id === channel) remove(key);

    }
    function expire() {
        if (!ttl) return;
        const now = Date.now();
        if (now < nextExpiry) return;
        nextExpiry = Infinity;
        for (const [key, m] of captured) {
            const due = received.get(m) + ttl;
            if (due <= now) remove(key, true);
            else nextExpiry = Math.min(nextExpiry, due);
        }
    }
    function account(message) {
        // Conservative UTF-16 serialized-content budget, plus per-entry overhead.
        // This bounds retained content, not Hermes's total heap or temporary export strings.
        const size = JSON.stringify(message).length * 2 + 256;
        bytes += size - (costs.get(message) || 0); costs.set(message, size);
        while (captured.size > limit || bytes > budget) remove(captured.keys().next().value, true);
    }
    function capture(event) {
        if (!event || typeof event.type !== 'string') return false;
        if (event.type === 'LOGOUT' || event.type === 'ACCOUNT_SWITCH') { clear(); return false; }
        expire();
        if (event.type === 'LOAD_MESSAGES_SUCCESS' && Array.isArray(event.messages)) {
            // Only the last bounded window is useful; don't walk huge historical pages.
            for (const message of event.messages.slice(-limit)) capture({ type: 'MESSAGE_CREATE', message });
        }
        if (event.type === 'MESSAGE_CREATE' && valid(event.message)) {
            const m = event.message, key = keyFor(m);
            if (!captured.has(key)) {
                const mentions = Array.isArray(m.mentions) && m.mentions.length > 0 ? m.mentions.slice(0, 100).map(u => text(u?.id, 64)).filter(Boolean)
                    : (m.content && /<@!?\d+>|@(everyone|here)/.test(m.content) ? ['mentioned'] : []);
                const message = {
                    id: text(m.id, 64), channel_id: text(m.channel_id, 64),
                    author: { id: text(m.author?.id, 64), username: text(m.author?.username, 128) },
                    content: text(m.content), timestamp: text(m.timestamp, 64),
                    attachments: config.captureAttachments === false ? [] : (Array.isArray(m.attachments) ? m.attachments : []).slice(0, 10).map(a => ({ filename: text(a?.filename, 256), url: text(a?.url, 2048) })),
                    edits: [], deleted: false, mentions, ghost_ping: false,
                };
                captured.set(key, message);
                const now = Date.now(); received.set(message, now);
                if (ttl) nextExpiry = Math.min(nextExpiry, now + ttl);
                account(message);
            }
        }
        if (event.type === 'MESSAGE_UPDATE' && valid(event.message)) {
            const old = captured.get(keyFor(event.message));
            if (old && typeof event.message.content === 'string' && event.message.content !== old.content) {
                if (config.antiEdit && editLimit) {
                    old.edits.push({ content: old.content, editedAt: text(event.message.edited_timestamp, 64) || new Date().toISOString() });
                    if (old.edits.length > editLimit) old.edits.shift();
                }
                old.content = text(event.message.content); account(old);
            }
        }
        if (event.type === 'MESSAGE_DELETE' || event.type === 'MESSAGE_DELETE_BULK') {
            const ids = Array.isArray(event.ids) ? event.ids : [event.id];
            const channel = event.channelId || event.channel_id;
            for (const id of ids) {
                const old = captured.get(`${channel}:${id}`);
                if (old) {
                    if (config.ghostPingAlert !== false && old.mentions.length > 0) old.ghost_ping = true;
                    if (config.antiDelete) { old.deleted = true; account(old); } else remove(keyFor(old));
                }
            }
            if (config.antiDelete) {
                const remaining = ids.filter(id => !captured.has(`${channel}:${id}`));
                if (remaining.length === 0) return true;
                if (event.type === 'MESSAGE_DELETE_BULK') event.ids = remaining;
            }
        }
        return false;
    }
    function telemetry(url) {
        if (typeof url !== 'string') return null;
        if (config.noTrack && /^(?:https:\/\/(?:\w+\.)?discord(?:app)?\.com)?\/api\/v\d+\/(?:science|track)(?:[/?]|$)/i.test(url)) return 'blockedAnalytics';
        if (config.blockCrashReports !== false && /^https:\/\/[^/]+\.ingest\.sentry\.io\//i.test(url)) return 'blockedCrashes';
        if (config.silentTyping && /^(?:https:\/\/(?:\w+\.)?discord(?:app)?\.com)?\/api\/v\d+\/channels\/\d+\/typing(?:[/?]|$)/i.test(url)) return 'blockedTyping';
        return null;
    }
    function snapshot(channel, onlyDeleted = false) {
        expire();
        return [...captured.values()].filter(m => (!channel || channel === 'all' || m.channel_id === channel) && (!onlyDeleted || m.deleted)).map(m => ({
            ...m, author: config.redactAuthors ? { id: 'redacted', username: 'redacted' } : { ...m.author },
            attachments: m.attachments.map(a => ({ ...a })), edits: m.edits.map(e => ({ ...e })),
            ghost_ping: Boolean(m.ghost_ping),
        }));
    }
    let attempts = 0, timer, exportBusy = false, exportEpoch = 0;
    const fileModule = () => {
        for (const name of ['NativeFileModule', 'RTNFileManager', 'DCDFileManager']) {
            try {
                const mod = globalThis.__turboModuleProxy?.(name) || globalThis.nativeModuleProxy?.[name];
                if (typeof mod?.writeFile === 'function' && typeof mod?.removeFile === 'function') return mod;
            } catch { /* Try the next supported native module name. */ }
        }
        return null;
    };
    const discardExport = () => { for (const name of ['assault-export.html', 'assault-export.json']) { try { Promise.resolve(fileModule()?.removeFile?.('cache', name)).catch(() => {}); } catch {} } };
    const stopWaiting = () => { if (timer !== undefined) clearInterval(timer); delete globalThis.__assaultPending; };
    const initialize = () => {
        const api = globalThis.vendetta;
        if (!api?.metro?.common?.FluxDispatcher || !api?.commands?.registerCommand || !api?.patcher?.instead) {
            if (++attempts >= 120) { stopWaiting(); console.error('[Hypercord] Native mod API unavailable. Use native controls for safe mode.'); }
            return false;
        }
        stopWaiting();
        const unpatches = [];
        const alert = value => api.metro.common.ReactNative?.Alert?.alert('Hypercord', value);
        let accountControls, runLocal, historyExport;
        const undo = () => { for (const fn of unpatches.reverse()) { try { fn?.(); } catch {} } clear(); };
        try {
            accountControls = globalThis.__ASSAULT_ACCOUNT_CONTROLS__?.(api, config, alert, { run: (...args) => runLocal?.(...args) });
            if (accountControls) unpatches.push(() => accountControls.unload());
            unpatches.push(api.patcher.instead('dispatch', api.metro.common.FluxDispatcher, (args, original) => {
                const event = args[0];
                try {
                    if (event?.type === 'LOGOUT' || event?.type === 'ACCOUNT_SWITCH') { sessionNotes.length = 0; exportEpoch++; clear(); discardExport(); historyExport?.cancel(); }
                    accountControls?.event(event);
                } catch { stats.captureErrors++; }
                try { if (capturing && capture(event)) return; } catch { stats.captureErrors++; }
                return original(...args);
            }));
            if (typeof globalThis.fetch === 'function' && typeof Response === 'function') {
                unpatches.push(api.patcher.instead('fetch', globalThis, (args, original) => {
                    let category;
                    try { category = telemetry(typeof args[0] === 'string' ? args[0] : args[0]?.url); } catch {}
                    if (category) { stats[category]++; return Promise.resolve(new Response(null, { status: 204 })); }
                    return original(...args);
                }));
            }
            historyExport = globalThis.__ASSAULT_HISTORY_EXPORT__?.(api, config, fileModule, globalThis.__ASSAULT_HTML_EXPORT__, alert, () => snapshot(null));
            if (historyExport) unpatches.push(() => historyExport.cancel());
            const exportTranscript = async (ctx, format = 'html', onlyDeleted = false, exportAll = false) => {
                const channel = exportAll ? null : (ctx?.channel?.id || null);
                if (exportBusy) { alert('An export is already being prepared.'); return; }
                const files = fileModule();
                if (!files || (format === 'html' && typeof globalThis.__ASSAULT_HTML_EXPORT__ !== 'function')) { alert('Transcript export is unavailable in this client build.'); return; }
                const epoch = exportEpoch;
                exportBusy = true;
                try {
                    const messages = snapshot(channel, onlyDeleted);
                    const coverage = { source: 'bounded-session-capture', complete: false, evicted: stats.evicted,
                        note: 'Only retained messages are included. Use export-history for paginated server history and known closed DM IDs.' };
                    const payload = format === 'html' ? globalThis.__ASSAULT_HTML_EXPORT__(messages, channel || 'all', coverage)
                        : JSON.stringify({ exportedAt: new Date().toISOString(), channel: channel || 'all', count: messages.length, coverage, messages }, null, 2);
                    await files.writeFile('cache', `assault-export.${format}`, payload, 'utf8');
                    if (epoch !== exportEpoch) { discardExport(); return; }
                    alert(`${format.toUpperCase()} prepared for ${messages.length} retained messages (session capture only). Tap AS → Save ${format.toUpperCase()} transcript to choose a destination.`);
                } catch { discardExport(); alert('Could not prepare transcript. Check available storage, then retry.'); }
                finally { exportBusy = false; }
            };
            const exportMessages = (ctx, deleted = false, all = false) => exportTranscript(ctx, 'html', deleted, all);
            const exportJson = (ctx, all = false) => exportTranscript(ctx, 'json', false, all);
            const privacy = value => {
                const keys = { typing: 'silentTyping', analytics: 'noTrack', crashes: 'blockCrashReports', tokens: 'maskTokens' };
                if (value) {
                    const [feature, state, extra] = value.trim().split(/\s+/);
                    if (!Object.prototype.hasOwnProperty.call(keys, feature) || !['on', 'off'].includes(state) || extra) { alert('Use privacy typing|analytics|crashes|tokens on|off. Changes last this session.'); return; }
                    config[keys[feature]] = state === 'on';
                }
                alert(`Session privacy: typing ${config.silentTyping ? 'blocked' : 'normal'}, analytics ${config.noTrack ? 'blocked' : 'normal'}, crash reports ${config.blockCrashReports !== false ? 'blocked' : 'normal'}, token guard ${config.maskTokens !== false ? 'on' : 'off'}. These controls cover supported JavaScript hooks, not all native traffic.`);
            };
            const captureControl = value => {
                if (value === 'on') capturing = true;
                else if (value === 'off') { capturing = false; exportEpoch++; clear(); discardExport(); historyExport?.cancel(); }
                else if (value && value !== 'status') { alert('Use capture on|off|status. Off clears retained messages and cached transcripts.'); return; }
                alert(`Session capture ${capturing ? 'on' : 'off'}. Restart restores your saved AS settings.`);
            };
            const actions = {
                'export-history': (_ctx, query = '') => historyExport ? historyExport.start(query) : alert('History export module unavailable.'),
                'history-status': () => alert(historyExport?.status() || 'History export module unavailable.'),
                'history-cancel': async () => { if (historyExport && await historyExport.cancel()) alert('History export cancelled and cached archive cleared.'); },
                export: (ctx, all = false) => exportMessages(ctx, false, all),
                'export-all': ctx => exportMessages(ctx, false, true),
                'export-deleted': (ctx, all = false) => exportMessages(ctx, true, all),
                'export-json': ctx => exportJson(ctx, !ctx?.channel?.id),
                'ghost-pings': ctx => {
                    const pings = snapshot(ctx?.channel?.id).filter(message => message.ghost_ping);
                    if (!pings.length) { alert('No retained deleted mentions in this scope. Enable Keep deleted messages to retain them.'); return; }
                    const list = pings.slice(-5).map(g => `[@${g.author.username} in #${g.channel_id}]: ${g.content.slice(0, 100)}`).join('\n\n');
                    alert(`Detected ${pings.length} ghost ping(s) (showing latest ${Math.min(5, pings.length)}):\n\n${list}`);
                },
                search: (ctx, query) => {
                    const term = typeof query === 'string' ? query.trim().slice(0, 200).toLowerCase() : '';
                    if (!term) { alert('Usage: /hypercord action:search query:<text> scope:channel|all'); return; }
                    const matches = snapshot(ctx?.channel?.id).filter(m => m.content.toLowerCase().includes(term));
                    if (!matches.length) { alert('No retained messages match this search.'); return; }
                    const preview = matches.slice(-5).map(m => `[@${m.author.username} in #${m.channel_id}${m.deleted ? ' · [DELETED]' : ''}]: ${m.content.slice(0, 100)}`).join('\n\n');
                    alert(`Found ${matches.length} matching message(s) (showing latest ${Math.min(5, matches.length)}):\n\n${preview}`);
                },
                channels: () => {
                    const counts = new Map();
                    for (const message of snapshot(null)) counts.set(message.channel_id, (counts.get(message.channel_id) || 0) + 1);
                    alert(counts.size ? `Captured channels (${counts.size}; showing up to 20):\n${[...counts].slice(0, 20).map(([id, count]) => `#${id}: ${count}`).join('\n')}` : 'No channels captured this session.');
                },
                mentions: ctx => {
                    const matches = snapshot(ctx?.channel?.id).filter(message => message.mentions.length);
                    alert(matches.length ? `${matches.length} retained message(s) with mentions; latest 5:\n${matches.slice(-5).map(message => `#${message.channel_id} · ${message.author.username}: ${message.content.slice(0, 100)}`).join('\n')}` : 'No retained mentions in this scope.');
                },
                shield: () => { privacy(); alert('Automod rules in the browser apply to the simulator only. Native token protection is best-effort; anti-raid and phishing interception are not installed by this command.'); },
                voice: () => alert('Use Discord’s voice controls to join a channel. The browser voice lounge is a preview; this command does not configure codecs or noise suppression.'),
                notes: (_ctx, value) => {
                    const note = text(value, 4000).trim();
                    if (note) {
                        if (sessionNotes.length >= 100) { alert('Session notebook is full (100 notes). Copy notes before restarting.'); return; }
                        sessionNotes.push(note);
                        alert('Note saved for this session. Notes clear on logout, account switch or restart.');
                    } else alert(sessionNotes.length ? sessionNotes.join('\n\n') : 'No session notes. Use /hypercord action:notes query:<text>.');
                },
                agct: () => alert('Group-chat trap settings are a browser simulation. This command does not rename or purge Discord groups.'),
                wpm: () => alert('Typing speed and typo controls are available in the browser simulator. Native outgoing messages are not altered by these settings.'),
                quests: () => alert('Quest progress in the browser is a local preview. Check actual eligibility, progress and rewards in Discord’s Quests page.'),
                fleet: () => alert('Fleet settings are local browser previews. No additional accounts or voice connections are opened by this command.'),
                ps: () => alert('Open AS → Rich presence to configure a Playing card, then enable the presence profile and restart. Changes apply on the next gateway presence update.'),
                spotify: () => alert('Open AS → Rich presence to configure a Listening card. Custom activity text does not link or authenticate a Spotify account.'),
                stream: () => alert('Open AS → Rich presence to configure a Streaming card and URL. Apply the presence profile and restart.'),
                privacy: (_ctx, value) => privacy(value),
                capture: (_ctx, value) => captureControl(value),
                clear: ctx => { if (ctx?.channel?.id) { exportEpoch++; clear(ctx.channel.id); discardExport(); historyExport?.cancel(); alert('Channel capture and cached transcripts cleared.'); } else alert('Open a channel, or choose clear-all.'); },
                'clear-all': () => { exportEpoch++; clear(); discardExport(); historyExport?.cancel(); alert('All session capture cleared.'); },
                status: () => { expire(); alert(`${captured.size}/${limit} messages · ${Math.ceil(bytes / 1024)}/${budget / 1024} KiB content budget\n${stats.evicted} evicted · ${stats.blockedAnalytics} analytics / ${stats.blockedCrashes} crash / ${stats.blockedTyping || 0} typing requests blocked\n${ghostPings().length} retained ghost pings · ${stats.captureErrors} capture errors\n${accountControls?.status() || 'Account controls unavailable'}`); },
                help: () => alert('Use /hypercord export-history for paginated known-channel archives, history-status or history-cancel. Other actions: export, export-all, export-deleted, export-json, search, channels, mentions, ghost-pings, capture, privacy, clear, clear-all or status. Search and message lists use the current channel unless scope is all. AS → Command guide lists local prefix commands and usage.'),
            };
            runLocal = (name, value, channel) => {
                const ctx = { channel: { id: channel } };
                if (name === 'stats') return actions.status();
                if (name === 'export') {
                    if (value === 'history' || value?.startsWith('history ')) return actions['export-history'](ctx, value.slice(7).trim());
                    if (value === 'status') return actions['history-status']();
                    if (value === 'cancel') return actions['history-cancel']();
                    if (value === 'json') return exportJson(ctx);
                    if (value === 'all') return exportMessages(ctx, false, true);
                    if (value === 'deleted') return exportMessages(ctx, true);
                    if (!value || value === 'html') return exportMessages(ctx);
                    return alert('Use export history [channel IDs]|status|cancel|html|json|deleted|all.');
                }
                if (name === 'clear' && value === 'all') return actions['clear-all']();
                if (Object.prototype.hasOwnProperty.call(actions, name)) return actions[name](ctx, value);
            };
            unpatches.push(api.commands.registerCommand({
                name: 'assault', description: 'Hypercord capture, search, ghost-pings and HTML/JSON export',
                options: [
                    { name: 'action', description: 'Choose a local action', type: 3, required: true,
                        choices: Object.keys(actions).map(name => ({ name, displayName: name, value: name })) },
                    { name: 'query', description: 'Search text or capture/privacy setting', type: 3, required: false },
                    { name: 'scope', description: 'Export, search or message-list scope', type: 3, required: false,
                        choices: [{ name: 'all', displayName: 'All channels', value: 'all' }, { name: 'channel', displayName: 'Current channel', value: 'channel' }] }
                ],
                execute: (args, ctx) => {
                    const action = args?.find(option => option.name === 'action')?.value;
                    const scope = args?.find(option => option.name === 'scope')?.value;
                    const query = args?.find(option => option.name === 'query')?.value;
                    const exportAll = scope === 'all' || action === 'export-all';
                    if (action === 'export-all') return actions['export-all'](ctx);
                    if (action === 'export-json') return exportJson(ctx, exportAll || !ctx?.channel?.id);
                    if (action === 'export') return exportMessages(ctx, false, exportAll);
                    if (action === 'export-deleted') return exportMessages(ctx, true, exportAll);
                    if (['search', 'ghost-pings', 'mentions'].includes(action)) return actions[action](scope === 'all' ? {} : ctx, query);
                    if (action === 'capture' || action === 'privacy' || action === 'export-history') return actions[action](ctx, query);
                    if (Object.prototype.hasOwnProperty.call(actions, action)) return actions[action](ctx, query);
                    return actions.help();
                },
            }));
            globalThis.assault = {
                version: '2.11.2', captured, stats, get retainedBytes() { return bytes; },
                unload: () => { exportEpoch++; discardExport(); undo(); delete globalThis.assault; },
            };
        } catch (error) { undo(); console.error('[Hypercord] Extension registration failed; native Discord continues.', error?.name || 'Error'); }
        return true;
    };
    globalThis.__assaultPending = true;
    if (!initialize()) timer = setInterval(initialize, 500);
})();
