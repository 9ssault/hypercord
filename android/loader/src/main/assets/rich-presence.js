// Build a bounded activity payload from the saved Hypercord presence profile.
// Activity fields follow Discord's gateway activity schema; server/client support varies.
globalThis.__ASSAULT_RICH_PRESENCE__ = (api, saved, notify) => {
    const config = saved && typeof saved === 'object' ? { ...saved } : {};
    const text = (key, max = 128) => typeof config[key] === 'string' ? config[key].trim().slice(0, max) : '';
    const https = value => /^https:\/\/[^\s/@?#]+(?:[/?#][^\s]*)?$/i.test(value) && !/[<>"']/.test(value);
    const epoch = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 && Number(value) <= 8640000000000000 ? Number(value) : undefined;
    const started = Date.now();
    let disabled = false, disposed = false, resolving = false, generation = 0, resolved = {}, assetStatus = 'No images configured';
    const build = () => {
        if (disposed || disabled || config.enabled !== true || !text('name')) return null;
        const type = [0, 1, 2, 3, 5].includes(Number(config.type)) ? Number(config.type) : 0;
        const activity = { name: text('name'), type };
        const appId = text('applicationId', 20);
        if (/^\d{1,20}$/.test(appId)) activity.application_id = appId;
        for (const key of ['details', 'state']) if (text(key)) activity[key] = text(key);
        for (const [key, field] of [['detailsUrl', 'details_url'], ['stateUrl', 'state_url']]) if (https(text(key, 512))) activity[field] = text(key, 512);
        if (type === 1) {
            const stream = text('streamUrl', 512);
            if (!/^https:\/\/(?:www\.)?(?:twitch\.tv|youtube\.com)\//i.test(stream) || !https(stream)) return null;
            activity.url = stream;
        }
        if (config.timestampMode === 'elapsed') activity.timestamps = { start: started };
        if (config.timestampMode === 'today') { const midnight = new Date(started); midnight.setHours(0, 0, 0, 0); activity.timestamps = { start: midnight.getTime() }; }
        if (config.timestampMode === 'custom') {
            const start = epoch(config.startTime), end = epoch(config.endTime);
            if ((start || end) && !(start && end && end <= start)) activity.timestamps = { ...(start ? { start } : {}), ...(end ? { end } : {}) };
        }
        const assets = {};
        for (const size of ['large', 'small']) {
            if (resolved[size]) {
                assets[`${size}_image`] = resolved[size];
                if (text(`${size}Text`)) assets[`${size}_text`] = text(`${size}Text`);
                if (https(text(`${size}Url`, 512))) assets[`${size}_url`] = text(`${size}Url`, 512);
            }
        }
        if (Object.keys(assets).length) activity.assets = assets;
        const labels = [], urls = [];
        for (const number of [1, 2]) if (text(`button${number}Label`, 32) && https(text(`button${number}Url`, 512))) {
            labels.push(text(`button${number}Label`, 32)); urls.push(text(`button${number}Url`, 512));
        }
        if (labels.length) { activity.buttons = labels; activity.metadata = { button_urls: urls }; }
        const current = Number(config.partySize), max = Number(config.partyMax);
        if (Number.isInteger(current) && Number.isInteger(max) && current > 0 && current <= max && max <= 9999) activity.party = { size: [current, max] };
        return activity;
    };
    const refresh = async () => {
        if (disposed || resolving || config.enabled !== true) return;
        resolving = true;
        const currentGeneration = ++generation, next = {};
        let missing = 0, resolver;
        try { resolver = api.metro.findByProps?.('fetchAssetIds'); } catch {}
        try {
            for (const size of ['large', 'small']) {
                const key = text(`${size}Image`, 512);
                if (!key) continue;
                if (/^\d{1,20}$/.test(key)) { next[size] = key; continue; }
                if (!/^\d{1,20}$/.test(text('applicationId', 20)) || typeof resolver?.fetchAssetIds !== 'function') { missing++; continue; }
                try {
                    let timeout;
                    let ids;
                    try {
                        ids = await Promise.race([
                            resolver.fetchAssetIds(text('applicationId', 20), [key]),
                            new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Asset lookup timed out')), 15000); }),
                        ]);
                    } finally { if (timeout !== undefined) clearTimeout(timeout); }
                    if (typeof ids?.[0] === 'string' && /^(?:\d{1,20}|mp:[^\s]{1,500})$/.test(ids[0])) next[size] = ids[0];
                    else missing++;
                } catch { missing++; }
            }
            if (disposed || generation !== currentGeneration) return;
            resolved = next;
            assetStatus = missing ? `${missing} image(s) unavailable; use numeric asset IDs or a compatible asset hook` : Object.keys(next).length ? 'Images resolved' : 'No images configured';
        } finally { resolving = false; }
    };
    void refresh();
    return {
        activity: build,
        status: () => `${build() ? 'Rich presence configured' : 'Rich presence off'} · ${resolving ? 'resolving images' : assetStatus}. Remote visibility must be checked from another client.`,
        command(value) {
            const [action, ...rest] = String(value || 'status').split(/\s+/);
            if (action === 'clear') disabled = true;
            else if (action === 'reset') disabled = false;
            else if (action === 'details' || action === 'state') config[action] = rest.join(' ').slice(0, 128);
            else if (action === 'refresh') { void refresh(); notify('Requested image refresh. Use rpc status to check capability.'); return; }
            else if (action === 'preview') { notify(JSON.stringify(build(), null, 2)); return; }
            else if (action !== 'status') { notify('Use rpc status|preview|refresh|clear|reset|details <text>|state <text>. Restart restores the saved profile.'); return; }
            notify(`${build() ? 'Rich presence ready for the next existing gateway update' : 'Rich presence off'} · ${assetStatus}`);
        },
        reset() { disabled = false; config.details = saved?.details; config.state = saved?.state; },
        unload() { disposed = true; generation++; resolved = {}; },
    };
};
