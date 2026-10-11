// language: JavaScript, file: plugins/sandbox.js
//
// The addon interpreter. An addon is *data*: its source is tokenised, parsed and
// walked here, and it is never handed to eval, Function, require or any other
// evaluator - not even a valid one. What that buys is a hook that can only do the
// four things the contract whitelists (`api.getSetting`, `api.getState`,
// `api.setState`, `api.notify`), and can only do them with literal data, `const`
// locals, `if`/`else`, `return` and primitive arithmetic: no loops, no imports, no
// functions of its own, no prototype access, no getters, no dynamic code.
//
// The shape callers rely on (plugins/index.js):
//
//   compile(source, filename) -> { manifest, hasHooks, invoke(name, callback) }
//
//   `manifest`  the exported object's data half, as plain JSON-able values;
//   `hasHooks`  whether any lifecycle method was declared, which is how a theme
//               containing code is refused before it is installed;
//   `invoke`    run one lifecycle hook. `callback(method, args)` is called for
//               every `api.<method>(...)` the hook performs, and its return value
//               becomes that call's value - which is how getSetting and getState
//               hand data to the addon, and how the manager collects state writes
//               and notifications into one transaction it can roll back.
//
// Every refusal is a sentence, because these are shown on a card inside Discord: an
// addon that cannot be loaded has to say which construct it used.
//
// The ceilings are the documented ones (docs/addon-framework.md): 64 KiB of UTF-8
// source, 48 levels of nesting, 5,000 visits per hook - plus a bound this file adds
// on what one hook may hand the host, because a declarative language can still
// write `const vN = [vN1, vN1]` and ask the host to serialise two to the power of N
// values from a source of a few hundred bytes.
import { ensure, LIMITS, utf8Size } from '../utils/validation.js';

/** The four calls an addon may make. Anything else is denied. */
const API_METHODS = ['getSetting', 'getState', 'setState', 'notify'];
const API_ONLY = new Set(API_METHODS);

/** The three lifecycle methods, and the only functions an addon may declare. */
const HOOKS = new Set(['onStart', 'onStop', 'onSettingsChanged']);

/** A key that would reach an object's own machinery is not a key. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/** Names an addon cannot use, each refused for its own reason. */
const REFUSED = new Map([
  ['require', 'An addon cannot load modules: require() is not available.'],
  ['import', 'An addon cannot load modules.'],
  ['eval', 'An addon cannot run generated code.'],
  ['Function', 'An addon cannot run generated code.'],
  ['globalThis', 'An addon cannot reach the global object.'],
  ['global', 'An addon cannot reach the global object.'],
  ['window', 'An addon cannot reach the host window.'],
  ['document', 'An addon cannot reach the host document.'],
  ['process', 'An addon cannot reach the host process.'],
  ['this', 'An addon cannot use this.'],
  ['super', 'An addon cannot use inheritance.'],
  ['new', 'An addon cannot construct objects: new is not available.'],
  ['class', 'An addon cannot declare classes.'],
  ['function', 'An addon cannot declare functions; the lifecycle methods are the only ones.'],
  ['async', 'An addon cannot be asynchronous.'],
  ['await', 'An addon cannot be asynchronous.'],
  ['yield', 'An addon cannot use generators.'],
  ['while', 'Loops are not allowed in an addon: while is not available.'],
  ['for', 'Loops are not allowed in an addon: for is not available.'],
  ['do', 'Loops are not allowed in an addon: do is not available.'],
  ['switch', 'An addon cannot use switch; use if and else.'],
  ['case', 'An addon cannot use switch.'],
  ['throw', 'An addon cannot throw; report a problem with api.notify instead.'],
  ['try', 'An addon cannot catch errors; a faulting hook disables the plugin.'],
  ['catch', 'An addon cannot catch errors.'],
  ['finally', 'An addon cannot catch errors.'],
  ['with', 'An addon cannot use with.'],
  ['debugger', 'An addon cannot pause execution.'],
  ['typeof', 'An addon cannot inspect types.'],
  ['instanceof', 'An addon cannot inspect types.'],
  ['delete', 'An addon cannot delete values.'],
  ['void', 'The void operator is not available.'],
]);

/** The documented ceilings, plus the one this file adds for hand-off values. */
const MAX_DEPTH = 48;
const MAX_VISITS = 5000;
const MAX_LEAVES = 4096;
const MAX_VALUE_DEPTH = 32;

const KEYWORDS = new Set(['const', 'let', 'if', 'else', 'return', 'export']);
const THREE_CHAR = ['!==', '==='];
const TWO_CHAR = ['==', '!=', '<=', '>=', '&&', '||'];
const ONE_CHAR = ['+', '-', '*', '/', '%', '=', '<', '>', '!', '(', ')', '[', ']', '{', '}', ',', ':', ';', '?', '.'];

const isPunct = (token, value) => Boolean(token) && token.type === 'punct' && token.value === value;
const isIdentifier = (token) => Boolean(token) && token.type === 'identifier';
const isKeyword = (token, value) => Boolean(token) && token.type === 'keyword' && token.value === value;

/**
 * The source, as tokens. Everything the dialect does not have is refused here, with
 * the construct named, so the parser only ever sees the subset it declares.
 */
function tokenize(source) {
  const tokens = [];
  let index = 0;
  const add = (type, value) => tokens.push({ type, value });
  /** A `/` is a regular expression only where a value could start; elsewhere it divides. */
  const afterValue = () => {
    const last = tokens[tokens.length - 1];
    if (!last) return false;
    if (last.type === 'number' || last.type === 'string' || last.type === 'identifier') return true;
    return last.type === 'punct' && [')', ']', '}'].includes(last.value);
  };

  while (index < source.length) {
    const char = source[index];
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      index += 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      ensure(end !== -1, 'A comment in this addon is never closed.');
      index = end + 2;
      continue;
    }
    if (char === '`') throw new Error('An addon cannot use a template literal; write quoted text.');
    if (source.startsWith('=>', index)) throw new Error('An addon cannot use arrow functions.');
    if (source.startsWith('...', index)) throw new Error('An addon cannot spread values.');
    if (source.startsWith('?.', index)) throw new Error('An addon cannot use optional chaining.');
    if (char === '"' || char === "'") {
      let value = '';
      let cursor = index + 1;
      let closed = false;
      while (cursor < source.length) {
        const current = source[cursor];
        if (current === '\\') {
          const escaped = source[cursor + 1];
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped === undefined ? '' : escaped;
          cursor += 2;
          continue;
        }
        if (current === char) {
          closed = true;
          break;
        }
        value += current;
        cursor += 1;
      }
      ensure(closed, 'A text value in this addon is never closed.');
      add('string', value);
      index = cursor + 1;
      continue;
    }
    if (char >= '0' && char <= '9') {
      const match = /^\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(index));
      ensure(match, 'A number in this addon could not be read.');
      add('number', Number(match[0]));
      index += match[0].length;
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(index));
      const name = match[0];
      if (REFUSED.has(name)) throw new Error(REFUSED.get(name));
      if (KEYWORDS.has(name)) add('keyword', name);
      else if (name === 'true' || name === 'false') add('boolean', name === 'true');
      else if (name === 'undefined') add('undefined', undefined);
      else if (name === 'null') add('null', null);
      else add('identifier', name);
      index += name.length;
      continue;
    }
    if (char === '/') {
      ensure(afterValue(), 'An addon cannot use a regular expression.');
      add('punct', '/');
      index += 1;
      continue;
    }
    const three = source.slice(index, index + 3);
    if (THREE_CHAR.includes(three)) {
      add('punct', three);
      index += 3;
      continue;
    }
    const two = source.slice(index, index + 2);
    if (TWO_CHAR.includes(two)) {
      add('punct', two);
      index += 2;
      continue;
    }
    if (ONE_CHAR.includes(char)) {
      if (['=', '+', '-', '*', '/', '%'].includes(char) && source[index + 1] === '=') {
        throw new Error('An addon cannot assign with ' + char + '=; it may only declare with const.');
      }
      if ((char === '&' || char === '|') && !TWO_CHAR.includes(two)) {
        throw new Error('An addon cannot use bitwise operators.');
      }
      add('punct', char);
      index += 1;
      continue;
    }
    throw new Error('This addon contains a character the interpreter does not accept: "' + char + '".');
  }
  return tokens;
}

/** A recursive-descent parser over those tokens, counting levels as it goes. */
function parse(tokens) {
  let at = 0;
  // The parameter a hook was declared with is the api object, for that hook and no
  // other. It is remembered here so that using it as a value - `const x = api;` - is
  // refused while the addon is being read, not later while it is running: an addon
  // that could be inspected successfully and only fail on activation would be
  // reported as a plugin that is fine until it is switched on.
  let currentApi = null;
  const peek = (offset = 0) => tokens[at + offset];
  const next = () => tokens[at++];
  const fail = (text) => {
    throw new Error(text);
  };
  const depth = (level) => ensure(level <= MAX_DEPTH, 'This addon is nested more deeply than ' + MAX_DEPTH + ' levels.');

  function expect(value) {
    const token = next();
    ensure(isPunct(token, value), 'This addon is missing a "' + value + '".');
    return token;
  }

  /* ---- expressions ---- */

  function primary(level) {
    depth(level);
    const token = peek();
    ensure(token, 'This addon ends in the middle of an expression.');
    if (token.type === 'number' || token.type === 'string') {
      next();
      return { kind: 'value', value: token.value };
    }
    if (token.type === 'boolean' || token.type === 'null' || token.type === 'undefined') {
      next();
      return { kind: 'value', value: token.value };
    }
    if (isPunct(token, '[')) return array(level + 1);
    if (isPunct(token, '{')) return object(level + 1);
    if (isPunct(token, '!') || isPunct(token, '-')) {
      next();
      return { kind: 'unary', operator: token.value, operand: unary(level + 1) };
    }
    if (isPunct(token, '(')) {
      next();
      const inner = expression(level + 1);
      expect(')');
      return inner;
    }
    if (isIdentifier(token)) {
      if (isPunct(peek(1), '.')) {
        // The one member access this dialect has: api.<whitelisted method>(...).
        const method = peek(2);
        ensure(method && API_ONLY.has(method.value), 'API access denied: an addon may only call ' + API_METHODS.join(', ') + '.');
        ensure(isPunct(peek(3), '('), 'API access denied: a method name has to be called, as api.' + method.value + '(...).');
        next();
        next();
        next();
        next();
        const args = [];
        while (!isPunct(peek(), ')')) {
          ensure(peek(), 'An argument list in this addon is never closed.');
          args.push(expression(level + 1));
          if (isPunct(peek(), ',')) next();
          else break;
        }
        expect(')');
        return { kind: 'call', api: token.value, method: method.value, args };
      }
      ensure(token.value !== currentApi, 'The api object cannot be stored or passed along; call its methods instead.');
      if (isPunct(peek(1), '[')) fail('An addon cannot use computed member access.');
      if (isPunct(peek(1), '(')) fail('Only the api\'s own methods may be called: "' + token.value + '" is not a function this addon can run.');
      next();
      return { kind: 'name', name: token.value };
    }
    return fail('This addon contains something the interpreter does not accept.');
  }

  function unary(level) {
    const token = peek();
    if (isPunct(token, '!') || isPunct(token, '-')) {
      next();
      return { kind: 'unary', operator: token.value, operand: unary(level + 1) };
    }
    return primary(level);
  }

  function array(level) {
    expect('[');
    const items = [];
    while (!isPunct(peek(), ']')) {
      ensure(peek(), 'An array in this addon is never closed.');
      items.push(expression(level + 1));
      if (isPunct(peek(), ',')) next();
      else break;
    }
    expect(']');
    return { kind: 'array', items };
  }

  function object(level) {
    depth(level);
    expect('{');
    const entries = [];
    const seen = new Set();
    while (!isPunct(peek(), '}')) {
      const token = peek();
      ensure(token, 'An object in this addon is never closed.');
      let name = null;
      if (isIdentifier(token) || token.type === 'keyword') {
        name = token.value;
        next();
      } else if (token.type === 'string') {
        name = token.value;
        next();
      } else {
        fail('An object in this addon has a property this interpreter cannot read.');
      }
      ensure(!FORBIDDEN_KEYS.has(name), 'A property named "' + name + '" cannot be declared.');
      ensure(!seen.has(name), 'The property "' + name + '" is declared twice.');
      seen.add(name);
      if (isPunct(peek(), '(')) {
        ensure(HOOKS.has(name), 'An addon cannot declare a function called "' + name + '": only ' + Array.from(HOOKS).join(', ') + ' are allowed.');
        entries.push({ name, hook: hookBody(level + 1) });
      } else {
        expect(':');
        entries.push({ name, value: expression(level + 1) });
      }
      if (isPunct(peek(), ',')) next();
      else break;
    }
    expect('}');
    return { kind: 'object', entries };
  }

  /** One lifecycle method: its parameters - the api object, and nothing else. */
  function hookBody(level) {
    expect('(');
    const parameters = [];
    while (!isPunct(peek(), ')')) {
      const token = peek();
      ensure(isIdentifier(token), 'A lifecycle method may only take the api object.');
      parameters.push(token.value);
      next();
      if (isPunct(peek(), ',')) next();
      else break;
    }
    expect(')');
    ensure(parameters.length <= 1, 'A lifecycle method may only take the api object.');
    const api = parameters[0] || null;
    const outer = currentApi;
    currentApi = api;
    try {
      return { api, body: block(level + 1) };
    } finally {
      currentApi = outer;
    }
  }

  function block(level) {
    depth(level);
    expect('{');
    const statements = [];
    while (!isPunct(peek(), '}')) {
      ensure(peek(), 'A block in this addon is never closed.');
      statements.push(statement(level + 1));
    }
    expect('}');
    return statements;
  }

  function statement(level) {
    depth(level);
    const token = peek();
    if (isKeyword(token, 'const') || isKeyword(token, 'let')) {
      next();
      const name = next();
      ensure(isIdentifier(name), 'A declaration in this addon needs a name.');
      ensure(!FORBIDDEN_KEYS.has(name.value), 'A name called "' + name.value + '" cannot be declared.');
      ensure(name.value !== currentApi, 'The api object cannot be shadowed by a declaration.');
      expect('=');
      const value = expression(level + 1);
      if (isPunct(peek(), ';')) next();
      return { kind: 'const', name: name.value, value };
    }
    if (isKeyword(token, 'if')) {
      next();
      expect('(');
      const test = expression(level + 1);
      expect(')');
      const then = statement(level + 1);
      let otherwise = null;
      if (isKeyword(peek(), 'else')) {
        next();
        otherwise = statement(level + 1);
      }
      return { kind: 'if', test, then, otherwise };
    }
    if (isKeyword(token, 'return')) {
      next();
      const value = isPunct(peek(), ';') || isPunct(peek(), '}') ? null : expression(level + 1);
      if (isPunct(peek(), ';')) next();
      return { kind: 'return', value };
    }
    if (isPunct(token, '{')) return { kind: 'block', statements: block(level + 1) };
    const value = expression(level + 1);
    if (isPunct(peek(), ';')) next();
    return { kind: 'expression', value };
  }

  function expression(level) {
    depth(level);
    const test = binary(level, 0);
    if (isPunct(peek(), '?')) {
      next();
      const then = expression(level + 1);
      expect(':');
      const otherwise = expression(level + 1);
      return { kind: 'conditional', test, then, otherwise };
    }
    return test;
  }

  /** Precedence, loosest first: ||, &&, equality, relational, additive, multiplicative. */
  const TIERS = [
    ['||'],
    ['&&'],
    ['===', '!==', '==', '!='],
    ['<', '>', '<=', '>='],
    ['+', '-'],
    ['*', '/', '%'],
  ];

  function binary(level, tier) {
    if (tier >= TIERS.length) return unary(level);
    let left = binary(level, tier + 1);
    for (;;) {
      const token = peek();
      if (!token || token.type !== 'punct' || !TIERS[tier].includes(token.value)) return left;
      next();
      const right = binary(level, tier + 1);
      left = { kind: 'binary', operator: token.value, left, right };
    }
  }

  /* ---- the program: exactly one `export default { ... }` ---- */

  const statements = [];
  while (peek()) {
    if (isKeyword(peek(), 'export')) {
      next();
      const token = next();
      ensure(token && token.value === 'default', 'An addon must use "export default { ... }".');
      statements.push({ kind: 'export', value: object(0) });
      if (isPunct(peek(), ';')) next();
      continue;
    }
    statements.push(statement(0));
  }
  ensure(statements.length === 1 && statements[0].kind === 'export', 'An addon must export exactly one default object.');
  const root = statements[0].value;
  const data = new Map();
  const hooks = new Map();
  for (const entry of root.entries) {
    if (entry.hook) hooks.set(entry.name, entry.hook);
    else data.set(entry.name, entry.value);
  }
  return { data, hooks };
}

/** The data half of the parse tree: literals only, no api, no names. */
function dataOf(tree) {
  const evaluate = (node) => {
    if (node.kind === 'value') return node.value;
    if (node.kind === 'array') return node.items.map(evaluate);
    if (node.kind === 'object') {
      const object = {};
      for (const entry of node.entries) {
        ensure(!entry.hook, 'Only the three lifecycle methods may be functions; the rest of an addon is data.');
        object[entry.name] = evaluate(entry.value);
      }
      return object;
    }
    if (node.kind === 'unary' && node.operator === '-') {
      const inner = evaluate(node.operand);
      ensure(typeof inner === 'number', 'A minus sign here needs a number.');
      return -inner;
    }
    throw new Error('An addon must export plain data: numbers, text, true/false, arrays and objects.');
  };
  const data = {};
  for (const [name, value] of tree.data) data[name] = evaluate(value);
  return data;
}

/**
 * A value on its way to the host, walked and counted. A shared reference is walked
 * every time it is reached, which is the point: `const v = [w, w]` repeated is how a
 * short source asks the host for an enormous structure.
 */
function bounded(value, label) {
  let leaves = 0;
  const walk = (item, level) => {
    ensure(level <= MAX_VALUE_DEPTH, label + ' is nested more deeply than ' + MAX_VALUE_DEPTH + ' levels.');
    if (item === null || typeof item !== 'object') {
      leaves += 1;
      ensure(leaves <= MAX_LEAVES, label + ' has too many values to keep in an addon (' + MAX_LEAVES + ' maximum).');
      return;
    }
    for (const child of Array.isArray(item) ? item : Object.values(item)) walk(child, level + 1);
  };
  walk(value, 0);
  return value;
}

/** Run one hook with the caller's api as the only thing it can reach. */
function run(hook, callback) {
  const locals = new Map();
  let visits = 0;
  const spend = () => {
    visits += 1;
    ensure(visits <= MAX_VISITS, 'This hook did more work than one lifecycle callback may (' + MAX_VISITS + ' steps).');
  };
  /** The api the hook was handed, and never a value of its own. */
  const ours = (node) => !hook.api || node.api === hook.api;

  function evaluate(node) {
    spend();
    switch (node.kind) {
      case 'value':
        return node.value;
      case 'array':
        return node.items.map(evaluate);
      case 'object': {
        const object = {};
        for (const entry of node.entries) {
          ensure(!entry.hook, 'A nested value cannot contain a function.');
          object[entry.name] = evaluate(entry.value);
        }
        return object;
      }
      case 'name': {
        ensure(node.name !== hook.api, 'The api object cannot be stored or passed along; call its methods instead.');
        ensure(locals.has(node.name), 'This addon uses the name "' + node.name + '" before it is declared.');
        return locals.get(node.name);
      }
      case 'unary': {
        const value = evaluate(node.operand);
        if (node.operator === '!') return !value;
        ensure(typeof value === 'number', 'A minus sign here needs a number.');
        return -value;
      }
      case 'binary':
        return arithmetic(node.operator, evaluate(node.left), evaluate(node.right));
      case 'conditional':
        return evaluate(node.test) ? evaluate(node.then) : evaluate(node.otherwise);
      case 'call': {
        ensure(ours(node), 'The api object cannot be stored or passed along; call its methods instead.');
        const args = node.args.map(evaluate);
        for (const arg of args) bounded(arg, 'The value passed to api.' + node.method + '()');
        return callback(node.method, args);
      }
      default:
        throw new Error('This addon contains something the interpreter cannot run.');
    }
  }

  function arithmetic(operator, left, right) {
    if (operator === '===' || operator === '==') return left === right;
    if (operator === '!==' || operator === '!=') return left !== right;
    if (operator === '&&') return left ? right : left;
    if (operator === '||') return left ? left : right;
    if (operator === '<' || operator === '>' || operator === '<=' || operator === '>=') {
      const bothNumbers = typeof left === 'number' && typeof right === 'number';
      const bothText = typeof left === 'string' && typeof right === 'string';
      ensure(bothNumbers || bothText, 'A comparison here needs two numbers or two pieces of text.');
      if (operator === '<') return left < right;
      if (operator === '>') return left > right;
      if (operator === '<=') return left <= right;
      return left >= right;
    }
    if (operator === '+' && typeof left === 'string' && typeof right === 'string') return left + right;
    ensure(typeof left === 'number' && typeof right === 'number', 'Arithmetic in an addon needs numbers.');
    const value =
      operator === '+' ? left + right
        : operator === '-' ? left - right
          : operator === '*' ? left * right
            : operator === '/' ? left / right
              : left % right;
    ensure(Number.isFinite(value), 'This addon calculated a value that is not a finite number.');
    return value;
  }

  function execute(statements) {
    for (const statement of statements) {
      spend();
      if (statement.kind === 'const') {
        locals.set(statement.name, evaluate(statement.value));
        continue;
      }
      if (statement.kind === 'if') {
        if (evaluate(statement.test)) execute([statement.then]);
        else if (statement.otherwise) execute([statement.otherwise]);
        continue;
      }
      if (statement.kind === 'block') {
        execute(statement.statements);
        continue;
      }
      if (statement.kind === 'return') {
        if (statement.value) evaluate(statement.value);
        return;
      }
      evaluate(statement.value);
    }
    return undefined;
  }

  return execute(hook.body);
}

/**
 * Compile one addon. The manifest comes back as data, and `invoke` runs a hook with
 * the caller's api - never the other way round: nothing evaluated here can reach
 * anything the caller did not hand it.
 */
export function compile(source, filename = '') {
  ensure(typeof source === 'string' && source.trim().length > 0, 'This addon is empty, so there is nothing to load.');
  const name = String(filename === undefined || filename === null ? '' : filename);
  // A name that is present and wrong is refused - that is what keeps a .json or a
  // .zip from being read as an addon - but a caller that has no name for the source
  // (validating a string before it has a file) is not importing a wrong one.
  ensure(!name || /\.(txt|js)$/i.test(name), 'An addon is a .txt or .js file; "' + (name || '(no filename)') + '" is neither. Rename it and import it again.');
  const bytes = utf8Size(source);
  ensure(bytes <= LIMITS.source, 'This addon is too large: ' + Math.ceil(bytes / 1024) + ' KiB of text where ' + Math.round(LIMITS.source / 1024) + ' KiB is the limit.');
  const tree = parse(tokenize(source));
  for (const hook of tree.hooks.values()) {
    ensure(hook.api !== null, 'A lifecycle method takes the api object: onStart(api) { ... }.');
  }
  return {
    manifest: dataOf(tree),
    hasHooks: tree.hooks.size > 0,
    invoke(hookName, callback) {
      const hook = tree.hooks.get(String(hookName));
      if (!hook) return undefined;
      ensure(typeof callback === 'function', 'A hook needs an api to call.');
      return run(hook, callback);
    },
    /** What a card can say about the source it accepted. */
    limits: { source: LIMITS.source, depth: MAX_DEPTH, visits: MAX_VISITS, values: MAX_LEAVES },
  };
}

export { MAX_DEPTH, MAX_LEAVES, MAX_VISITS };
