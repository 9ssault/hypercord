import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { requirePython } from './support/toolchain.mjs';
test('Termux helper runs actual Node, Python and Bash processes, bounds output, reconciles and stops', (t) => {
  // What this check drives is the runner that lives on the phone
  // (`android/manager/src/main/assets/script_runner.py`): a POSIX process supervisor built on
  // `fcntl` locks, `os.killpg` and SIGKILL. None of those exist on Windows - `fcntl` is not
  // importable there at all, and the process-group signals are Unix-only - so on Windows this
  // is not a check that failed, it is a check that cannot exist. It is skipped with the reason
  // written down rather than failed with `ModuleNotFoundError: No module named 'fcntl'`, which
  // says nothing about the code; the Linux job in CI is where it runs, against the same file.
  if (process.platform === 'win32') {
    t.skip('the Termux helper is POSIX-only: fcntl, killpg and SIGKILL do not exist on Windows');
    return;
  }
  // The interpreter comes from the resolver rather than being named: CI has `python3`, a
  // Windows machine that installed Python from python.org has `python` and no alias, and a
  // check that cannot run there is a check nobody runs (see tests/support/toolchain.mjs, and
  // the same resolution in tests/manifest-resources.test.mjs). A machine with neither still
  // fails, with a sentence about the machine rather than `spawnSync python3 ENOENT`.
  const python = requirePython();
  execFileSync(python, ['tests/script-runner.py'], { timeout: 45000, stdio: 'pipe' });
});
