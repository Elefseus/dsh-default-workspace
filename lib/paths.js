/**
 * Session-log path rules, mirrored from the Host's JSONL persistence backend
 * (`@deepseek-ai/dsh-session-persistence-jsonl`: `projectKey`, `encodeSegment`,
 * `sessionDir`, `logPath`).
 *
 * A stored Session header must live exactly at the path its own `cwd` and `id`
 * derive — the Host refuses to read a log whose path disagrees with its header
 * (`corrupt session log "<path>": header id "<id>" and cwd identify "<expected>"`).
 * Relocating a Session therefore means rewriting the header `cwd` and moving the
 * log into the matching project directory together.
 */
import { isAbsolute, join } from 'node:path';

const SAFE_CODE_UNIT = /^[A-Za-z0-9._-]$/;
const SESSION_FORMAT_VERSION = 4;

/**
 * Encode an arbitrary string as one safe path segment.
 * @param raw - the string to encode; must be non-empty.
 * @returns the escaped single path segment.
 */
export function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment');
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && SAFE_CODE_UNIT.test(ch)) out += ch;
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

/**
 * Build the human-navigable project directory key for a working directory.
 * @param cwd - the project path.
 * @returns the single filesystem-safe project directory name.
 */
export function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path');
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && SAFE_CODE_UNIT.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

/**
 * @param root - the Session root directory.
 * @param cwd - the project path; `undefined` selects `_no-cwd`.
 * @returns the project directory holding that project's Sessions.
 */
export function projectDir(root, cwd) {
  return cwd === undefined ? join(root, '_no-cwd') : join(root, projectKey(cwd));
}

/**
 * @param root - the Session root directory.
 * @param cwd - the project path.
 * @param id - the Session id.
 * @returns the Session's own directory.
 */
export function sessionDir(root, cwd, id) {
  return join(projectDir(root, cwd), encodeSegment(id));
}

/**
 * @param version - physical Session format generation.
 * @param compression - artifact encoding.
 * @returns the log filename for that generation.
 */
export function logFilename(version = SESSION_FORMAT_VERSION, compression = 'zstd') {
  return compression === 'zstd' ? `session.v${version}.jsonl.zstd` : `session.v${version}.jsonl`;
}

/**
 * @returns whether the value can be stored as a Workspace/Session path.
 */
export function isFullyQualifiedPath(value) {
  return typeof value === 'string' && value.length > 0 && isAbsolute(value);
}
