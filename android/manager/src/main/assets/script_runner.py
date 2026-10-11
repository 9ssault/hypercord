"""Termux process supervisor. Invoked only through the authenticated Manager broker."""
import base64
import fcntl
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import subprocess
import sys
import time

ROOT = Path.home() / '.local/share/assault-runner'
MAX_LOG = 1024 * 1024


def atomic(path, value):
    temporary = path.with_suffix('.tmp')
    with temporary.open('w', encoding='utf-8') as stream:
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def signal_group(pid, sig):
    try:
        os.killpg(pid, sig)
    except ProcessLookupError:
        # A child may exit after poll() but before the stop signal reaches it.
        pass


def identity(pid):
    try:
        # comm may itself contain spaces or parentheses.
        fields = Path('/proc/%s/stat' % pid).read_text().rsplit(')', 1)[1].split()
        if fields[0] == 'Z':
            return None
        return Path('/proc/sys/kernel/random/boot_id').read_text().strip() + ':' + fields[19]
    except (OSError, IndexError):
        return None


def checked_id(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,80}', value):
        raise ValueError('Invalid project or run identifier.')
    return value


def status(directory):
    path = directory / 'status.json'
    if not path.exists():
        return {'state': 'missing'}
    value = json.loads(path.read_text())
    if value['state'] in ('starting', 'running', 'stopping'):
        reservation = directory / 'owner.lock'
        if reservation.exists():
            with reservation.open('r+b') as owner:
                try:
                    fcntl.flock(owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    return value  # A launcher, supervisor, guard or script still owns this run.
            value['state'] = 'interrupted'
            value['error'] = 'The run owner stopped. You can run this project again.'
            return value
        if value['state'] == 'starting' and not value.get('identity'):
            # An old unowned reservation cannot safely expire: its supervisor may be delayed.
            return value
        alive = value.get('identity') and identity(value.get('pid')) == value['identity']
        if not alive and time.time() - value.get('updated', 0) > 10:
            value['state'] = 'interrupted'
            value['error'] = 'Android or Termux stopped the supervisor. You can run this project again.'
    return value


def command(directory, payload):
    current = status(directory)
    if current['state'] != 'running':
        raise ValueError('The process is not running. Refresh its status.')
    encoded = (json.dumps(payload) + '\n').encode()
    if len(encoded) > 4096:
        raise ValueError('Input is too long.')
    fd = os.open(directory / 'control', os.O_WRONLY | os.O_NONBLOCK)
    try:
        os.write(fd, encoded)  # <= PIPE_BUF: either the whole message or EAGAIN.
    finally:
        os.close(fd)
    return {'queued': True}


def append_log(stream, chunk):
    stream.write(chunk)
    if stream.tell() > MAX_LOG:
        stream.seek(-MAX_LOG // 2, os.SEEK_END)
        tail = stream.read()
        stream.seek(0)
        stream.truncate()
        stream.write(tail)


def supervise(directory, reservation):
    request = json.loads((directory / 'request.json').read_text())
    project = ROOT / 'projects' / checked_id(request['project'])
    project.mkdir(parents=True, exist_ok=True)
    runtime = request['runtime']
    executable, filename = {'javascript': ('node', 'main.cjs'), 'python': ('python', 'main.py'), 'shell': ('bash', 'main.sh')}[runtime]
    if runtime == 'javascript' and request.get('module') == 'esm':
        filename = 'main.mjs'
    executable = shutil.which(executable)
    child = None
    state = {'state': 'starting', 'pid': os.getpid(), 'identity': identity(os.getpid()), 'updated': time.time()}
    selector = selectors.DefaultSelector()
    stopping = False
    kill_at = None
    log = None
    control = None
    guard = None
    guard_write = None
    try:
        if not executable:
            raise ValueError('Runtime missing. In Termux run: pkg install python nodejs bash')
        source = request['source']
        if not isinstance(source, str) or not source.strip() or len(source.encode()) > 65536:
            raise ValueError('Use a nonempty script of at most 64 KiB.')
        target = project / filename
        # Replace the directory entry instead of following a script-created symlink.
        temporary = project / ('.source-' + checked_id(request['run']))
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            stream.write(source)
        os.replace(temporary, target)
        log = (directory / 'console.log').open('w+b', buffering=0)
        os.mkfifo(directory / 'control', 0o600)
        control = os.open(directory / 'control', os.O_RDWR | os.O_NONBLOCK)
        selector.register(control, selectors.EVENT_READ, 'control')
        child = subprocess.Popen([executable, str(target), *request.get('args', [])], cwd=project,
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 start_new_session=True, pass_fds=(reservation,), env={**os.environ, 'PYTHONUNBUFFERED': '1'})
        # A separate guard observes EOF even if Android kills this supervisor with SIGKILL.
        # This prevents a lost supervisor from leaving its script process group behind.
        guard_read, guard_write = os.pipe()
        guard_code = "import os,signal,sys; fd=int(sys.argv[1]); group=int(sys.argv[2]); os.read(fd,1);\ntry: os.killpg(group,signal.SIGKILL)\nexcept ProcessLookupError: pass"
        try:
            guard = subprocess.Popen([sys.executable, '-c', guard_code, str(guard_read), str(child.pid)],
                                     pass_fds=(guard_read, reservation), stdin=subprocess.DEVNULL,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        finally:
            os.close(guard_read)
        os.set_blocking(child.stdout.fileno(), False)
        os.set_blocking(child.stdin.fileno(), False)
        selector.register(child.stdout, selectors.EVENT_READ, 'output')
        state.update(state='running', updated=time.time())
        atomic(directory / 'status.json', state)
        pending = b''
        while child.poll() is None:
            for key, _ in selector.select(0.1):
                if key.data == 'output':
                    chunk = os.read(child.stdout.fileno(), 8192)
                    if chunk:
                        append_log(log, chunk)
                    else:
                        selector.unregister(child.stdout)
                else:
                    pending += os.read(control, 8192)
                    while b'\n' in pending:
                        line, pending = pending.split(b'\n', 1)
                        item = json.loads(line)
                        if item.get('operation') == 'stop':
                            stopping = True
                            if kill_at is None:
                                signal_group(child.pid, signal.SIGTERM)
                                kill_at = time.monotonic() + 2
                                state.update(state='stopping', updated=time.time())
                                atomic(directory / 'status.json', state)
                        elif item.get('operation') == 'input' and not stopping:
                            try:
                                os.write(child.stdin.fileno(), item['data'].encode())
                            except (BrokenPipeError, BlockingIOError):
                                append_log(log, b'\n[Input not delivered: stdin is closed or full. Retry after the script reads input.]\n')
            if kill_at is not None and time.monotonic() >= kill_at:
                signal_group(child.pid, signal.SIGKILL)
                kill_at = None
        # Close descendants too; completed scripts cannot retain hidden background jobs.
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        # Drain bytes buffered before exit (including immediate print-and-exit programs).
        while True:
            try:
                chunk = os.read(child.stdout.fileno(), 8192)
            except BlockingIOError:
                break
            if not chunk:
                break
            append_log(log, chunk)
        state.update(state='stopped' if stopping else 'exited', exitCode=child.wait(), updated=time.time())
    except Exception as error:
        state.update(state='failed', error=str(error)[:240], updated=time.time())
    finally:
        if child is not None:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()
        if guard_write is not None:
            os.close(guard_write)
        if guard is not None:
            guard.wait(timeout=5)
        selector.close()
        if control is not None:
            os.close(control)
        if log is not None:
            log.close()
        atomic(directory / 'status.json', state)


def prune_runs(parent):
    completed = []
    for directory in parent.iterdir():
        if not directory.is_dir() or directory.is_symlink():
            continue
        if status(directory)['state'] in ('exited', 'failed', 'stopped', 'interrupted', 'missing'):
            completed.append(directory)
    # Nine previous completions plus the new run; active runs and project files are preserved.
    completed.sort(key=lambda directory: directory.stat().st_mtime_ns, reverse=True)
    for directory in completed[9:]:
        shutil.rmtree(directory)


def dispatch(request):
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    operation = request['operation']
    if 'sourceBase64' in request:
        encoded = request.pop('sourceBase64')
        if not isinstance(encoded, str) or len(encoded) > 87384:
            raise ValueError('Script exceeds 64 KiB.')
        request['source'] = base64.b64decode(encoded, validate=True).decode('utf-8')
        if len(request['source'].encode()) > 65536:
            raise ValueError('Script exceeds 64 KiB.')
    if operation == 'check':
        return {'python': sys.version.split()[0], 'node': bool(shutil.which('node')), 'bash': bool(shutil.which('bash'))}
    project_id = checked_id(request['project'])
    run_id = checked_id(request['run'])
    directory = ROOT / 'runs' / project_id / run_id
    if operation == 'start':
        if request.get('runtime') not in ('javascript', 'python', 'shell'):
            raise ValueError('Unknown runtime.')
        args = request.get('args', [])
        if not isinstance(args, list) or len(args) > 32 or any(not isinstance(x, str) or len(x) > 2048 or '\0' in x for x in args):
            raise ValueError('Arguments must be an array of at most 32 strings.')
        # Serialize launches across helper invocations; retries with the same ID are idempotent.
        with (ROOT / 'launch.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if directory.exists():
                return status(directory)
            parent = directory.parent
            parent.mkdir(parents=True, exist_ok=True)
            for previous in parent.iterdir():
                if previous.is_dir() and status(previous)['state'] in ('starting', 'running', 'stopping'):
                    raise ValueError('This project already has an active run. Stop it first.')
            prune_runs(parent)
            directory.mkdir(mode=0o700)
            with (directory / 'owner.lock').open('a+b') as owner:
                fcntl.flock(owner, fcntl.LOCK_EX)
                try:
                    atomic(directory / 'request.json', request)
                    atomic(directory / 'status.json', {'state': 'starting', 'updated': time.time()})
                    helper = directory / 'supervisor.py'
                    helper.write_text(SOURCE, encoding='utf-8')
                    with (directory / 'supervisor.log').open('wb') as errors:
                        subprocess.Popen([sys.executable, str(helper), '--supervise', str(directory), str(owner.fileno())],
                                         pass_fds=(owner.fileno(),), stdin=subprocess.DEVNULL,
                                         stdout=errors, stderr=errors, start_new_session=True)
                except Exception as error:
                    atomic(directory / 'status.json', {'state': 'failed', 'error': str(error)[:240], 'updated': time.time()})
                # Close our descriptor without LOCK_UN: the child inherits the same lock.
        return status(directory)
    if operation == 'poll':
        value = status(directory)
        log = directory / 'console.log'
        value['console'] = ''
        if log.exists():
            with log.open('rb') as stream:
                size = os.fstat(stream.fileno()).st_size
                stream.seek(max(0, size - 16384))
                value['console'] = stream.read(16384).decode('utf-8', errors='replace')
                value['truncated'] = size > 16384
        return value
    if operation in ('stop', 'input'):
        return command(directory, {'operation': operation, 'data': request.get('data', '')})
    raise ValueError('Unknown runner operation.')


# SOURCE is supplied by the broker's bootstrap, and saved for detached supervisors.
if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--supervise':
        reservation = int(sys.argv[3])
        try:
            supervise(Path(sys.argv[2]), reservation)
        finally:
            os.close(reservation)
    else:
        try:
            print(json.dumps(dispatch(json.loads(sys.stdin.read(262145)))))
        except Exception as error:
            print(json.dumps({'error': str(error)[:240]}))
