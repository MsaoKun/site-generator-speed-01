// Fast drop-in for makefun-site 1.0.0's build (site-generator-speed-01).
// Reimplementation from scratch of the reference semantics in the kit, with
// hand-rolled scanners, an ASCII escape table, batched string output and a
// direct template tree renderer. No state is shared between calls to run().

// ---------------------------------------------------------------- text layer

const ESC = new Array(128).fill(null);
ESC[38] = '&amp;';
ESC[60] = '&lt;';
ESC[62] = '&gt;';
ESC[34] = '&quot;';
ESC[39] = '&#39;';
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const RE_ESC = /[&<>"']/g;

function esc(s) {
  if (s.length >= 80) return s.replace(RE_ESC, (c) => ESC_MAP[c]);
  let out = '', start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 128 && ESC[c] !== null) {
      out += s.slice(start, i) + ESC[c];
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function longDate(d) {
  return (+(d.slice(8, 10))) + ' ' + MONTHS[+(d.slice(5, 7)) - 1] + ' ' + d.slice(0, 4);
}

function slugify(text) {
  let plain = text, ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '', gap = false;
  for (let i = 0; i < plain.length; i++) {
    const cc = plain.charCodeAt(i);
    let keep;
    if (cc >= 65 && cc <= 90) keep = String.fromCharCode(cc + 32);
    else if ((cc >= 97 && cc <= 122) || (cc >= 48 && cc <= 57)) keep = plain[i];
    else { gap = out.length > 0; continue; }
    if (gap) { out += '-'; gap = false; }
    out += keep;
  }
  if (out.length > 64) out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function uniqueSlug(slug, taken) {
  let out = slug, n = 2;
  while (taken.has(out)) out = slug + '-' + n++;
  taken.add(out);
  return out;
}

// -------------------------------------------------------------- front matter

const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const RE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const RE_NAME = /^[a-z0-9-]+$/;
const RE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RE_TAG = /^[^"[\]]+$/;
const RE_TRAIL = /[ \t]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringValue(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) {
      return { error: 'a quoted string is not closed' };
    }
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += n; i++;
      } else if (c === '"') {
        return { error: 'a quoted string holds a stray quote' };
      } else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringValue(raw);
      return 'error' in s ? { error: 'key "' + key + '": ' + s.error } : s;
    }
    case 'date': {
      const m = RE_DATE.exec(raw);
      const y = m ? +m[1] : 0, mo = m ? +m[2] : 0, d = m ? +m[3] : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) {
        return { error: 'key "tags": not a list [a, b]' };
      }
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (let i = 0; i < tags.length; i++) {
        if (tags[i] === '' || !RE_TAG.test(tags[i])) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true }
        : raw === 'false' ? { value: false }
          : { error: 'key "draft": true or false' };
    case 'layout':
      return RE_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return RE_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: 'unknown key "' + key + '"' };
  }
}

function parseFrontMatter(text) {
  const p = text.indexOf('\n');
  if ((p === -1 ? text : text.slice(0, p)) !== '---') return { error: 'no front matter' };

  let pos = p + 1, closeStart = -1, bodyAt = -1;
  const n = text.length;
  while (pos <= n) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? n : nl;
    if (text.slice(pos, end) === '---') { closeStart = pos; bodyAt = nl === -1 ? n : nl + 1; break; }
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };

  const data = {};
  let lineNo = 2;
  pos = p + 1;
  while (pos < closeStart) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? closeStart : Math.min(nl, closeStart);
    const line = text.slice(pos, end);
    pos = nl === -1 || nl >= closeStart ? closeStart + 1 : nl + 1;
    if (line.length === 0 || line.charCodeAt(0) === 35) { lineNo++; continue; }

    let j = 0;
    while (j < line.length) {
      const c = line.charCodeAt(j);
      if ((c >= 97 && c <= 122) || c === 95) j++;
      else break;
    }
    if (j === 0 || line.charCodeAt(j) !== 58) {
      return { error: 'line ' + lineNo + ' is not "key: value"' };
    }
    let raw;
    if (j + 1 === line.length) raw = '';
    else if (line.charCodeAt(j + 1) === 32) raw = line.slice(j + 2);
    else return { error: 'line ' + lineNo + ' is not "key: value"' };
    raw = raw.replace(RE_TRAIL, '');

    const key = line.slice(0, j);
    if (!KEYS.has(key)) return { error: 'unknown key "' + key + '"' };
    if (Object.hasOwn(data, key)) return { error: 'key "' + key + '" is given twice' };
    if (raw === '') return { error: 'key "' + key + '" has no value' };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyAt) };
}

// ------------------------------------------------------------------- markdown

function isBlank(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function trimLine(s) {
  let a = 0, b = s.length;
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === s.length ? s : s.slice(a, b);
}

const RE_FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const RE_FENCE_CLOSE = /^```[ \t]*$/;
const RE_HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const RE_HR = /^(?:---|\*\*\*)[ \t]*$/;
const RE_BULLET = /^[-*] (.*)$/;
const RE_ORDERED = /^(\d{1,9})\. (.*)$/;
const RE_CONT = /^ {2,}\S/;
const RE_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const RE_SPACE = /\s/;

function headingOf(line) {
  const m = RE_HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

function endsParagraph(line) {
  if (isBlank(line)) return true;
  const c = line.charCodeAt(0);
  if (c === 96 && RE_FENCE_OPEN.test(line)) return true;
  if (c === 35 && headingOf(line) !== null) return true;
  if ((c === 45 || c === 42) && RE_HR.test(line)) return true;
  return false;
}

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const RE_TRIG = /[\\`*[]/g;

function findUnescaped(s, what, from) {
  const wl = what.length, L = s.length;
  for (let j = from; j <= L - wl; j++) {
    if (s[j] === '\\' && j + 1 < L && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

function inline(s, link) {
  const L = s.length;
  let out = '', pos = 0;
  RE_TRIG.lastIndex = 0;
  for (;;) {
    const m = RE_TRIG.exec(s);
    if (m === null) break;
    const i = m.index;
    if (i > pos) out += esc(s.slice(pos, i));
    const cc = s.charCodeAt(i);
    if (cc === 92 && i + 1 < L && ESCAPABLE.has(s[i + 1])) {
      out += esc(s[i + 1]); pos = i + 2;
    } else if (cc === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out += '<code>' + esc(s.slice(i + 1, j)) + '</code>'; pos = j + 1;
      } else { out += '`'; pos = i + 1; }
    } else if (cc === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          out += '<strong>' + inline(s.slice(i + 2, j), link) + '</strong>'; pos = j + 2;
        } else { out += '**'; pos = i + 2; }
      } else {
        const j = findSingleStar(s, i + 1);
        if (j > i + 1) {
          out += '<em>' + inline(s.slice(i + 1, j), link) + '</em>'; pos = j + 1;
        } else { out += '*'; pos = i + 1; }
      }
    } else {
      const k = findUnescaped(s, ']', i + 1);
      const mm = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !RE_SPACE.test(target)) {
        out += '<a href="' + esc(link(target)) + '">' + inline(s.slice(i + 1, k), link) + '</a>'; pos = mm + 1;
      } else { out += '['; pos = i + 1; }
    }
    RE_TRIG.lastIndex = pos;
  }
  return out + esc(s.slice(pos));
}

function renderMarkdown(src, link) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  const toc = [];
  let out = '';
  let excerpt = '';
  let haveExcerpt = false;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }

    const fence = line.charCodeAt(0) === 96 ? RE_FENCE_OPEN.exec(line) : null;
    if (fence !== null) {
      const lang = fence[1];
      i++;
      let body = '';
      while (i < n && !RE_FENCE_CLOSE.test(lines[i])) { body += esc(lines[i]) + '\n'; i++; }
      i++;
      const cls = lang === '' ? '' : ' class="language-' + esc(lang) + '"';
      out += '<pre><code' + cls + '>' + body + '</code></pre>\n';
      continue;
    }

    const h = line.charCodeAt(0) === 35 ? headingOf(line) : null;
    if (h !== null) {
      const depth = h.depth, text = h.text;
      const id = uniqueSlug(slugify(text), ids);
      const html = inline(text, link);
      out += '<h' + depth + ' id="' + id + '">' + html + '</h' + depth + '>\n';
      if (depth === 2 || depth === 3) toc.push({ level: depth, id, html });
      i++; continue;
    }

    if ((line.charCodeAt(0) === 45 || line.charCodeAt(0) === 42) && RE_HR.test(line)) { out += '<hr>\n'; i++; continue; }

    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let q = lines[i++];
        q = q.slice(1);
        if (q.charCodeAt(0) === 32) q = q.slice(1);
        body.push(trimLine(q));
      }
      let k = 0;
      while (k < body.length) { if (body[k] === '') body.splice(k, 1); else k++; }
      out += body.length === 0
        ? '<blockquote>\n</blockquote>\n'
        : '<blockquote>\n<p>' + inline(body.join('\n'), link) + '</p>\n</blockquote>\n';
      continue;
    }

    const bullet = RE_BULLET.exec(line);
    const ordered = bullet === null ? RE_ORDERED.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? RE_ORDERED : RE_BULLET;
      const items = [];
      while (i < n) {
        const m = marker.exec(lines[i]);
        if (m !== null) {
          items.push([trimLine(isOrdered ? m[2] : m[1])]);
          i++;
        } else if (RE_CONT.test(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && +ordered[1] !== 1 ? '<ol start="' + (+ordered[1]) + '">' : '<' + tag + '>';
      let list = open + '\n';
      for (let k = 0; k < items.length; k++) list += '<li>' + inline(items[k].join('\n'), link) + '</li>\n';
      out += list + '</' + tag + '>\n';
      continue;
    }

    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), link);
    if (!haveExcerpt) { excerpt = html; haveExcerpt = true; }
    out += '<p>' + html + '</p>\n';
  }
  return { html: out, toc, excerpt };
}

// ------------------------------------------------------------------ templates

class TemplateError extends Error {}

const RE_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const RE_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const RE_IF = /^if (not )?(\S+)$/;
const RE_INCLUDE = /^include "([a-z0-9-]+)"$/;
const RE_HSPACE = /^[ \t]*$/;

function pathOf(name, text) {
  if (!RE_PATH.test(text)) throw new TemplateError('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '', i = 0;
  const L = src.length;
  while (i < L) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === L - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src.charCodeAt(open + 2) === 123;
      const closer = raw ? '}}}' : '}}';
      const close = src.indexOf(closer, open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError('template "' + name + '": a ' + (raw ? '{{{' : '{{') + ' is not closed');
      if (text !== '') { tokens.push({ t: 'text', text }); text = ''; }
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError('template "' + name + '": a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? L : nl;
    const standalone = RE_HSPACE.test(src.slice(lineStart, open)) && RE_HSPACE.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') { tokens.push({ t: 'text', text }); text = ''; }
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? L : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = [];
  const stack = [{ kind: 'root', body: root }];
  let body = root;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = RE_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node); stack.push(node); body = node.body;
      } else if ((m = RE_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], els: null };
        body.push(node); stack.push(node); body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.els !== null) throw new TemplateError('template "' + name + '": an else outside an if');
        top.els = []; body = top.els;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) {
          throw new TemplateError('template "' + name + '": an ' + tag + ' with no open ' + tag.slice(3));
        }
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'if' ? (parent.els ?? parent.then) : parent.body;
      } else if ((m = RE_INCLUDE.exec(tag)) !== null) {
        body.push({ kind: 'include', name: m[1] });
      } else {
        throw new TemplateError('template "' + name + '": {% ' + tag + ' %} is not a tag');
      }
    }
  }
  if (stack.length > 1) throw new TemplateError('template "' + name + '": a ' + stack[stack.length - 1].kind + ' is not closed');
  return root;
}

function lookup(scope, path) {
  let s = scope;
  const first = path[0];
  while (s !== null && !Object.hasOwn(s.vars, first)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[first];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let i = 0; i < v.length; i++) out += (i ? ', ' : '') + textOf(v[i]);
    return out;
  }
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function renderNodes(nodes, scope, ctx, depth) {
  let out = '';
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    switch (n.kind) {
      case 'text': out += n.text; break;
      case 'var': out += esc(textOf(lookup(scope, n.path))); break;
      case 'raw': out += textOf(lookup(scope, n.path)); break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.els;
        if (branch !== null) out += renderNodes(branch, scope, ctx, depth);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          out += renderNodes(n.body, { vars, parent: scope }, ctx, depth);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < 8) out += renderNodes(t, scope, ctx, depth + 1);
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------- build

const RESERVED = ['posts', 'tags', 'page'];

function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function normalizeNewlines(s) {
  return s.indexOf('\r') === -1 ? s : s.replace(/\r\n?/g, '\n');
}

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

function dirOf(path) {
  const k = path.lastIndexOf('/');
  return k === -1 ? '' : path.slice(0, k);
}

function isWs(cc) {
  return cc === 32 || cc === 9 || cc === 10 || cc === 13 || cc === 11 || cc === 12 ||
    cc === 0xfeff || cc === 0xa0 || (cc >= 0x2000 && cc <= 0x200a) ||
    cc === 0x1680 || cc === 0x2028 || cc === 0x2029 || cc === 0x202f ||
    cc === 0x205f || cc === 0x3000;
}

function wordsOf(text) {
  let count = 0, prev = true;
  for (let i = 0; i < text.length; i++) {
    const ws = isWs(text.charCodeAt(i));
    if (!ws && prev) count++;
    prev = ws;
  }
  return count;
}

function ownTags(s) {
  const seen = new Set();
  const out = [];
  const tags = s.data.tags ?? [];
  for (let i = 0; i < tags.length; i++) {
    const sl = slugify(tags[i]);
    if (!seen.has(sl)) { seen.add(sl); out.push(tags[i]); }
  }
  return out;
}

export function run(input) {
  const base = input.site.base_url.replace(/\/+$/, '');
  const report = [];
  const templates = new Map();
  const tnames = Object.keys(input.templates).sort(cmp);
  for (const name of tnames) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (err instanceof TemplateError) report.push(err.message);
      else throw err;
    }
  }

  const files = input.files.slice().sort((a, b) => cmp(a.path, b.path));
  const sources = [], statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: normalizeNewlines(f.content) });
    else statics.push({ path: f.path, content: f.content });
  }

  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if (fm.error !== undefined) { report.push('refused ' + s.path + ': ' + fm.error); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    if (s.path.startsWith('tags/')) { report.push("refused " + s.path + ": tags/ is the generator's own"); continue; }
    if (s.path.startsWith('page/')) { report.push("refused " + s.path + ": page/ is the generator's own"); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push('refused ' + s.path + ': a post needs a date'); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push('refused ' + s.path + ': layout "' + layout + '" is no template that parses'); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push('draft ' + s.path); continue; }
    kept.push(s);
  }
  sources.length = 0;
  for (const s of kept) sources.push(s);

  const taken = new Map();
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) { set = new Set(dir === '' ? RESERVED : []); taken.set(dir, set); }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const srcPath = s.path;
    const link = (target) => {
      if (RE_SCHEME.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return bySource.get(path).url + frag;
      if (path !== null && staticPaths.has(path)) return base + '/' + path + frag;
      broken.add('broken-link ' + srcPath + ' -> ' + target);
      return target;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => cmp(y.data.date, x.data.date) || cmp(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const allTags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmp(x.slug, y.slug));

  const linkOf = (s) => s === null ? null : {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  };
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  for (const s of sources) s.card = cardOf(s);
  const cards = new Map(posts.map((p) => [p, p.card]));
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });
  const pageOf = (s) => ({
    ...s.card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  const site = { title: input.site.title, base_url: base };
  const tagsView = allTags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates, escape: esc };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const topVars = { site, tags: tagsView, recent };
    for (const k in vars) topVars[k] = vars[k];
    return renderNodes(nodes, { vars: topVars, parent: null }, ctx, 0);
  };

  const output = {};
  for (const s of sources) output[s.outDir + '/index.html'] = render(s.layout, { page: pageOf(s) });

  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: {
        number: k, total: pages, url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (const t of allTags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;

  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push('shadowed ' + f.path + ': a built page has its path');
    else output[f.path] = f.content;
  }

  const lines = report.concat([...broken]).sort(cmp);
  const nPages = sources.filter((s) => !s.post).length;
  lines.push('built ' + nPages + ' pages, ' + posts.length + ' posts, ' + allTags.length + ' tags and ' + statics.length + ' static files');
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}
