// Valve's KeyValues text format, as used by app manifests (.acf) and SteamCMD's app_info_print:
// quoted keys and values, nested { } blocks, backslash escapes and // comments.

const TOKEN = /\s+|\/\/[^\r\n]*|"((?:\\.|[^"\\])*)"|([{}])/y;

function tokenize(text) {
  const tokens = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < text.length) {
    const start = TOKEN.lastIndex;
    const match = TOKEN.exec(text);
    if (!match) {
      if (text[start] === '"') throw new SyntaxError(`Unterminated string at ${start}`);
      throw new SyntaxError(`Unexpected character at ${start}`);
    }
    if (match[1] !== undefined)
      tokens.push({ type: 'string', value: match[1].replace(/\\([\\"])/g, '$1'), end: TOKEN.lastIndex });
    else if (match[2]) tokens.push({ type: match[2], end: TOKEN.lastIndex });
  }
  return tokens;
}

function parseBlock(tokens, state, nested) {
  const object = {};
  while (state.index < tokens.length && tokens[state.index].type !== '}') {
    const key = tokens[state.index++];
    if (key.type !== 'string') throw new SyntaxError('Expected a quoted key');
    const value = tokens[state.index++];
    if (!value) throw new SyntaxError(`Missing value for ${key.value}`);
    if (value.type === 'string') object[key.value] = value.value;
    else if (value.type === '{') object[key.value] = parseBlock(tokens, state, true);
    else throw new SyntaxError(`Unexpected } after ${key.value}`);
  }
  if (nested) {
    if (tokens[state.index]?.type !== '}') throw new SyntaxError('Unbalanced braces: a block is not closed');
    state.index++;
  } else if (state.index < tokens.length) {
    throw new SyntaxError('Unbalanced braces: an extra }');
  }
  return object;
}

export function parseKeyValues(text) {
  return parseBlock(tokenize(String(text)), { index: 0 }, false);
}

// SteamCMD prints status lines before and after the block, so this parses from the line that is
// exactly "<appId>" up to the brace that closes its block and ignores everything after it.
export function findAppInfo(output, appId) {
  const text = String(output);
  const match = new RegExp(`^[ \\t]*"${appId}"[ \\t]*$`, 'm').exec(text);
  if (!match) return null;
  const rest = text.slice(match.index);
  let depth = 0;
  let inString = false;
  for (let i = 0; i < rest.length; i++) {
    const char = rest[i];
    if (inString) {
      if (char === '\\') i++;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) return parseKeyValues(rest.slice(0, i + 1));
      if (depth < 0) break;
    }
  }
  throw new SyntaxError(`The block for app ${appId} is not closed`);
}
