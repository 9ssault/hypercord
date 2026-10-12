// Account controls use the existing client session. No tokens, extra connection or Node runtime.
globalThis.__ASSAULT_ACCOUNT_CONTROLS__ = (api, config, notify, utilities = {}) => {
    const find = (...props) => { try { return api.metro.findByProps?.(...props); } catch { return null; } };
    const cleanPrefix = value => typeof value === 'string' && /^[^\s/@]{1,3}$/.test(value) ? value : '$';
    const profile = ['controls', 'presence'].includes(config.accountProfile) ? config.accountProfile : 'off';
    const activityTypes = { playing: 0, listening: 2, watching: 3, competing: 5 };
    const validEmoji = value => typeof value === 'string' && value.length > 0 && value.length <= 32 && !/[<>\s]/.test(value);
    const parseChannels = value => {
        if (!value || value === 'all') return [];
        const ids = String(value).split(',').map(id => id.trim());
        if (ids.length > 20 || ids.some(id => !/^\d{1,20}$/.test(id))) return null;
        return [...new Set(ids)];
    };
    let enabled = profile !== 'off', prefix = cleanPrefix(config.commandPrefix), reacting = config.selfReaction === true;
    let emoji = validEmoji(config.reactionEmoji) ? config.reactionEmoji : '🔥';
    let interval = Math.max(10, Math.min(300, Number(config.reactionIntervalSeconds) || 10));
    let channels = parseChannels(config.reactionChannels) || [];
    // undefined uses the saved profile; null explicitly keeps Discord's own value.
    let dynamicActivity, dynamicStatus;
    let cooldown = 0, stopped = false;
    const seen = new Set(), unpatches = [];
    const userStore = profile === 'off' ? null : find('getCurrentUser');
    const reactions = profile === 'off' ? null : find('addReaction', 'removeReaction');
    const socket = profile === 'presence' ? globalThis.WebSocket?.prototype : null;
    const originalSend = socket?.send;
    const presenceAvailable = typeof originalSend === 'function';
    const rich = profile === 'presence' && config.richPresence?.enabled === true ? globalThis.__ASSAULT_RICH_PRESENCE__?.(api, config.richPresence, notify) : null;
    const report = () => `Profile: ${profile}\nControls: ${enabled ? 'on' : 'paused'}\nPrefix: ${prefix}\nOwn-message reactions: ${reacting ? emoji : 'off'} · ${interval}s minimum${reactions ? '' : ' (hook unavailable)'}\nReaction channels: ${channels.join(', ') || 'all'}\nPresence hook: ${presenceAvailable ? 'available; next gateway presence update' : 'unavailable'}\nStatus override: ${dynamicStatus === undefined ? config.presenceStatus || 'unchanged' : dynamicStatus || 'unchanged'}\nActivity: ${dynamicActivity === undefined ? config.activityName || 'unchanged' : dynamicActivity?.name || 'unchanged'}`;
    const presenceOnly = () => {
        if (profile !== 'presence' || !presenceAvailable) { notify('Select Controls + custom presence and restart. This client must expose the presence hook.'); return false; }
        return true;
    };
    const actions = {
        help: () => notify('Local commands: help, status, id, stop, start, prefix <1–3 characters>, react on|off|emoji <emoji>|interval <10–300>|channels <IDs|all>, activity <playing|listening|watching|competing> <name>, activity clear|reset, status_override online|idle|dnd|invisible|clear|reset. Rich presence: rpc status|preview|refresh|clear|reset|details <text>|state <text>. Message tools: search <text>, export history [channel IDs]|status|cancel|html|json|deleted|all, clear [all], channels, mentions, stats, capture on|off|status, privacy [typing|analytics|crashes|tokens on|off]. AS → Command guide has details.'),
        status: () => notify(report()),
        id: (_value, channel) => notify(`Your user ID: ${userStore?.getCurrentUser?.()?.id || 'unavailable'}\nChannel ID: ${channel || 'unavailable'}`),
        stop: () => { enabled = false; notify('Reactions and presence paused. Local message utilities remain available.'); },
        start: () => { enabled = profile !== 'off'; notify(enabled ? 'Account controls enabled.' : 'Select an account profile in AS settings first.'); },
        prefix: value => {
            if (value && cleanPrefix(value) === value) { prefix = value; notify(`Session prefix: ${prefix}`); }
            else notify('Use 1–3 characters without spaces, / or @. Permanent defaults are in AS settings.');
        },
        react: value => {
            if (value === 'on' || value === 'off') reacting = value === 'on';
            else if (value.startsWith('emoji ')) {
                const next = value.slice(6).trim();
                if (!validEmoji(next)) { notify('Use one Unicode emoji without spaces or custom-emoji markup.'); return; }
                emoji = next;
            } else if (value.startsWith('interval ')) {
                const next = Number(value.slice(9));
                if (!Number.isInteger(next) || next < 10 || next > 300) { notify('Reaction interval must be 10–300 seconds.'); return; }
                interval = next;
                cooldown = Math.max(cooldown, Date.now() + interval * 1000);
            } else if (value.startsWith('channels ')) {
                const next = parseChannels(value.slice(9).trim());
                if (!next) { notify('Use up to 20 channel IDs separated by commas, or all.'); return; }
                channels = next;
            } else if (value) { notify('Use react on|off, emoji <emoji>, interval <10–300>, or channels <IDs|all>.'); return; }
            notify(`Own-message reactions: ${reacting ? emoji : 'off'} · ${interval}s · channels ${channels.join(', ') || 'all'}. Changes last this session.`);
        },
        rpc: value => { if (!presenceOnly()) return; if (rich) rich.command(value); else notify('Create and enable a card in AS → Rich presence, then restart the client.'); },
        activity: value => {
            if (!presenceOnly()) return;
            if (value === 'clear' || value === 'reset') {
                dynamicActivity = value === 'clear' ? null : undefined;
                notify(value === 'clear' ? 'Activity override disabled; Discord activities pass through on the next update.' : 'Saved activity default restored on the next update.'); return;
            }
            const [type, ...parts] = value.split(/\s+/);
            const name = parts.join(' ').trim();
            if (!Object.prototype.hasOwnProperty.call(activityTypes, type) || !name || name.length > 128) { notify('Use activity playing|listening|watching|competing <name up to 128 characters>, clear or reset.'); return; }
            dynamicActivity = { name, type: activityTypes[type] };
            notify(`Activity set for the next presence update: ${name}`);
        },
        status_override: value => {
            if (!presenceOnly()) return;
            if (value === 'clear' || value === 'reset') dynamicStatus = value === 'clear' ? null : undefined;
            else if (['online', 'idle', 'dnd', 'invisible'].includes(value)) dynamicStatus = value;
            else { notify('Use status_override online|idle|dnd|invisible|clear|reset.'); return; }
            notify('Status override changed for the next client presence update.');
        },
    };
    for (const name of ['search', 'export', 'clear', 'channels', 'mentions', 'stats', 'capture', 'privacy']) {
        actions[name] = (value, channel) => {
            if (typeof utilities.run === 'function') return utilities.run(name, value, channel);
            notify('Message tools are unavailable in this client session. Restart the client and retry.');
            return false;
        };
    }
    const messages = find('sendMessage', 'sendBotMessage');
    if (messages) unpatches.push(api.patcher.instead('sendMessage', messages, (args, original) => {
        const content = args[1]?.content;
        if (!stopped && typeof content === 'string') {
            if (profile !== 'off' && content.startsWith(prefix)) {
                const [name, ...parts] = content.slice(prefix.length).trim().split(/\s+/);
                if (Object.prototype.hasOwnProperty.call(actions, name)) {
                    try { return Promise.resolve(actions[name](parts.join(' '), args[0])).catch(() => notify('Local command failed. Use AS → Command guide or restart the client.')); }
                    catch { notify('Local command failed. Use AS → Command guide or restart the client.'); return Promise.resolve(); }
                }
            }
            if (config.maskTokens !== false && /(?:\bmfa\.[A-Za-z0-9_-]{20,}|\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{25,110}\b|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----)/.test(content)) {
                notify('Message blocked: it appears to contain a Discord token or private key. Remove the secret before sending. Detection is best-effort; other secret formats may not be recognized.');
                return Promise.resolve();
            }
        }
        return original(...args);
    }));
    let wrappedSend;
    if (presenceAvailable) {
        wrappedSend = function (data, ...rest) {
            if (!stopped && enabled && typeof data === 'string' && /^wss:\/\/gateway(?:-[a-z0-9-]+)?\.discord\.gg(?:[/?]|$)/i.test(this.url || '')) {
                try {
                    const frame = JSON.parse(data);
                    if (frame.op === 3 && frame.d && typeof frame.d === 'object') {
                        const targetStatus = dynamicStatus === undefined ? config.presenceStatus : dynamicStatus;
                        if (['online', 'idle', 'dnd', 'invisible'].includes(targetStatus)) frame.d.status = targetStatus;
                        const act = dynamicActivity === undefined
                            ? (rich ? rich.activity() : (typeof config.activityName === 'string' && config.activityName.trim() ? { name: config.activityName.trim().slice(0, 128), type: Object.values(activityTypes).includes(config.activityType) ? config.activityType : 0 } : null))
                            : dynamicActivity;
                        if (act) frame.d.activities = [act];
                        data = JSON.stringify(frame);
                    }
                } catch { /* Binary/malformed frames and other traffic pass through unchanged. */ }
            }
            return originalSend.call(this, data, ...rest);
        };
        socket.send = wrappedSend;
        unpatches.push(() => { if (socket.send === wrappedSend) socket.send = originalSend; });
    }
    return {
        status: () => `${report()}\nLocal message hook: ${messages ? 'available' : 'unavailable'}\n${rich?.status() || 'Rich presence not configured'}`,
        event(event) {
            if (event?.type === 'LOGOUT' || event?.type === 'ACCOUNT_SWITCH') {
                enabled = false; seen.clear(); rich?.reset(); dynamicActivity = undefined; dynamicStatus = undefined; return;
            }
            if (stopped || !enabled || !reacting || event?.type !== 'MESSAGE_CREATE') return;
            const message = event.message, self = userStore?.getCurrentUser?.()?.id;
            if (!message?.id || !message.channel_id || !self || message.author?.id !== self || seen.has(message.id)) return;
            if (channels.length && !channels.includes(message.channel_id)) return;
            seen.add(message.id); if (seen.size > 500) seen.delete(seen.values().next().value);
            if (!reactions || Date.now() < cooldown) return;
            cooldown = Date.now() + interval * 1000;
            try {
                Promise.resolve(reactions.addReaction(message.channel_id, message.id, { id: null, name: emoji })).catch(error => {
                    const retry = Number(error?.body?.retry_after ?? error?.retry_after);
                    cooldown = Math.max(cooldown, Date.now() + (Number.isFinite(retry) && retry > 0 ? retry * 1000 : 60000));
                });
            } catch { cooldown = Math.max(cooldown, Date.now() + 60000); }
        },
        unload() { stopped = true; enabled = false; seen.clear(); rich?.unload(); for (const undo of unpatches.reverse()) { try { undo(); } catch {} } },
    };
};
