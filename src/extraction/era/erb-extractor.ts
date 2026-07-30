import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference } from '../../types';
import { generateNodeId } from '../tree-sitter-helpers';
import { getEraProfile } from './profile';
import { EraProfileIndex } from './types';
import { PreparedLine, prepareLines, collectDocComment } from './lines';
import { qualifyFunction, qualifyVariable, qualifyLocal, qualifyLabel, refVariable, refDynamicCall } from './names';

/**
 * EraBasic (`.ERB` script, `.ERH` header) extractor.
 *
 * What a remake needs from an Era script is not a syntax tree: it is the answer
 * to "what does this behaviour read, what does it write, what does it branch
 * on, and who else touches the same state". So this extractor emits functions
 * and, per function, one deduplicated reference per (variable, direction) pair
 * plus every call site — including the interpolated ones (`TRYCALLFORM
 * COM_ABLE{com_id}`) that no text search can follow.
 *
 * Parsing is line-oriented rather than grammar-based. EraBasic has no
 * tree-sitter grammar, and the shape that would need one (nested expressions)
 * is not the shape being asked about; a statement's first token plus its
 * top-level assignment operator carry the read/write direction, which is what
 * the question needs.
 *
 * Deduplication is deliberate: a function that touches `ABL:顺从` in nine
 * places produces one `reads` reference at the first line, not nine. The graph
 * answers which functions touch a slot and where to start reading; the exact
 * evaluation order stays in the source file, which a reviewer opens anyway.
 */

// Era identifiers mix ASCII with kana and kanji (`残存PALAM`, `ライン数`), and
// CSV slot names routinely open with a FULLWIDTH Latin letter (`Ｃ感觉`,
// `Ｖ系装着器具`). Leaving fullwidth forms out truncates those names to their
// CJK tail, which then matches no row at all — the single largest source of
// lost bindings in a real game. The ranges deliberately exclude CJK
// punctuation (`、。「」・`) so a line of prose cannot manufacture references.
const ID_START =
  'A-Za-z_\\u00C0-\\u024F\\u0370-\\u03FF\\u3041-\\u3096\\u30A1-\\u30FA\\u30FC' +
  '\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF\\uFF21-\\uFF3A\\uFF41-\\uFF5A\\uFF66-\\uFF9D';
const ID_PART = `${ID_START}0-9\\uFF10-\\uFF19`;
const IDENT = `[${ID_START}][${ID_PART}]*`;

const FUNCTION_RE = new RegExp(`^@\\s*(${IDENT})\\s*(?:\\(([^)]*)\\))?`);
const LABEL_RE = new RegExp(`^\\$\\s*(${IDENT})`);
const DIRECTIVE_RE = /^#\s*([A-Za-z_][A-Za-z0-9_]*)\s*(.*)$/;
/**
 * An index token: everything up to the next delimiter.
 *
 * Deliberately wider than an identifier. A CSV slot name is any text a game
 * author typed between two commas, so real names include `淫核／淫茎` and
 * `通常画面画像：表示` with fullwidth punctuation an identifier charset would
 * split on, leaving a fragment that matches no row. Only the characters that
 * actually end a token are excluded: whitespace, operators, brackets, quotes,
 * and CJK sentence punctuation (which never appears in a slot name but does
 * appear in prose that follows one).
 */
const INDEX_TOKEN = '[^\\s:,()\\[\\]{}+\\-*/%=<>!&|"\'`;、。「」『』（）　]+';

/** Identifier plus its index chain: `ABL:MASTER:顺从`, `FLAG:15`, `CFLAG:(x+1)`. */
const REFERENCE_RE = new RegExp(`(${IDENT})((?::(?:\\([^()]*\\)|${INDEX_TOKEN}))*)`, 'g');

/** `#DIM` modifiers that precede the declared name. */
const DIM_MODIFIERS = new Set([
  'CONST', 'REF', 'DYNAMIC', 'STATIC', 'GLOBAL', 'SAVEDATA', 'CHARADATA',
]);

/**
 * Instructions whose FIRST argument is written rather than read. Plain
 * assignment covers the overwhelming majority of writes in real scripts; this
 * list exists for the legacy and array forms that do not use `=`.
 */
const MUTATING_INSTRUCTIONS = new Set([
  'SET', 'TIMES', 'SWAP', 'SWAPVAR', 'VARSET', 'SPLIT', 'SETBIT', 'CLEARBIT', 'INVERTBIT',
  'ARRAYSHIFT', 'ARRAYREMOVE', 'ARRAYSORT', 'ARRAYCOPY', 'ARRAYMSORT', 'ARRAYMSORTEX',
  'STRDATA', 'VARSIZE', 'ENCODETOUNI', 'INPUT', 'INPUTS', 'TINPUT', 'TINPUTS',
]);

/**
 * Does this PRINT variant take display text rather than expressions?
 *
 * The PRINT family splits on the letter right after the `PRINT` (and an
 * optional `SINGLE`): `PRINTV…` takes integer expressions and `PRINTS…` takes
 * string expressions, while everything else (`PRINTL`, `PRINTLC`, `PRINTPLAIN`,
 * `PRINTBUTTON`) takes literal text. Scanning that text for identifiers turns
 * ordinary prose into references, which is where most spurious edges come from.
 */
function takesRawText(name: string): boolean {
  const tail = name.replace(/^(?:DEBUG)?PRINT(?:SINGLE)?/, '');
  if (tail === name) return false;
  return !/^[VS]/.test(tail);
}

/**
 * Words the language uses structurally but the engine does not register as
 * instructions: `CASE IS < 500`, `CASE 1 TO 5`, `ALIGNMENT LEFT`.
 */
const KEYWORDS = new Set(['IS', 'TO', 'LEFT', 'RIGHT', 'CENTER', 'AND', 'OR', 'NOT', 'XOR']);

/**
 * Instructions outside the PRINT family that also take FORM-style display text
 * (`THROW 【エラー】未登録の引数 %ARGS% が使用されました`). Their prose is not
 * code, so only the `%…%` and `{…}` holes are scanned.
 */
const FORM_TEXT_INSTRUCTIONS = new Set([
  'THROW', 'REUSELASTLINE', 'CUSTOMDRAWLINE', 'HTML_PRINT', 'DRAWLINEFORM',
]);

/**
 * Instructions whose argument is a literal word or line of display text, with
 * no interpolation at all.
 *
 * `DATA` dominates by volume: every `PRINTDATA` block is a list of `DATA <text>`
 * lines, and a game's dialogue is thousands of them. Reading that text as code
 * turns prose into references and is by far the largest source of noise in the
 * graph if left alone. `BEGIN` takes a system-flow keyword (`BEGIN AFTERTRAIN`)
 * and `SETCOLORBYNAME` a colour name; neither is a symbol.
 */
const LITERAL_ARG_INSTRUCTIONS = new Set([
  'DATA', 'BEGIN', 'SETCOLORBYNAME', 'SETBGCOLORBYNAME', 'FONTSTYLE', 'ALIGNMENT',
]);

/** Instructions that open a conditional or a loop; their argument is a guard. */
const BRANCH_INSTRUCTIONS = new Set([
  'IF', 'ELSEIF', 'SIF', 'WHILE', 'DO', 'LOOP', 'FOR', 'REPEAT', 'SELECTCASE', 'CASE', 'TIMES',
]);

/** Instructions and variables that draw on the random source. */
const RANDOM_NAMES = new Set(['RAND', 'RANDOMIZE', 'INITRAND']);

/** Distinct references kept per function; a guard against pathological files. */
const MAX_REFS_PER_FUNCTION = 512;

interface FunctionScope {
  node: Node;
  /** Locals declared by `#DIM`/`#DIMS` inside this function. */
  locals: Set<string>;
  /** Deduplication key -> already emitted. */
  seen: Set<string>;
  refCount: number;
  usesRandom: boolean;
  branches: number;
  dynamicCalls: number;
  truncated: boolean;
}

export class EraBasicExtractor {
  private filePath: string;
  private source: string;
  private index: EraProfileIndex;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];
  private fileNodeId = '';
  private scope: FunctionScope | null = null;
  /** `#DIMS` names seen in this file: their assignments carry FORM text. */
  private stringNames = new Set<string>();

  constructor(filePath: string, source: string, index?: EraProfileIndex) {
    this.filePath = filePath;
    this.source = source;
    this.index = index ?? getEraProfile();
  }

  extract(): ExtractionResult {
    const startTime = Date.now();
    try {
      const lines = prepareLines(this.source, true);
      this.createFileNode(lines.length);
      this.walk(lines);
      this.closeFunction(lines.length);
    } catch (error) {
      this.errors.push({
        message: `EraBasic extraction error: ${error instanceof Error ? error.message : String(error)}`,
        filePath: this.filePath,
        severity: 'error',
        code: 'parse_error',
      });
    }
    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: this.unresolvedReferences,
      errors: this.errors,
      durationMs: Date.now() - startTime,
    };
  }

  // -- structure ------------------------------------------------------------

  private createFileNode(lineCount: number): void {
    const name = this.filePath.replace(/\\/g, '/').split('/').pop() || this.filePath;
    this.fileNodeId = generateNodeId(this.filePath, 'file', this.filePath, 1);
    this.nodes.push({
      id: this.fileNodeId,
      kind: 'file',
      name,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'erabasic',
      startLine: 1,
      endLine: Math.max(1, lineCount),
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    });
  }

  private walk(lines: PreparedLine[]): void {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.blank) continue;
      const code = line.code;

      if (code.startsWith('@')) {
        this.closeFunction(line.line - 1);
        this.openFunction(lines, i);
        continue;
      }
      if (code.startsWith('#')) {
        this.handleDirective(line);
        continue;
      }
      if (code.startsWith('$')) {
        this.handleLabel(line);
        continue;
      }
      this.handleStatement(line);
    }
  }

  private openFunction(lines: PreparedLine[], index: number): void {
    const line = lines[index]!;
    const match = line.code.match(FUNCTION_RE);
    if (!match) {
      this.errors.push({
        message: `unparseable function header: ${line.code.slice(0, 80)}`,
        filePath: this.filePath,
        line: line.line,
        severity: 'warning',
        code: 'era_bad_function_header',
      });
      return;
    }
    const name = match[1]!;
    const params = (match[2] ?? '').trim();
    const qualifiedName = qualifyFunction(name);
    const node: Node = {
      id: generateNodeId(this.filePath, 'function', qualifiedName, line.line),
      kind: 'function',
      name,
      qualifiedName,
      filePath: this.filePath,
      language: 'erabasic',
      startLine: line.line,
      endLine: line.line,
      startColumn: 0,
      endColumn: line.code.length,
      signature: params ? `@${name}(${params})` : `@${name}`,
      docstring: collectDocComment(lines, index),
      // ERB has no visibility and no imports: every @FUNCTION is callable from
      // every file, so they are all exported.
      isExported: true,
      updatedAt: Date.now(),
    };
    this.nodes.push(node);
    this.edges.push({ source: this.fileNodeId, target: node.id, kind: 'contains' });
    this.scope = {
      node,
      locals: new Set(),
      seen: new Set(),
      refCount: 0,
      usesRandom: false,
      branches: 0,
      dynamicCalls: 0,
      truncated: false,
    };

    // Parameters are locals; without registering them, `ARG` and named
    // parameters would be reported as reads of some same-named global.
    for (const raw of params.split(',')) {
      const p = raw.trim().split(':')[0]!.trim();
      if (p) this.scope.locals.add(p);
    }
  }

  private closeFunction(endLine: number): void {
    const scope = this.scope;
    if (!scope) return;
    scope.node.endLine = Math.max(scope.node.startLine, endLine);
    const traits: string[] = [];
    if (scope.usesRandom) traits.push('random');
    if (scope.branches) traits.push(`branches:${scope.branches}`);
    if (scope.dynamicCalls) traits.push(`dynamic-dispatch:${scope.dynamicCalls}`);
    if (scope.truncated) traits.push('refs-truncated');
    if (traits.length) scope.node.decorators = traits;
    this.scope = null;
  }

  private handleDirective(line: PreparedLine): void {
    const match = line.code.match(DIRECTIVE_RE);
    if (!match) return;
    const directive = match[1]!.toUpperCase();
    const rest = match[2]!;

    if (directive === 'FUNCTION' || directive === 'FUNCTIONS') {
      if (this.scope) {
        // Expression-callable functions are reached as `name(args)`, a
        // different call shape from `CALL name`; the resolver needs to know
        // which functions can appear that way.
        this.scope.node.returnType = directive === 'FUNCTIONS' ? 'string' : 'int';
      }
      return;
    }
    if (directive === 'DIM' || directive === 'DIMS') {
      this.declareVariable(line, rest, directive === 'DIMS');
      return;
    }
    if (directive === 'DEFINE') {
      // `#DEFINE height_normal 0` is a compile-time macro, the other way a
      // game names a constant. Its uses look exactly like variable reads, so
      // without a node for it every `SIF x < height_normal` dangles.
      this.declareMacro(line, rest);
      return;
    }
    if (directive === 'LOCALSIZE' || directive === 'LOCALSSIZE') {
      if (this.scope) this.scope.locals.add(directive === 'LOCALSIZE' ? 'LOCAL' : 'LOCALS');
      return;
    }
    // #INCLUDE and the ordering pragmas (#PRI, #LATER, #SINGLE) carry no
    // symbol; everything else is unknown and safely ignored.
  }

  /**
   * `#DIM [modifiers] NAME[, size…][= init]`.
   *
   * Inside a function the declaration is local and stays local: it is
   * interpreter state, not a game fact, and treating it as a global would make
   * every function that happens to reuse the name look like a shared consumer.
   * At file level it is a global that any script can read or write, which is
   * exactly what a Migration Record calls a persistent fact when it also
   * carries SAVEDATA.
   */
  private declareVariable(line: PreparedLine, rest: string, isString: boolean): void {
    const tokens = rest.split(/[\s,=]+/).filter(Boolean);
    const modifiers: string[] = [];
    let name = '';
    for (const token of tokens) {
      const upper = token.toUpperCase();
      if (DIM_MODIFIERS.has(upper)) {
        modifiers.push(upper);
        continue;
      }
      name = token;
      break;
    }
    if (!name) return;
    if (isString) this.stringNames.add(name);

    if (this.scope) {
      this.scope.locals.add(name);
      const qualifiedName = qualifyLocal(this.scope.node.name, name);
      const id = generateNodeId(this.filePath, 'variable', qualifiedName, line.line);
      this.nodes.push({
        id,
        kind: 'variable',
        name,
        qualifiedName,
        filePath: this.filePath,
        language: 'erabasic',
        startLine: line.line,
        endLine: line.line,
        startColumn: 0,
        endColumn: line.code.length,
        signature: line.code,
        visibility: 'private',
        updatedAt: Date.now(),
      });
      this.edges.push({ source: this.scope.node.id, target: id, kind: 'contains' });
      return;
    }

    const isConst = modifiers.includes('CONST');
    const qualifiedName = qualifyVariable(name);
    const id = generateNodeId(this.filePath, isConst ? 'constant' : 'variable', qualifiedName, line.line);
    this.nodes.push({
      id,
      kind: isConst ? 'constant' : 'variable',
      name,
      qualifiedName,
      filePath: this.filePath,
      language: 'erabasic',
      startLine: line.line,
      endLine: line.line,
      startColumn: 0,
      endColumn: line.code.length,
      signature: line.code,
      docstring: line.comment || undefined,
      decorators: modifiers.length ? modifiers : undefined,
      typeParameters: isString ? ['string'] : ['int'],
      isExported: true,
      // SAVEDATA is the marker separating a persistent game fact from a
      // per-session global, the exact split a Migration Record has to make.
      isStatic: modifiers.includes('SAVEDATA'),
      updatedAt: Date.now(),
    });
    this.edges.push({ source: this.fileNodeId, target: id, kind: 'contains' });
  }

  /**
   * `#DEFINE <name> <replacement>`.
   *
   * Filed as a constant under the same `ERA::VAR::` namespace a `#DIM CONST`
   * uses: both are game-declared names that appear in expressions, and a reader
   * asking "where does this name come from" does not care which directive
   * declared it.
   */
  private declareMacro(line: PreparedLine, rest: string): void {
    const match = rest.match(new RegExp(`^(${IDENT})\\s*(.*)$`));
    if (!match) return;
    const name = match[1]!;
    const qualifiedName = qualifyVariable(name);
    const id = generateNodeId(this.filePath, 'constant', qualifiedName, line.line);
    this.nodes.push({
      id,
      kind: 'constant',
      name,
      qualifiedName,
      filePath: this.filePath,
      language: 'erabasic',
      startLine: line.line,
      endLine: line.line,
      startColumn: 0,
      endColumn: line.code.length,
      signature: line.code,
      docstring: line.comment || undefined,
      decorators: ['DEFINE'],
      isExported: true,
      updatedAt: Date.now(),
    });
    this.edges.push({ source: this.scope?.node.id ?? this.fileNodeId, target: id, kind: 'contains' });
  }

  private handleLabel(line: PreparedLine): void {
    const scope = this.scope;
    if (!scope) return;
    const match = line.code.match(LABEL_RE);
    if (!match) return;
    const name = match[1]!;
    const qualifiedName = qualifyLabel(scope.node.name, name);
    const id = generateNodeId(this.filePath, 'constant', qualifiedName, line.line);
    this.nodes.push({
      id,
      kind: 'constant',
      name: `$${name}`,
      qualifiedName,
      filePath: this.filePath,
      language: 'erabasic',
      startLine: line.line,
      endLine: line.line,
      startColumn: 0,
      endColumn: line.code.length,
      visibility: 'private',
      updatedAt: Date.now(),
    });
    this.edges.push({ source: scope.node.id, target: id, kind: 'contains' });
  }

  // -- statements -----------------------------------------------------------

  private handleStatement(line: PreparedLine): void {
    const scope = this.scope;
    if (!scope) return;
    const code = line.code;

    const headMatch = code.match(new RegExp(`^(${IDENT})`));
    const head = headMatch?.[1];
    const afterHead = head ? code.slice(head.length) : '';
    // `name(...)` with no space is an expression statement calling a
    // `#FUNCTION`, not an instruction taking arguments.
    const looksLikeCallExpression = afterHead.startsWith('(');

    const instruction = head && !looksLikeCallExpression
      ? (this.index.instructions.get(head) ?? this.index.instructions.get(head.toUpperCase()))
      : undefined;

    if (instruction) {
      const rest = afterHead.replace(/^\s+/, '');
      const name = instruction.name;

      if (RANDOM_NAMES.has(name)) scope.usesRandom = true;
      if (BRANCH_INSTRUCTIONS.has(name)) scope.branches++;

      if (instruction.kind === 'call' || instruction.kind === 'callf') {
        this.handleCall(line, rest, instruction.isForm);
        return;
      }
      if (instruction.kind === 'goto') {
        // GOTO targets a `$LABEL` inside the current function. It never leaves
        // the function, so it is control flow rather than a dependency.
        this.scanExpression(line, this.formInterpolations(rest), 'reads');
        return;
      }
      // FORM first: `PRINTFORML` is a PRINT variant AND an interpolating one,
      // and the raw-text test would otherwise swallow its `{…}` holes.
      if (name.includes('FORM') || FORM_TEXT_INSTRUCTIONS.has(name)) {
        this.scanExpression(line, this.formInterpolations(rest), 'reads');
        return;
      }
      if (takesRawText(name) || LITERAL_ARG_INSTRUCTIONS.has(name)) return;
      if (MUTATING_INSTRUCTIONS.has(name)) {
        const comma = this.topLevelIndexOf(rest, ',');
        const target = comma < 0 ? rest : rest.slice(0, comma);
        this.scanExpression(line, target, 'writes');
        if (comma >= 0) this.scanExpression(line, rest.slice(comma + 1), 'reads');
        return;
      }
      this.scanExpression(line, rest, 'reads');
      return;
    }

    const assignment = this.splitAssignment(code);
    if (assignment) {
      // A compound operator reads the target before writing it, so it is both.
      this.scanExpression(line, assignment.lhs, 'writes');
      if (assignment.compound) this.scanExpression(line, assignment.lhs, 'reads');
      // Assigning to a STRING variable makes the right-hand side display text,
      // not an expression: `RESULTS = %RESULTS% %CALLNAME:PLAYER%为处女({LOCAL:99})`
      // is prose with two interpolations, and scanning it as code invents a
      // call to a function named 为处女. Only the holes are code.
      if (this.isStringAssignment(assignment.lhs)) {
        this.scanExpression(line, this.formInterpolations(assignment.rhs), 'reads');
      } else {
        this.scanExpression(line, assignment.rhs, 'reads');
      }
      return;
    }

    this.scanExpression(line, code, 'reads');
  }

  /**
   * A call instruction's target.
   *
   * `CALL FUNC(a, b)` names its target outright. `CALLFORM COM_ABLE{com_id}`
   * builds it: the literal prefix is all that survives to the graph, and the
   * resolver widens it to the set of functions that could match. That single
   * `isForm` bit, read off the engine's own instruction table, is what makes
   * these call sites visible at all.
   */
  private handleCall(line: PreparedLine, rest: string, isForm: boolean): void {
    const scope = this.scope!;
    const comma = this.topLevelIndexOf(rest, ',');
    let targetText = (comma < 0 ? rest : rest.slice(0, comma)).trim();
    const argText = comma < 0 ? '' : rest.slice(comma + 1);

    // `CALL FUNC(a, b)` puts the arguments in parens instead of after a comma.
    // A FORM target never uses that syntax, and its interpolations routinely
    // contain parens (`KOJO_%kojo_index(TARGET)%_MESSAGE_…`); splitting there
    // would truncate the target and feed the remainder to the expression
    // scanner as if it were code.
    let parenArgs = '';
    if (!isForm) {
      const paren = targetText.indexOf('(');
      if (paren >= 0) {
        parenArgs = targetText.slice(paren + 1).replace(/\)\s*$/, '');
        targetText = targetText.slice(0, paren).trim();
      }
    }

    if (isForm) {
      const hole = targetText.search(/[{%]/);
      if (hole >= 0) {
        const prefix = targetText.slice(0, hole).trim();
        // Text after the LAST hole narrows the candidate set as much as the
        // prefix does: `EVENT_K{no}_A` must not match `EVENT_K1030`.
        const lastHole = Math.max(targetText.lastIndexOf('}'), targetText.lastIndexOf('%'));
        const suffix = lastHole > hole ? targetText.slice(lastHole + 1).trim() : '';
        scope.dynamicCalls++;
        if (prefix) {
          this.addReference(line, refDynamicCall(prefix, suffix), 'calls');
        } else {
          // Nothing literal survives (`CALLFORM %name%`), so there is no
          // prefix to widen and no honest edge to draw.
          this.errors.push({
            message: `call target is fully interpolated; no static prefix to resolve: ${line.code.slice(0, 80)}`,
            filePath: this.filePath,
            line: line.line,
            severity: 'warning',
            code: 'era_opaque_dynamic_call',
          });
        }
        this.scanExpression(line, this.formInterpolations(targetText), 'reads');
      } else if (targetText) {
        this.addReference(line, qualifyFunction(targetText), 'calls');
      }
    } else if (targetText) {
      this.addReference(line, qualifyFunction(targetText), 'calls');
    }

    if (parenArgs) this.scanExpression(line, parenArgs, 'reads');
    if (argText) this.scanExpression(line, argText, 'reads');
  }

  // -- expressions ----------------------------------------------------------

  /**
   * Does this assignment target a string variable, making the right-hand side
   * FORM text rather than an expression?
   *
   * The engine decides: every built-in carries its value type in the profile,
   * and `#DIMS` declares a game-defined one. The `'=` operator is the explicit
   * escape a script uses when it wants the right-hand side evaluated instead.
   */
  private isStringAssignment(lhs: string): boolean {
    const trimmed = lhs.trimEnd();
    if (trimmed.endsWith("'")) return false;
    const match = trimmed.match(new RegExp(`^\\s*(${IDENT})`));
    if (!match) return false;
    const name = match[1]!;
    if (this.stringNames.has(name)) return true;
    return this.index.variables.get(name)?.valueType === 'string';
  }

  /** Concatenate every `{expr}` and `%expr%` hole in a FORM string. */
  private formInterpolations(text: string): string {
    const parts: string[] = [];
    for (const m of text.matchAll(/\{([^{}]*)\}|%([^%]*)%/g)) {
      parts.push(m[1] ?? m[2] ?? '');
    }
    return parts.join(' , ');
  }

  /**
   * Emit one reference per identifier in an expression.
   *
   * String literals are blanked first so their contents cannot masquerade as
   * code. Identifiers that name an instruction or a built-in expression
   * function are skipped: they are engine vocabulary, not game state. What is
   * left is either a call to a game `#FUNCTION` (identifier followed by an open
   * paren) or a variable access.
   */
  private scanExpression(line: PreparedLine, text: string, kind: 'reads' | 'writes'): void {
    const scope = this.scope;
    if (!scope || !text) return;
    const cleaned = this.blankStringLiterals(text);

    REFERENCE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = REFERENCE_RE.exec(cleaned)) !== null) {
      const name = match[1]!;
      const chain = match[2] ?? '';
      const after = cleaned.slice(match.index + match[0].length);

      // A hex or decimal literal's tail is not an identifier: `SETCOLOR
      // 0xFF0000` must not yield a variable called `xFF0000`.
      const before = match.index > 0 ? cleaned[match.index - 1]! : '';
      if (before >= '0' && before <= '9') continue;

      const upper = name.toUpperCase();
      // Checked before the instruction and method tables: the engine registers
      // RAND as both a variable and a built-in, and a random draw has to be
      // recorded whichever table claims the name first.
      if (RANDOM_NAMES.has(upper)) {
        scope.usesRandom = true;
        continue;
      }
      if (KEYWORDS.has(upper)) continue;
      if (this.index.instructions.has(name) || this.index.instructions.has(upper)) continue;
      if (this.index.methods.has(name) || this.index.methods.has(upper)) continue;
      // Numeric-looking chains on a bare identifier are still variable
      // accesses; a following `(` with no chain is a call.
      if (!chain && /^\s*\(/.test(after)) {
        this.addReference(line, qualifyFunction(name), 'calls');
        continue;
      }
      if (scope.locals.has(name)) continue;

      this.addReference(line, refVariable(name + chain), kind);
    }
  }

  /** Replace `"…"` contents with spaces so offsets and structure survive. */
  private blankStringLiterals(text: string): string {
    let out = '';
    let inString = false;
    for (const ch of text) {
      if (ch === '"') {
        inString = !inString;
        out += ' ';
        continue;
      }
      out += inString ? ' ' : ch;
    }
    return out;
  }

  /**
   * Split a statement at its assignment operator.
   *
   * Only top-level operators count: `X:(A==B) = 1` assigns, `SIF A == B` does
   * not. Comparison operators (`==`, `!=`, `<=`, `>=`) are excluded so a guard
   * is never mistaken for a write, which would invert the direction of the most
   * important edge in the graph.
   */
  private splitAssignment(code: string): { lhs: string; rhs: string; compound: boolean } | null {
    let depth = 0;
    let inString = false;
    for (let i = 0; i < code.length; i++) {
      const ch = code[i]!;
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (ch === '=' && depth === 0) {
        const prev = code[i - 1] ?? '';
        const next = code[i + 1] ?? '';
        if (next === '=') {
          i++;
          continue;
        }
        if (prev === '=' || prev === '!' || prev === '<' || prev === '>') continue;
        const compound = '+-*/%|&^'.includes(prev) || (prev === '<' || prev === '>');
        const lhsEnd = compound ? i - 1 : i;
        return { lhs: code.slice(0, lhsEnd), rhs: code.slice(i + 1), compound };
      }
    }
    // `X++` / `X--` read and write in one token.
    const incdec = code.match(new RegExp(`^\\s*(${IDENT}(?::[^\\s]+)*)\\s*(\\+\\+|--)\\s*$`));
    if (incdec) return { lhs: incdec[1]!, rhs: '', compound: true };
    return null;
  }

  /** Index of `needle` outside parens and strings, or -1. */
  private topLevelIndexOf(text: string, needle: string): number {
    let depth = 0;
    let inString = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (ch === '"') inString = !inString;
      else if (inString) continue;
      else if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (ch === needle && depth === 0) return i;
    }
    return -1;
  }

  /** Record one reference, keeping only the first occurrence per function. */
  private addReference(line: PreparedLine, referenceName: string, kind: 'reads' | 'writes' | 'calls'): void {
    const scope = this.scope;
    if (!scope) return;
    const key = `${kind} ${referenceName}`;
    if (scope.seen.has(key)) return;
    if (scope.refCount >= MAX_REFS_PER_FUNCTION) {
      if (!scope.truncated) {
        scope.truncated = true;
        this.errors.push({
          message: `@${scope.node.name} exceeds ${MAX_REFS_PER_FUNCTION} distinct references; later ones are not indexed`,
          filePath: this.filePath,
          line: line.line,
          severity: 'warning',
          code: 'era_refs_truncated',
        });
      }
      return;
    }
    scope.seen.add(key);
    scope.refCount++;
    this.unresolvedReferences.push({
      fromNodeId: scope.node.id,
      referenceName,
      referenceKind: kind,
      line: line.line,
      column: 0,
      filePath: this.filePath,
      language: 'erabasic',
    });
  }
}
