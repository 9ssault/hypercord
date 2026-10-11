import { message } from '../utils/validation.js';
import { readableColor } from './ui.js';
import { runtimes, scriptValues } from './scripts.js';

export function createScriptScreen(api, manager, bridge, addons) {
  const { React: R, ReactNative: N } = api.metro.common, h = R.createElement;
  const blank = runtime => ({ name: '', runtime, source: '', args: '[]', setup: '', module: 'commonjs', restart: false });
  const draftOf = project => ({ name: project.name, runtime: project.runtime, source: project.source, args: JSON.stringify(project.args), setup: project.setup ?? '', module: project.module ?? 'commonjs', restart: project.restart });
  const active = state => ['starting', 'running', 'stopping', 'unknown'].includes(state);
  const defaults = { bg: '#111318', card: '#20232b', text: '#f2f3f5', muted: '#b5bac6', accent: '#a83349', error: '#ffb0b8' };

  const emptyTheme = { entries: [], selectedTheme: null };
  const subscribeTheme = addons?.subscribe ?? (() => () => {}), snapshotTheme = addons?.snapshot ?? (() => emptyTheme);

  function Button({ label, action, disabled = false, colors: c }) {
    const [focus, setFocus] = R.useState(false);
    return h(N.Pressable, { accessibilityRole: 'button', accessibilityLabel: label, accessibilityState: { disabled }, disabled,
      onPress: action, onFocus: () => setFocus(true), onBlur: () => setFocus(false),
      style: ({ pressed }) => ({ minHeight: 48, padding: 12, justifyContent: 'center', borderRadius: 10, backgroundColor: c.accent, borderWidth: 2, borderColor: focus || pressed ? readableColor(c.accent) : c.accent, opacity: disabled ? 0.5 : 1 }) },
    h(N.Text, { style: { color: readableColor(c.accent), fontSize: 16, fontWeight: '700', textAlign: 'center', flexShrink: 1 } }, label));
  }

  return function ScriptScreen({ navigation } = {}) {
    const data = R.useSyncExternalStore(manager.subscribe, manager.snapshot, manager.snapshot);
    const theme = R.useSyncExternalStore(subscribeTheme, snapshotTheme, snapshotTheme);
    const palette = theme.entries.find(item => item.manifest.id === theme.selectedTheme)?.manifest.colors ?? {};
    const c = { ...defaults, bg: palette.BACKGROUND_PRIMARY ?? defaults.bg, card: palette.BACKGROUND_SECONDARY ?? defaults.card, accent: palette.BRAND_500 ?? defaults.accent };
    c.text = readableColor(c.bg, palette.TEXT_NORMAL ?? defaults.text);
    c.muted = readableColor(c.bg, palette.TEXT_MUTED ?? defaults.muted);
    c.cardText = readableColor(c.card, palette.TEXT_NORMAL ?? defaults.text);
    c.cardMuted = readableColor(c.card, palette.TEXT_MUTED ?? defaults.muted);
    c.error = readableColor(c.bg, defaults.error);
    c.cardError = readableColor(c.card, defaults.error);
    const [runtime, setRuntime] = R.useState('javascript'), [selected, setSelected] = R.useState(null);
    const [draft, setDraft] = R.useState(blank('javascript')), [baseline, setBaseline] = R.useState(blank('javascript'));
    const [pending, setPending] = R.useState(''), [error, setError] = R.useState(''), [notice, setNotice] = R.useState(''), [stdin, setStdin] = R.useState('');
    const locked = R.useRef(false), mounted = R.useRef(false), leaving = R.useRef(false);
    const dirty = JSON.stringify(draft) !== JSON.stringify(baseline), busy = Boolean(pending);
    const project = data.projects.find(item => item.id === selected);
    const text = (value, style = {}) => h(N.Text, { style: { color: c.text, fontSize: 16, ...style } }, value);
    const button = (label, action, disabled = false) => h(Button, { label, action, disabled: busy || disabled, colors: c });
    const input = (label, value, change, options = {}) => h(N.View, { style: { gap: 6 } }, text(label, { color: c.cardMuted }),
      h(N.TextInput, { accessibilityLabel: label, value, onChangeText: change, editable: !busy, accessibilityState: { disabled: busy }, autoCorrect: false, autoCapitalize: 'none', maxLength: 65536,
        style: { minHeight: 48, borderColor: c.muted, borderWidth: 1, borderRadius: 10, padding: 12, backgroundColor: c.bg, color: c.text, fontSize: 16, ...(options.multiline ? { minHeight: 200, textAlignVertical: 'top', fontFamily: 'monospace' } : {}) }, ...options }));
    R.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    async function run(label, action) {
      if (locked.current || !mounted.current) return;
      locked.current = true; setPending(label); setError(''); setNotice('');
      try { await action(); }
      catch (failure) { if (mounted.current) setError(message(failure)); }
      finally { locked.current = false; if (mounted.current) setPending(''); }
    }
    function leave(action) {
      if (locked.current) return;
      if (!dirty) { action(); return; }
      N.Alert.alert('Discard unsaved script changes?', 'Save your project before switching to keep these edits.', [
        { text: 'Keep editing', style: 'cancel' },
        { text: 'Discard', style: 'destructive', onPress: () => { if (mounted.current && !locked.current) action(); } },
      ]);
    }
    R.useEffect(() => {
      const unsubscribe = navigation?.addListener?.('beforeRemove', event => {
        if (leaving.current) { leaving.current = false; return; }
        if (!dirty && !locked.current) return;
        event.preventDefault(); leave(() => { leaving.current = true; navigation.dispatch(event.data.action); });
      });
      const back = N.BackHandler?.addEventListener('hardwareBackPress', () => {
        if (locked.current) return true;
        if (!dirty) return false;
        leave(() => { leaving.current = true; navigation?.goBack?.(); }); return true;
      });
      return () => { unsubscribe?.(); back?.remove(); };
    }, [dirty, busy, navigation]);
    R.useEffect(() => {
      if (!project?.run || !active(project.run.state)) return;
      let stopped = false, timer;
      const poll = async () => {
        if (!locked.current) {
          try { await manager.poll(project.id); }
          catch (failure) { if (!stopped && mounted.current) setError(message(failure)); }
        }
        if (!stopped) timer = setTimeout(poll, 4000);
      };
      timer = setTimeout(poll, 4000);
      return () => { stopped = true; clearTimeout(timer); };
    }, [project?.id, project?.run?.state]);
    function open(item, nextRuntime = runtime) {
      setSelected(item?.id ?? null);
      const next = item ? draftOf(item) : blank(nextRuntime);
      setRuntime(next.runtime); setDraft(next); setBaseline(next); setError(''); setNotice(''); setStdin('');
    }
    async function save() {
      scriptValues(draft);
      const savedId = await manager.save(draft, selected);
      if (mounted.current) {
        setSelected(savedId); setBaseline({ ...draft }); setNotice('Project saved.');
      }
      return savedId;
    }
    async function importScript() {
      const result = await bridge.request('importScript');
      const language = /\.py$/i.test(result.filename) ? 'python' : /\.sh$/i.test(result.filename) ? 'shell' : 'javascript';
      if (mounted.current) {
        open(null, language);
        setDraft({ ...blank(language), name: result.filename.replace(/\.[^.]+$/, '').slice(0, 80), source: result.data, module: /\.mjs$/i.test(result.filename) ? 'esm' : 'commonjs' });
      }
    }
    return h(N.KeyboardAvoidingView, { style: { flex: 1, backgroundColor: c.bg }, behavior: N.Platform?.OS === 'ios' ? 'padding' : 'height' },
      h(N.ScrollView, { keyboardShouldPersistTaps: 'handled', keyboardDismissMode: 'on-drag', contentContainerStyle: { padding: 16, paddingBottom: 48, gap: 14 } },
        text('Code runner', { fontSize: 26, fontWeight: '800' }),
        text('Run trusted scripts in Termux. Projects keep their own working directory. Enable execution in Manager → Code runner setup first.', { color: c.muted, lineHeight: 23 }),
        h(N.View, { style: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 } }, ...Object.entries(runtimes).map(([name, label]) => h(N.Pressable, {
          key: name, accessibilityRole: 'tab', accessibilityLabel: label, accessibilityState: { selected: runtime === name, disabled: busy }, disabled: busy,
          onPress: () => leave(() => open(null, name)), style: ({ pressed }) => ({ padding: 14, minHeight: 48, borderRadius: 10, backgroundColor: runtime === name ? c.accent : c.card, borderWidth: 2, borderColor: pressed ? readableColor(runtime === name ? c.accent : c.card) : runtime === name ? c.accent : c.muted }),
        }, text(label, { fontWeight: '700', color: readableColor(runtime === name ? c.accent : c.card) })))),
        busy && h(N.View, { accessibilityLiveRegion: 'polite', accessibilityState: { busy: true }, style: { gap: 8 } }, h(N.ActivityIndicator, { color: c.text }), text(pending)),
        error && h(N.Text, { accessibilityRole: 'alert', accessibilityLiveRegion: 'assertive', style: { color: c.error, fontSize: 16 } }, error),
        notice && h(N.Text, { accessibilityLiveRegion: 'polite', style: { color: c.text } }, notice),
        button('Check runtimes', () => run('Checking Termux…', async () => {
          const result = await manager.check();
          if (mounted.current) setNotice(`Python ${result.python} · Node.js ${result.node ? 'available' : 'missing'} · Bash ${result.bash ? 'available' : 'missing'}`);
        })),
        button('Import script file', () => leave(() => run('Importing script…', importScript))),
        button('New project', () => leave(() => open(null))),
        ...data.projects.filter(item => item.runtime === runtime).map(item => h(N.View, { key: item.id }, button(`Open ${item.name}`, () => leave(() => open(item))))),
        data.projects.every(item => item.runtime !== runtime) && text('No saved projects in this tab. Import a file or write a script below.', { color: c.muted }),
        h(N.View, { style: { padding: 16, borderRadius: 16, backgroundColor: c.card, gap: 12 } },
          text(project ? project.name : 'New project', { fontSize: 21, fontWeight: '700', color: c.cardText }),
          dirty && text('Unsaved changes', { color: c.cardMuted }),
          input('Project name', draft.name, name => setDraft(previous => ({ ...previous, name })), { maxLength: 80 }),
          runtime === 'javascript' && button(`JavaScript mode: ${draft.module === 'esm' ? 'ES modules' : 'CommonJS'}`, () => setDraft(previous => ({ ...previous, module: previous.module === 'esm' ? 'commonjs' : 'esm' }))),
          input('Script source', draft.source, source => setDraft(previous => ({ ...previous, source })), { multiline: true }),
          input('Arguments (JSON array)', draft.args, args => setDraft(previous => ({ ...previous, args }))),
          input('Setup command (optional)', draft.setup, setup => setDraft(previous => ({ ...previous, setup })), { multiline: true, maxLength: 8192 }),
          text('For dependencies, use a command such as npm install <package> or python -m pip install <package>. Setup runs only when you tap Run setup, in this project’s working directory.', { color: c.cardMuted, fontSize: 14 }),
          h(N.View, { style: { flexDirection: 'row', gap: 12, alignItems: 'center' } }, text('Restart on client launch', { flex: 1, color: c.cardText }), h(N.Switch, {
            accessibilityLabel: 'Restart on client launch', accessibilityState: { checked: draft.restart, disabled: busy }, value: draft.restart, disabled: busy,
            onValueChange: restart => setDraft(previous => ({ ...previous, restart })), trackColor: { false: c.muted, true: c.accent },
          })),
          text('Opt-in restart checks the previous run first. Safe mode pauses automatic starts. JavaScript uses Node.js with the selected module mode; Python runs unbuffered; Shell uses Bash. Scripts have Termux file and network access.', { color: c.cardMuted, fontSize: 14, lineHeight: 21 }),
          button('Save project', () => run('Saving project…', save)),
          button('Run setup', () => run('Starting setup…', async () => { const projectId = await save(); await manager.run(projectId, true); }), active(project?.run?.state) || !draft.setup.trim()),
          button('Save and run', () => run('Starting script…', async () => { const projectId = await save(); await manager.run(projectId); if (mounted.current) setNotice('Launch submitted. Status appears below.'); }), active(project?.run?.state)),
          project && button('Remove project', () => N.Alert.alert('Remove project?', 'Export first to keep its source. Files generated inside Termux remain in its project directory.', [
            { text: 'Cancel', style: 'cancel' }, { text: 'Remove', style: 'destructive', onPress: () => run('Removing project…', async () => { await manager.remove(project.id); if (mounted.current) open(null); }) },
          ]), active(project?.run?.state))),
        project?.run && h(N.View, { style: { padding: 16, backgroundColor: c.card, borderRadius: 16, gap: 12 } },
          text(`${project.run.phase === 'setup' ? 'Setup' : 'Run'}: ${project.run.state}${project.run.exitCode == null ? '' : ` · exit ${project.run.exitCode}`}`, { fontWeight: '700', color: c.cardText }),
          project.run.error && text(project.run.error, { color: c.cardError }),
          button('Refresh status', () => run('Refreshing run…', () => manager.poll(project.id))),
          button('Stop script', () => run('Requesting stop…', async () => { await manager.control(project.id, 'stop'); await manager.poll(project.id); }), !['running', 'stopping'].includes(project.run.state)),
          h(N.Text, { selectable: true, accessibilityLabel: 'Console output', style: { fontFamily: 'monospace', color: c.text, fontSize: 13, backgroundColor: c.bg, padding: 12 } }, project.run.console || 'No output yet.'),
          text('Showing the latest 16 KiB. Console storage rotates at 1 MiB; write project files for full program output.', { color: c.cardMuted, fontSize: 13 }),
          input('Standard input', stdin, setStdin, { maxLength: 1000 }),
          button('Send input', () => run('Sending input…', async () => { await manager.control(project.id, 'input', `${stdin}\n`); if (mounted.current) { setStdin(''); setNotice('Input queued for the script.'); } }), project.run.state !== 'running')),
        button('Export script projects', () => run('Saving and verifying backup…', async () => { await bridge.request('export', { data: await manager.export() }); if (mounted.current) setNotice('Script backup saved and verified. Includes sources, arguments, preferences and last saved run output; Termux-generated files are separate.'); })),
        button('Restore script projects', () => leave(() => run('Restoring scripts…', async () => { await manager.restore((await bridge.request('restore')).data); if (mounted.current) { open(null); setNotice('Projects restored. Automatic restart is off until you enable it.'); } })))));
  };
}
