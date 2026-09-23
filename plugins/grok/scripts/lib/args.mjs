// @ts-check

export const DEFAULT_MODEL = "grok-4.7";

const SCOPES = new Set(["auto", "working-tree", "branch"]);
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const CLAUDE_SIDE_FLAGS = new Set(["--wait", "--background"]);
const VALUE_FLAGS = new Set(["--base", "--scope", "--model", "--effort"]);

/**
 * @typedef {object} ReviewArgs
 * @property {string | null} base
 * @property {"auto" | "working-tree" | "branch"} scope
 * @property {string} model
 * @property {string | null} effort
 * @property {string} focus
 */

/**
 * Split a raw slash-command argument string like a shell would, without ever invoking one.
 * @param {string} raw
 * @returns {string[]}
 */
export function splitRawArgs(raw) {
  /** @type {string[]} */
  const tokens = [];
  let current = "";
  let quote = "";
  let hasToken = false;
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (quote) {
      if (char === quote) {
        quote = "";
      } else {
        current += char;
      }
    } else if ((char === '"' || char === "'") && raw.indexOf(char, i + 1) !== -1) {
      quote = char;
      hasToken = true;
    } else if (/\s/.test(char)) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
    } else {
      current += char;
      hasToken = true;
    }
  }
  if (hasToken) {
    tokens.push(current);
  }
  return tokens;
}

/**
 * Refs reach `git` as positional arguments; a leading "-" would be parsed as an option.
 * @param {string} ref
 */
function assertSafeRef(ref) {
  if (!ref || ref.startsWith("-") || /[\s\p{Cc}]/u.test(ref)) {
    throw new Error(`Invalid git ref "${ref}".`);
  }
}

/**
 * @param {string[]} argv
 * @returns {ReviewArgs}
 */
export function parseReviewArgs(argv) {
  // The command passes $ARGUMENTS as one raw string and may append flags like --model after it.
  const tokens = argv.flatMap((arg) => splitRawArgs(arg));
  /** @type {ReviewArgs} */
  const result = { base: null, scope: "auto", model: DEFAULT_MODEL, effort: null, focus: "" };
  /** @type {string[]} */
  const focus = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--") {
      focus.push(...tokens.slice(i + 1));
      break;
    }
    if (CLAUDE_SIDE_FLAGS.has(token)) {
      continue;
    }
    if (!token.startsWith("--")) {
      focus.push(token);
      continue;
    }

    const eq = token.indexOf("=");
    const name = eq === -1 ? token : token.slice(0, eq);
    if (!VALUE_FLAGS.has(name)) {
      throw new Error(`Unknown option "${name}". Supported: --base <ref>, --scope auto|working-tree|branch, --model <id>, --effort <level>.`);
    }
    let value;
    if (eq !== -1) {
      value = token.slice(eq + 1);
    } else {
      value = tokens[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${name} requires a value.`);
      }
      i += 1;
    }

    if (name === "--base") {
      assertSafeRef(value);
      result.base = value;
    } else if (name === "--scope") {
      if (value !== "auto" && value !== "working-tree" && value !== "branch") {
        throw new Error(`Unsupported scope "${value}". Use one of: ${[...SCOPES].join(", ")}.`);
      }
      result.scope = value;
    } else if (name === "--model") {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
        throw new Error(`Invalid model "${value}".`);
      }
      result.model = value;
    } else {
      if (!EFFORTS.has(value)) {
        throw new Error(`Unsupported effort "${value}". Use one of: ${[...EFFORTS].join(", ")}.`);
      }
      result.effort = value;
    }
  }

  result.focus = focus.join(" ").trim();
  return result;
}
