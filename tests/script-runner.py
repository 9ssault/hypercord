import base64
import fcntl
from unittest.mock import patch
import json
import os
from pathlib import Path
import signal
import tempfile
import time
import unittest

SOURCE = Path('android/manager/src/main/assets/script_runner.py').read_text()


class RunnerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = os.environ['HOME']
        os.environ['HOME'] = self.temp.name
        self.module = {'__name__': 'runner_test', 'SOURCE': SOURCE}
        exec(compile(SOURCE, 'script_runner.py', 'exec'), self.module)
        self.dispatch = self.module['dispatch']
        self.root = self.module['ROOT']

    def tearDown(self):
        for path in self.root.glob('runs/*/*/status.json'):
            value = json.loads(path.read_text())
            if value['state'] == 'running':
                try:
                    self.dispatch({'operation': 'stop', 'project': path.parent.parent.name, 'run': path.parent.name})
                except (OSError, ValueError):
                    pass
        time.sleep(.2)
        os.environ['HOME'] = self.home
        self.temp.cleanup()

    def start(self, runtime, source, run='run1', project='project1', args=None):
        return self.dispatch({'operation': 'start', 'project': project, 'run': run,
                              'runtime': runtime, 'source': source, 'args': args or []})

    def poll(self, run='run1', project='project1'):
        return self.dispatch({'operation': 'poll', 'project': project, 'run': run})

    def wait(self, predicate, run='run1', project='project1'):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            value = self.poll(run, project)
            if predicate(value):
                return value
            time.sleep(.04)
        self.fail(str(value))

    def done(self, run='run1', project='project1'):
        return self.wait(lambda value: value['state'] in ('exited', 'failed', 'stopped'), run, project)

    def test_real_node_arguments_and_immediate_output(self):
        self.start('javascript', "console.log('hello', process.argv[2]);", args=[';literal argument'])
        value = self.done()
        self.assertEqual(value['exitCode'], 0)
        self.assertEqual(value['console'], 'hello ;literal argument\n')

    def test_maximum_escaped_source_survives_transport(self):
        source = '#' + '\x01' * 65535
        encoded = base64.b64encode(source.encode()).decode()
        request = {'operation': 'start', 'project': 'project1', 'run': 'run1', 'runtime': 'python', 'sourceBase64': encoded}
        self.assertLess(len(json.dumps(request)), 196608)
        self.dispatch(request)
        self.assertEqual(self.done()['exitCode'], 0)
        self.assertEqual(json.loads((self.root / 'runs/project1/run1/request.json').read_text())['source'], source)
        with self.assertRaises(ValueError):
            self.dispatch({'operation': 'start', 'sourceBase64': 'not-base64'})

    def test_es_modules_allow_import_and_top_level_await(self):
        self.dispatch({'operation': 'start', 'project': 'project1', 'run': 'run1', 'runtime': 'javascript', 'module': 'esm',
                       'source': "import {basename} from 'node:path'; console.log(await Promise.resolve(basename('/a/module')));"})
        value = self.done()
        self.assertEqual(value['exitCode'], 0)
        self.assertEqual(value['console'], 'module\n')

    def test_python_input_and_working_directory_survive_runs(self):
        self.start('python', "print('ready', flush=True)\ntext=input()\nopen('saved.txt','w').write(text)\nprint(text)")
        self.wait(lambda value: 'ready' in value.get('console', ''))
        self.dispatch({'operation': 'input', 'project': 'project1', 'run': 'run1', 'data': 'persisted\n'})
        self.assertIn('persisted', self.done()['console'])
        self.start('python', "print(open('saved.txt').read())", run='run2')
        self.assertEqual(self.done('run2')['console'], 'persisted\n')

    def test_duplicate_start_is_idempotent_and_other_run_rejected(self):
        source = "import time\nprint('ready',flush=True)\ntime.sleep(30)"
        self.start('python', source)
        first = self.wait(lambda value: value['state'] == 'running')
        self.assertEqual(self.start('python', source)['pid'], first['pid'])
        with self.assertRaisesRegex(ValueError, 'already has an active'):
            self.start('python', source, run='run2')
        self.dispatch({'operation': 'stop', 'project': 'project1', 'run': 'run1'})
        self.assertEqual(self.done()['state'], 'stopped')

    def test_stop_signals_tolerate_already_exited_groups(self):
        for sig in (signal.SIGTERM, signal.SIGKILL):
            with patch('os.killpg', side_effect=ProcessLookupError) as send:
                self.module['signal_group'](123, sig)
                send.assert_called_once_with(123, sig)
            with patch('os.killpg', side_effect=PermissionError):
                with self.assertRaises(PermissionError):
                    self.module['signal_group'](123, sig)

    def test_stop_escalates_for_script_ignoring_term(self):
        self.start('python', "import signal,time\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nprint('ready',flush=True)\nwhile True: time.sleep(.1)")
        self.wait(lambda value: 'ready' in value.get('console', ''))
        self.dispatch({'operation': 'stop', 'project': 'project1', 'run': 'run1'})
        self.assertEqual(self.done()['exitCode'], -signal.SIGKILL)

    def test_supervisor_death_stops_the_script_group(self):
        self.start('python', "import os,time\nprint(os.getpid(),flush=True)\ntime.sleep(30)")
        value = self.wait(lambda value: value.get('console', '').strip().isdigit())
        child = int(value['console'].strip())
        os.kill(value['pid'], signal.SIGKILL)
        deadline = time.monotonic() + 4
        while self.module['identity'](child) is not None and time.monotonic() < deadline:
            time.sleep(.04)
        self.assertIsNone(self.module['identity'](child))
        value['updated'] = 0
        self.module['atomic'](self.root / 'runs/project1/run1/status.json', value)
        self.assertEqual(self.poll()['state'], 'interrupted')

    def test_delayed_start_stays_reserved_until_its_owner_releases_the_lock(self):
        directory = self.root / 'runs/project1/delayed'
        directory.mkdir(parents=True)
        self.module['atomic'](directory / 'status.json', {'state': 'starting', 'updated': 0})
        self.assertEqual(self.module['status'](directory)['state'], 'starting', 'unowned legacy reservations do not expire')
        with (directory / 'owner.lock').open('a+b') as owner:
            fcntl.flock(owner, fcntl.LOCK_EX)
            self.assertEqual(self.module['status'](directory)['state'], 'starting')
            with self.assertRaisesRegex(ValueError, 'already has an active'):
                self.start('python', 'print("duplicate")')
        self.assertEqual(self.module['status'](directory)['state'], 'interrupted')
        self.start('python', 'print("recovered")')
        self.assertEqual(self.done()['exitCode'], 0)

    def test_known_spawn_failure_releases_the_reservation(self):
        with patch.object(self.module['subprocess'], 'Popen', side_effect=OSError('spawn denied')):
            value = self.start('python', 'print("never started")')
        self.assertEqual(value['state'], 'failed')
        self.assertIn('spawn denied', value['error'])
        self.start('python', 'print("retry")', run='run2')
        self.assertEqual(self.done('run2')['exitCode'], 0)

    def test_run_retention_preserves_active_runs_and_project_files(self):
        self.root.mkdir(parents=True)
        project = self.root / 'projects/project1'
        project.mkdir(parents=True)
        (project / 'user.txt').write_text('preserve')
        parent = self.root / 'runs/project1'
        for index in range(15):
            directory = parent / ('old%s' % index)
            directory.mkdir(parents=True)
            self.module['atomic'](directory / 'status.json', {'state': 'exited', 'exitCode': 0})
        active = parent / 'active'
        active.mkdir()
        self.module['atomic'](active / 'status.json', {'state': 'running', 'pid': os.getpid(), 'identity': self.module['identity'](os.getpid()), 'updated': time.time()})
        self.module['prune_runs'](parent)
        self.assertTrue(active.exists())
        self.assertEqual(len(list(parent.iterdir())), 10)
        self.assertEqual((project / 'user.txt').read_text(), 'preserve')
        self.module['atomic'](active / 'status.json', {'state': 'exited', 'exitCode': 0})
        self.start('python', 'print("new run")')
        self.assertEqual(self.done()['exitCode'], 0)
        self.assertEqual(len(list(parent.iterdir())), 10)

    def test_shell_failures_and_large_console(self):
        self.start('shell', "printf 'failure\\n' >&2\nexit 7")
        value = self.done()
        self.assertEqual(value['exitCode'], 7)
        self.assertEqual(value['console'], 'failure\n')
        self.start('python', "print('x'*2000000)\nprint('last line')", run='run2')
        value = self.done('run2')
        self.assertTrue(value['truncated'])
        self.assertLessEqual(len(value['console']), 16384)
        self.assertTrue(value['console'].endswith('last line\n'))
        self.assertLessEqual((self.root / 'runs/project1/run2/console.log').stat().st_size, 1048576)

    def test_invalid_source_arguments_paths_and_interrupted_identity(self):
        with self.assertRaises(ValueError):
            self.start('python', 'pass', project='../escape')
        with self.assertRaises(ValueError):
            self.start('python', 'pass', args=['\0'])
        self.start('python', '')
        self.assertEqual(self.done()['state'], 'failed')
        directory = self.root / 'runs/project1/run1'
        self.module['atomic'](directory / 'status.json', {'state': 'running', 'pid': os.getpid(), 'identity': 'wrong-boot', 'updated': 0})
        self.assertEqual(self.poll()['state'], 'interrupted')
        with self.assertRaises(ValueError):
            self.dispatch({'operation': 'stop', 'project': 'project1', 'run': 'run1'})


if __name__ == '__main__':
    unittest.main()
