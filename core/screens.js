import { message } from '../utils/validation.js';
import { readableColor, settingsDraft } from './ui.js';

export function createScreens(api, manager, bridge) {
  const { React: R, ReactNative: N } = api.metro.common;
  const h = R.createElement;

  function useMounted() {
    const mounted = R.useRef(false);
    R.useEffect(() => {
      mounted.current = true;
      return () => { mounted.current = false; };
    }, []);
    return mounted;
  }

  function Button({ label, action, disabled, background, foreground, isBusy }) {
    const [focused, setFocused] = R.useState(false);
    return h(N.Pressable, {
      accessibilityRole: 'button', accessibilityLabel: label,
      disabled, accessibilityState: { disabled },
      onPress: () => { if (!isBusy()) return action(); },
      onFocus: () => setFocused(true), onBlur: () => setFocused(false),
      style: ({ pressed }) => ({
        minHeight: 48, justifyContent: 'center', padding: 12, borderRadius: 10,
        backgroundColor: background, borderWidth: 2,
        borderColor: focused || pressed ? foreground : background,
        opacity: disabled ? 0.6 : 1,
      }),
    }, h(N.Text, { style: { color: foreground, fontSize: 16, fontWeight: '700', textAlign: 'center', flexShrink: 1 } }, label));
  }

  function Input({ label, value, set, busy, isBusy, colors: c, secure = false, error, numeric = false, maxLength = 2048 }) {
    const [focused, setFocused] = R.useState(false);
    return h(N.View, { style: { gap: 6 } },
      h(N.Text, { style: { color: c.muted, fontSize: 14 } }, label),
      h(N.TextInput, {
        accessibilityLabel: label, accessibilityHint: error || undefined,
        accessibilityState: { disabled: busy }, editable: !busy, value,
        onChangeText: next => { if (!isBusy()) set(next); },
        onFocus: () => setFocused(true), onBlur: () => setFocused(false),
        secureTextEntry: secure, autoCapitalize: 'none', autoCorrect: false,
        keyboardType: numeric ? 'numbers-and-punctuation' : 'default',
        maxLength: secure ? 4096 : maxLength,
        style: { minHeight: 48, borderWidth: focused || error ? 2 : 1, borderColor: readableColor(c.bg, error ? c.error : c.accent), borderRadius: 10, color: readableColor(c.bg, c.text), padding: 12, backgroundColor: c.bg },
      }),
      error && h(N.Text, { accessibilityRole: 'alert', accessibilityLiveRegion: 'polite', style: { color: c.error, fontSize: 14 } }, error));
  }

  function Settings({ entry, busy, isBusy, input, text, button, card, run, onBack, navigation, colors: c }) {
    const [values, setValues] = R.useState(entry.settings);
    const [saved, setSaved] = R.useState(entry.settings);
    const [attempted, setAttempted] = R.useState(false);
    const mounted = useMounted();
    const leaving = R.useRef(false);
    const dirty = Object.keys(entry.manifest.settings).some(name => String(values[name]) !== String(saved[name]));
    const checked = settingsDraft(entry.manifest.settings, values);
    function leave(action = onBack) {
      if (isBusy()) return;
      if (!dirty) { action(); return; }
      N.Alert.alert('Discard unsaved settings?', 'Your changes have not been saved.', [
        { text: 'Keep editing', style: 'cancel' },
        { text: 'Discard changes', style: 'destructive', onPress: () => { if (mounted.current && !isBusy()) action(); } },
      ]);
    }
    R.useEffect(() => {
      const back = N.BackHandler?.addEventListener('hardwareBackPress', () => { leave(); return true; });
      const unsubscribe = navigation?.addListener?.('beforeRemove', event => {
        if (leaving.current) { leaving.current = false; return; }
        if (!dirty && !isBusy()) return;
        event.preventDefault();
        leave(() => { leaving.current = true; navigation.dispatch(event.data.action); });
      });
      return () => { back?.remove(); unsubscribe?.(); };
    }, [dirty, busy, navigation]);
    async function save() {
      if (isBusy()) return;
      setAttempted(true);
      if (Object.keys(checked.errors).length) return;
      const completed = await run(() => manager.configure(entry.manifest.id, checked.values), {
        pending: 'Saving plugin settings…', success: 'Settings saved.', entryId: entry.manifest.id,
      });
      if (completed && mounted.current) {
        setValues(checked.values); setSaved(checked.values); setAttempted(false);
      }
    }
    return card(
      button('Back to plugins', () => leave()),
      text(entry.manifest.name, { fontSize: 24, fontWeight: '800' }),
      dirty && text('Unsaved changes', { color: c.muted }),
      ...Object.entries(entry.manifest.settings).map(([name, field]) => h(N.View, { key: name },
        field.type === 'boolean'
          ? h(N.View, { style: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48 } },
            text(field.label, { flex: 1 }), h(N.Switch, {
              accessibilityLabel: field.label, accessibilityState: { disabled: busy, checked: values[name] },
              value: values[name], disabled: busy, trackColor: { false: '#80848e', true: c.accent },
              onValueChange: value => { if (!isBusy()) setValues(previous => ({ ...previous, [name]: value })); },
            }))
          : input(field.label, String(values[name]), value => setValues(previous => ({ ...previous, [name]: value })), {
            numeric: field.type === 'number', error: attempted ? checked.errors[name] : undefined,
            // Allow one extra character so pasted over-limit strings receive an explicit error.
            maxLength: field.type === 'string' ? 513 : 2048,
          }))),
      Object.keys(entry.manifest.settings).length === 0 && text('This plugin has no configurable settings.'),
      button('Save settings', save));
  }

  function Page({ kind, navigation }) {
    const data = R.useSyncExternalStore(manager.subscribe, manager.snapshot, manager.snapshot);
    const [pending, setPending] = R.useState('');
    const [error, setError] = R.useState(''), [notice, setNotice] = R.useState('');
    const [editing, setEditing] = R.useState(null), [remote, setRemote] = R.useState(false), [backup, setBackup] = R.useState(false);
    const [url, setUrl] = R.useState(''), [checksum, setChecksum] = R.useState(''), [endpoint, setEndpoint] = R.useState(''), [token, setToken] = R.useState('');
    const locked = R.useRef(false), mounted = useMounted();
    const isBusy = () => locked.current;
    const busy = Boolean(pending);
    const current = data.entries.find(e => e.manifest.id === data.selectedTheme)?.manifest.colors ?? {};
    const c = {
      bg: current.BACKGROUND_PRIMARY ?? '#1e1f22', card: current.BACKGROUND_SECONDARY ?? '#2b2d31',
      text: current.TEXT_NORMAL ?? '#f2f3f5', muted: current.TEXT_MUTED ?? '#b5bac1', accent: current.BRAND_500 ?? '#5865f2',
    };
    c.text = readableColor(c.card, c.text); c.muted = readableColor(c.card, c.muted);
    c.error = readableColor(c.card, '#ffb0b8');
    const text = (value, style = {}) => h(N.Text, { style: { color: c.text, fontSize: 16, flexShrink: 1, ...style } }, value);
    const card = (...children) => h(N.View, { style: { backgroundColor: c.card, borderRadius: 16, padding: 18, marginBottom: 14, gap: 12 } }, ...children);
    const button = (label, action, danger = false) => {
      const background = danger ? '#783044' : c.accent;
      return h(Button, { label, action, disabled: busy, background, foreground: readableColor(background), isBusy });
    };
    const input = (label, value, set, options = {}) => h(Input, { label, value, set, busy, isBusy, colors: c, ...options });
    async function run(action, { pending: progress, success = '', entryId } = {}) {
      if (locked.current || !mounted.current) return false;
      locked.current = true;
      setPending(progress || 'Working…'); setError(''); setNotice('');
      try {
        await action();
        if (mounted.current) {
          const failure = entryId && manager.snapshot().entries.find(e => e.manifest.id === entryId)?.error || (entryId && manager.startupErrors?.[entryId]);
          if (failure) setError(`${success ? `${success} ` : ''}Plugin is disabled: ${failure}`);
          else setNotice(success);
        }
        return true;
      } catch (e) {
        if (mounted.current) setError(message(e));
        return false;
      } finally {
        locked.current = false;
        if (mounted.current) setPending('');
      }
    }
    async function install(result, origin) {
      await manager.install(result.data, result.filename, origin);
    }
    function confirmRemove(entry) {
      N.Alert.alert(`Remove ${entry.manifest.name}?`, 'Its saved settings and state will be deleted. Export a backup first if you need them.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => run(() => manager.remove(entry.manifest.id), { pending: 'Removing addon…', success: 'Addon removed.' }) },
      ]);
    }
    const selected = data.entries.find(e => e.manifest.id === editing);
    const controls = selected
      ? h(Settings, { key: selected.manifest.id, entry: selected, busy, isBusy, input, text, button, card, run, colors: c, navigation, onBack: () => setEditing(null) })
      : h(R.Fragment, null,
        card(text(kind === 'plugin' ? 'Your plugins' : 'Your themes', { fontSize: 24, fontWeight: '800' }),
          text(kind === 'plugin' ? 'Add trusted extensions. Each plugin has its own settings and private saved state.' : 'Personalize Discord with a saved palette. Select a theme to apply it immediately.', { color: c.muted, lineHeight: 22 }),
          button('Import JavaScript file', () => run(async () => install(await bridge.request('import'), 'local'), { pending: 'Importing addon… Choose a file to continue.', success: 'Addon installed. Activate it from its library.' })),
          button(remote ? 'Close remote installer' : 'Install from HTTPS URL', () => setRemote(!remote)),
          remote && h(N.View, { style: { gap: 12 } }, input('Direct HTTPS URL', url, setUrl), input('Publisher SHA-256 checksum', checksum, setChecksum),
            button('Download and validate', () => run(async () => install(await bridge.request('download', { url, sha256: checksum }), url), { pending: 'Downloading and validating addon…', success: 'Download verified and addon installed.' })))),
        kind === 'theme' && button(data.selectedTheme ? 'Use Discord default theme' : 'Discord default theme is active', () => run(() => manager.selectTheme(null), { pending: 'Restoring Discord theme…', success: 'Discord default theme applied.' })),
        ...data.entries.filter(e => e.manifest.kind === kind).map(entry => h(N.View, { key: entry.manifest.id }, card(
          text(entry.manifest.name, { fontSize: 20, fontWeight: '700' }), text(`Version ${entry.manifest.version}`, { color: c.muted, fontSize: 13 }),
          entry.manifest.description && text(entry.manifest.description, { color: c.muted, lineHeight: 22 }),
          text((entry.error || manager.startupErrors?.[entry.manifest.id]) ? 'Needs attention' : kind === 'theme' ? data.selectedTheme === entry.manifest.id ? 'Selected' : 'Available' : entry.enabled ? manager.host.canActivate?.() === false ? 'Paused in safe mode' : 'Active' : 'Inactive', { color: (entry.error || manager.startupErrors?.[entry.manifest.id]) ? c.error : c.muted, fontWeight: '700' }),
          (entry.error || manager.startupErrors?.[entry.manifest.id]) && text(entry.error || manager.startupErrors[entry.manifest.id], { color: c.error }),
          manager.startupErrors?.[entry.manifest.id] && button('Retry plugin activation', () => run(() => manager.enable(entry.manifest.id, true), { pending: 'Retrying plugin activation…', entryId: entry.manifest.id })),
          kind === 'plugin'
            ? h(N.View, { style: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48 } }, text('Enable plugin', { flex: 1 }), h(N.Switch, {
              accessibilityLabel: `Enable ${entry.manifest.name}`, accessibilityState: { checked: entry.enabled, disabled: busy },
              value: entry.enabled, disabled: busy, trackColor: { false: '#80848e', true: c.accent },
              onValueChange: value => run(() => manager.enable(entry.manifest.id, value), { pending: value ? 'Activating plugin…' : 'Deactivating plugin…', entryId: entry.manifest.id }),
            }))
            : h(N.View, { style: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' }, accessibilityLabel: 'Theme color preview' }, ...Object.entries(entry.manifest.colors).map(([name, color]) => h(N.View, { key: name, accessible: true, accessibilityLabel: `${name} ${color}`, style: { width: 32, height: 32, borderRadius: 16, backgroundColor: color, borderWidth: 1, borderColor: c.muted } }))),
          kind === 'theme' && button('Apply theme', () => run(() => manager.selectTheme(entry.manifest.id), { pending: 'Applying theme…', success: 'Theme applied.' })),
          kind === 'plugin' && button('Plugin settings', () => { setError(''); setNotice(''); setEditing(entry.manifest.id); }),
          button('Remove', () => confirmRemove(entry), true)))),
        data.entries.every(e => e.manifest.kind !== kind) && card(text('Your library is empty', { fontWeight: '700' }), text('Import a .js or .txt addon, or install one from its HTTPS address.', { color: c.muted })),
        card(button(backup ? 'Close backup controls' : 'Backup and restore', () => setBackup(!backup)), backup && h(N.View, { style: { gap: 12 } },
          text('Backups include every installed plugin and theme, source, metadata, settings and saved state. Restored addons start disabled.', { color: c.muted, lineHeight: 22 }),
          button('Export complete backup', () => run(async () => bridge.request('export', { data: await manager.export() }), { pending: 'Saving and verifying backup…', success: 'Backup saved and verified.' })),
          button('Restore local backup', () => run(async () => manager.restore((await bridge.request('restore')).data), { pending: 'Reading and restoring backup…', success: 'Backup restored.' })),
          input('Optional cloud backup HTTPS endpoint', endpoint, setEndpoint), input('Optional bearer token (not saved)', token, setToken, { secure: true }),
          button('Upload complete backup', () => run(async () => {
            await bridge.request('uploadBackup', { url: endpoint, token, data: await manager.export() });
            if (mounted.current) setToken('');
          }, { pending: 'Uploading backup…', success: 'Server accepted the backup.' })),
          button('Restore cloud backup', () => run(async () => {
            const result = await bridge.request('downloadBackup', { url: endpoint, token });
            await manager.restore(result.data);
            if (mounted.current) setToken('');
          }, { pending: 'Downloading and restoring backup…', success: 'Cloud backup restored.' })))));
    return h(N.KeyboardAvoidingView, { style: { flex: 1, backgroundColor: c.bg }, behavior: N.Platform?.OS === 'ios' ? 'padding' : 'height' },
      h(N.ScrollView, { style: { flex: 1 }, contentContainerStyle: { padding: 16, paddingBottom: 48, gap: 12 }, keyboardShouldPersistTaps: 'handled', keyboardDismissMode: 'on-drag' },
        busy && h(N.View, { accessibilityLiveRegion: 'polite', accessibilityState: { busy: true }, style: { flexDirection: 'row', alignItems: 'center', gap: 12 } },
          h(N.ActivityIndicator, { color: readableColor(c.bg, c.accent) }), text(pending, { flex: 1, color: readableColor(c.bg, c.text) })),
        (error || manager.themeError) && card(h(N.Text, { accessibilityRole: 'alert', accessibilityLiveRegion: 'assertive', style: { color: c.error, fontSize: 16 } }, error || manager.themeError)),
        notice && h(N.Text, { accessibilityLiveRegion: 'polite', style: { color: readableColor(c.bg, c.text), fontSize: 16 } }, notice), controls));
  }
  return { plugin: props => h(Page, { ...props, kind: 'plugin' }), theme: props => h(Page, { ...props, kind: 'theme' }) };
}
