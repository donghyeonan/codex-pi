export class FrontmatterError extends Error {
  constructor(message, { source = '<input>', line = null } = {}) {
    super(line ? `${source}:${line}: ${message}` : `${source}: ${message}`);
    this.name = 'FrontmatterError';
    this.source = source;
    this.line = line;
  }
}

function error(message, source, line) {
  throw new FrontmatterError(message, { source, line });
}

function stripComment(value) {
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote === "'" && char === "'" && value[index + 1] === "'") {
      index += 1;
      continue;
    }
    if (char === quote) quote = null;
    else if (!quote && (char === "'" || char === '"')) quote = char;
    else if (!quote && char === '#' && (index === 0 || /\s/.test(value[index - 1]))) return value.slice(0, index).trimEnd();
  }
  return value;
}

function splitInlineArray(value, source, line) {
  const content = value.slice(1, -1).trim();
  if (!content) return [];

  const values = [];
  let token = '';
  let quote = null;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (quote === "'" && char === "'" && content[index + 1] === "'") {
      token += "''";
      index += 1;
      continue;
    }
    if (char === quote) {
      quote = null;
      token += char;
    } else if (!quote && (char === "'" || char === '"')) {
      quote = char;
      token += char;
    } else if (!quote && char === ',') {
      if (!token.trim()) error('array entries must be scalars', source, line);
      values.push(token.trim());
      token = '';
    } else {
      token += char;
    }
  }
  if (quote) error('unterminated quoted array entry', source, line);
  if (!token.trim()) error('array entries must be scalars', source, line);
  values.push(token.trim());
  return values;
}

/** Parse the scalar subset used by canonical Markdown frontmatter. */
export function parseScalar(rawValue, { source = '<input>', line = null } = {}) {
  const value = stripComment(String(rawValue)).trim();
  if (!value) error('expected a scalar value', source, line);
  if (value === 'null' || value === '~') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;

  if (value.startsWith('[')) {
    if (!value.endsWith(']')) error('unterminated inline array', source, line);
    return splitInlineArray(value, source, line).map(entry => {
      const scalar = parseScalar(entry, { source, line });
      if (Array.isArray(scalar)) error('nested arrays are not supported', source, line);
      return scalar;
    });
  }
  if (value.endsWith(']')) error('unexpected closing array delimiter', source, line);

  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed !== 'string') error('quoted values must be strings', source, line);
      return parsed;
    } catch (cause) {
      if (cause instanceof FrontmatterError) throw cause;
      error('invalid double-quoted string', source, line);
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) error('invalid single-quoted string', source, line);
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.includes('"') || value.includes("'")) error('quotes must enclose the full scalar', source, line);
  if (value.startsWith('{') || value.startsWith('[')) error('objects and nested collections are not supported', source, line);

  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) {
    const number = Number(value);
    if (!Number.isFinite(number)) error('number must be finite', source, line);
    return number;
  }
  return value;
}

/**
 * Parse a Markdown document whose first block is the repository's flat YAML
 * frontmatter subset. Nested objects are deliberately unsupported.
 */
export function parseFrontmatter(markdown, { source = '<input>' } = {}) {
  const lines = String(markdown).replace(/^\uFEFF/, '').split(/\n/).map(line => line.endsWith('\r') ? line.slice(0, -1) : line);
  if (lines[0] !== '---') error('missing opening frontmatter delimiter', source, 1);

  const values = Object.create(null);
  let listKey = null;
  let closingLine = -1;

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    const number = index + 1;
    if (line === '---') {
      closingLine = index;
      break;
    }
    if (!line.trim() || /^\s*#/.test(line)) continue;

    const listMatch = line.match(/^[ \t]*-\s*(.+?)\s*$/);
    if (listMatch) {
      if (!listKey) error('list item has no array field', source, number);
      const item = parseScalar(listMatch[1], { source, line: number });
      if (Array.isArray(item)) error('nested arrays are not supported', source, number);
      if (values[listKey] === null) values[listKey] = [];
      values[listKey].push(item);
      continue;
    }

    const fieldMatch = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t]*(.*))?$/);
    if (!fieldMatch) error('expected a flat key/value field', source, number);
    const [, key, rawValue = ''] = fieldMatch;
    if (Object.hasOwn(values, key)) error(`duplicate field "${key}"`, source, number);
    listKey = key;
    values[key] = rawValue === '' ? null : parseScalar(rawValue, { source, line: number });
    if (values[key] !== null) listKey = null;
  }

  if (closingLine === -1) error('missing closing frontmatter delimiter', source);
  return {
    frontmatter: values,
    attributes: values,
    data: values,
    body: lines.slice(closingLine + 1).join('\n')
  };
}
