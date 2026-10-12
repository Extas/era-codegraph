/**
 * Era source text preparation, shared by the ERB and CSV extractors.
 *
 * Both formats are line-oriented, both use `;` for comments, both ship with a
 * UTF-8 BOM about half the time, and ERB additionally has `{`/`}` block
 * comments. Doing this once here keeps the two extractors from each carrying a
 * slightly different idea of what a line is.
 */

/** One prepared line: comment stripped, but the original 1-based number kept. */
export interface PreparedLine {
  /** Code with the comment removed and trailing whitespace trimmed. */
  code: string;
  /** 1-based line number in the original file. */
  line: number;
  /** Comment text without the leading `;`, or '' when there was none. */
  comment: string;
  /** True when the line held nothing but a comment or whitespace. */
  blank: boolean;
}

/** Strip a UTF-8 BOM. Era files carry one inconsistently. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Split a line at its comment.
 *
 * `;` starts a comment unless it is inside a double-quoted string. ERB has no
 * escape processing worth modelling here: a `"` always toggles string state, so
 * an unterminated quote makes the rest of the line a string, which is what
 * Emuera's own tokenizer does.
 */
export function splitComment(raw: string): { code: string; comment: string } {
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') inString = !inString;
    else if (ch === ';' && !inString) {
      return { code: raw.slice(0, i), comment: raw.slice(i + 1) };
    }
  }
  return { code: raw, comment: '' };
}

/**
 * Prepare every line of a file.
 *
 * `blockComments` handles ERB's `{` … `}` form, where a line consisting only of
 * a brace opens or closes a comment block. The brace must be alone on the line:
 * `CALLFORM COM_ABLE{com_id}` uses the same character for string interpolation,
 * and treating that as a comment would silently delete every dynamic call site.
 */
export function prepareLines(source: string, blockComments = false): PreparedLine[] {
  const text = stripBom(source);
  const out: PreparedLine[] = [];
  let inBlockComment = false;

  const rawLines = text.split('\n');
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i]!.replace(/\r$/, '');
    const trimmed = raw.trim();

    if (blockComments) {
      if (inBlockComment) {
        if (trimmed === '}') inBlockComment = false;
        out.push({ code: '', line: i + 1, comment: raw, blank: true });
        continue;
      }
      if (trimmed === '{') {
        inBlockComment = true;
        out.push({ code: '', line: i + 1, comment: raw, blank: true });
        continue;
      }
    }

    const { code, comment } = splitComment(raw);
    const codeTrimmed = code.trim();
    out.push({ code: codeTrimmed, line: i + 1, comment: comment.trim(), blank: codeTrimmed.length === 0 });
  }
  return out;
}

/**
 * Join the comment lines immediately above `index` into a docstring.
 *
 * Era games carry their intent in comment banners above each function; those
 * comments are the only prose statement of what a behaviour does, so they are
 * worth keeping on the node. Decorative rule lines (`;-----`, `;=====`, `;……`)
 * are dropped: they are layout, not documentation.
 */
export function collectDocComment(lines: PreparedLine[], index: number, maxLines = 12): string | undefined {
  const parts: string[] = [];
  for (let i = index - 1; i >= 0 && parts.length < maxLines; i--) {
    const l = lines[i]!;
    if (!l.blank) break;
    if (!l.comment) {
      if (parts.length) break;
      continue;
    }
    const text = l.comment.trim();
    if (!text || /^[-=*_~・.。…‥·　\s]+$/.test(text)) continue;
    parts.unshift(text);
  }
  return parts.length ? parts.join('\n') : undefined;
}
