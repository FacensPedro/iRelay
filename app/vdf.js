'use strict';
// Valve's text KeyValues (appmanifest_*.acf, libraryfolders.vdf).

function parse(text) {
  const root = {};
  const stack = [root];
  const token = /"((?:\\.|[^"\\])*)"|([{}])/g;
  let key = null;
  let match;
  while ((match = token.exec(text)) !== null) {
    const top = stack[stack.length - 1];
    if (match[2] === '{') {
      const child = {};
      if (key !== null) top[key] = child;
      stack.push(child);
      key = null;
    } else if (match[2] === '}') {
      if (stack.length > 1) stack.pop();
      key = null;
    } else {
      const value = match[1].replace(/\\(.)/g, '$1');
      if (key === null) {
        key = value;
      } else {
        top[key] = value;
        key = null;
      }
    }
  }
  return root;
}

/// The value of `key` in `object`, ignoring case (Valve's keys vary in case).
function get(object, key) {
  if (!object || typeof object !== 'object') return undefined;
  const wanted = key.toLowerCase();
  const found = Object.keys(object).find((name) => name.toLowerCase() === wanted);
  return found === undefined ? undefined : object[found];
}

module.exports = { parse, get };
