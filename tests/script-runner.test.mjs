import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
test('Termux helper runs actual Node, Python and Bash processes, bounds output, reconciles and stops', () => {
  execFileSync('python3', ['tests/script-runner.py'], { timeout: 45000, stdio: 'pipe' });
});
