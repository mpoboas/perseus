/**
 * A small, dependency-free syntax highlighter for the diff view. It is line based (the diff shows
 * pieces of a file, so a real parser would have nothing to chew on) and carries only the state that
 * crosses lines: an open block comment or triple-quoted string. Output is plain tokens that React
 * renders as spans; nothing here produces HTML.
 */

export type TokenKind = "kw" | "str" | "com" | "num" | "lit" | "typ" | "fn" | "tag" | "attr" | "prop" | "plain";

export interface Token {
  text: string;
  kind: TokenKind;
}

/** What a line leaves open for the next one. */
export interface State {
  block: boolean;
  triple: string | null;
}

export const START: State = { block: false, triple: null };

interface Lang {
  keywords: string;
  literals?: string;
  /** Line-comment openers. */
  line?: string[];
  block?: [string, string];
  /** Characters that open a string ended by the same character. */
  quotes?: string;
  triple?: string[];
  /** Capitalised identifiers are types. */
  types?: boolean;
  /** An identifier followed by `(` is a call. */
  calls?: boolean;
  nocase?: boolean;
  /** `'x'` is a character literal and a lone `'` is a lifetime (Rust). */
  charLit?: boolean;
  /** `$name` is a variable (shell). */
  vars?: boolean;
  mode?: "markup" | "json" | "kv" | "markdown" | "css";
}

const C_LIKE = { line: ["//"], block: ["/*", "*/"] as [string, string], quotes: `"'`, types: true, calls: true };

const LANGS: Record<string, Lang> = {
  js: {
    ...C_LIKE,
    quotes: "\"'`",
    keywords:
      "as async await break case catch class const continue debugger default delete do else enum export extends finally for from function get if implements import in instanceof interface let new of package private protected public readonly return set static super switch this throw try type typeof var void while with yield declare namespace abstract keyof satisfies",
    literals: "true false null undefined NaN Infinity",
  },
  rust: {
    ...C_LIKE,
    quotes: `"`,
    charLit: true,
    keywords:
      "as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while macro_rules",
    literals: "true false None Some Ok Err",
  },
  python: {
    line: ["#"],
    quotes: `"'`,
    triple: [`"""`, `'''`],
    types: true,
    calls: true,
    keywords:
      "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case",
    literals: "True False None self cls",
  },
  go: {
    ...C_LIKE,
    quotes: "\"'`",
    keywords:
      "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var",
    literals: "true false nil iota",
  },
  java: {
    ...C_LIKE,
    keywords:
      "abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while var record sealed permits yield fun val when object companion override open internal lateinit suspend data",
    literals: "true false null",
  },
  c: {
    ...C_LIKE,
    keywords:
      "auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while class namespace template typename public private protected virtual override new delete using operator constexpr nullptr noexcept explicit friend this try catch throw bool final",
    literals: "true false NULL nullptr",
  },
  csharp: {
    ...C_LIKE,
    keywords:
      "abstract as async await base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw try typeof uint ulong unchecked unsafe ushort using var virtual void volatile while record init get set where yield",
    literals: "true false null",
  },
  swift: {
    ...C_LIKE,
    keywords:
      "actor as associatedtype async await break case catch class continue default defer deinit do else enum extension fallthrough fileprivate final for func guard if import in indirect init inout internal is let nonisolated open operator override private protocol public repeat rethrows return self Self static struct subscript super switch throw throws try typealias var weak where while",
    literals: "true false nil",
  },
  ruby: {
    line: ["#"],
    quotes: `"'`,
    types: true,
    calls: true,
    keywords:
      "alias and begin break case class def defined? do else elsif end ensure for if in module next not or redo rescue retry return self super then undef unless until when while yield require require_relative attr_accessor attr_reader attr_writer include extend private protected public",
    literals: "true false nil",
  },
  php: {
    ...C_LIKE,
    line: ["//", "#"],
    keywords:
      "abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile extends final finally fn for foreach function global if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield",
    literals: "true false null TRUE FALSE NULL",
  },
  shell: {
    line: ["#"],
    quotes: `"'`,
    vars: true,
    calls: false,
    keywords:
      "if then else elif fi for while until do done case esac in function select time return exit export local readonly declare unset shift source alias set trap eval exec echo cd test",
    literals: "true false",
  },
  sql: {
    line: ["--"],
    block: ["/*", "*/"],
    quotes: `"'`,
    nocase: true,
    keywords:
      "add all alter and any as asc between by case check column commit constraint create cross database default delete desc distinct drop else end exists foreign from full group having in index inner insert into is join key left like limit not null offset on or order outer primary references right rollback select set table then top union unique update values view when where with",
    literals: "true false null",
  },
  css: {
    block: ["/*", "*/"],
    line: ["//"],
    quotes: `"'`,
    keywords: "important media import charset keyframes font-face supports layer container",
    mode: "css",
  },
  markup: { keywords: "", quotes: `"'`, block: ["<!--", "-->"], mode: "markup" },
  json: { keywords: "", literals: "true false null", quotes: `"`, mode: "json" },
  kv: {
    keywords: "",
    literals: "true false null yes no on off True False",
    line: ["#"],
    quotes: `"'`,
    mode: "kv",
  },
  markdown: { keywords: "", quotes: "`", mode: "markdown" },
};

const BY_EXT: Record<string, string> = {
  js: "js", jsx: "js", mjs: "js", cjs: "js", ts: "js", tsx: "js", mts: "js", cts: "js", vue: "markup", svelte: "markup",
  rs: "rust", py: "python", pyw: "python", go: "go", java: "java", kt: "java", kts: "java", scala: "java",
  c: "c", h: "c", cc: "c", cpp: "c", cxx: "c", hpp: "c", hh: "c", m: "c", mm: "c",
  cs: "csharp", swift: "swift", rb: "ruby", php: "php",
  sh: "shell", bash: "shell", zsh: "shell", ps1: "shell", bat: "shell",
  sql: "sql", css: "css", scss: "css", less: "css",
  html: "markup", htm: "markup", xml: "markup", svg: "markup", xaml: "markup", csproj: "markup", plist: "markup",
  json: "json", jsonc: "json", json5: "json", webmanifest: "json",
  yml: "kv", yaml: "kv", toml: "kv", ini: "kv", cfg: "kv", conf: "kv", properties: "kv", env: "kv", lock: "kv",
  md: "markdown", markdown: "markdown", mdx: "markdown",
};

const BY_NAME: Record<string, string> = {
  dockerfile: "shell", makefile: "shell", ".bashrc": "shell", ".zshrc": "shell", ".gitignore": "kv", ".gitattributes": "kv", ".editorconfig": "kv",
};

/** Which grammar a file gets, or null when it is shown without colours. */
export function languageFor(path: string): string | null {
  const name = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name];
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? (BY_EXT[name.slice(dot + 1)] ?? null) : null;
}

const WORDS = new Map<string, Set<string>>();
function words(list: string | undefined, nocase?: boolean): Set<string> {
  const key = `${nocase ? "i" : "s"}:${list ?? ""}`;
  let set = WORDS.get(key);
  if (!set) {
    set = new Set((list ?? "").split(/\s+/).filter(Boolean).map((w) => (nocase ? w.toLowerCase() : w)));
    WORDS.set(key, set);
  }
  return set;
}

const IDENT = /[A-Za-z_$][\w$]*/y;
const IDENT_DASH = /[A-Za-z_$][\w$-]*/y;
const NUM = /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[A-Za-z%]*/y;
const TAG = /<\/?[A-Za-z][\w:.-]*/y;
const CHAR = /'(?:\\.|[^\\'])'/y;
const VAR = /\$(?:\{[^}]*\}|[A-Za-z_]\w*|[0-9@#?*!$-])/y;
const HEX = /#[\da-fA-F]{3,8}\b/y;

function push(out: Token[], text: string, kind: TokenKind) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.kind === kind) last.text += text;
  else out.push({ text, kind });
}

/** Tokenises one line of `lang`, given what the previous line left open. */
export function tokenize(lang: string, line: string, state: State = START): { tokens: Token[]; state: State } {
  const def = LANGS[lang];
  if (!def) return { tokens: [{ text: line, kind: "plain" }], state };
  const out: Token[] = [];
  let { block, triple } = state;
  const n = line.length;
  let i = 0;
  const kw = words(def.keywords, def.nocase);
  const lit = words(def.literals, def.nocase);

  if (def.mode === "markdown") {
    if (/^\s{0,3}#{1,6}\s/.test(line)) return { tokens: [{ text: line, kind: "kw" }], state };
    if (/^\s*(```|~~~)/.test(line)) return { tokens: [{ text: line, kind: "com" }], state };
  }

  // `key:` or `key =` at the start of a config line.
  if (def.mode === "kv" && !block && !triple) {
    const m = /^(\s*(?:-\s+)?)(\[[^\]]*\]|[\w.\-"'/@ ]+?)(\s*[:=])(?=\s|$)/.exec(line);
    if (m && !m[2].trimStart().startsWith("#")) {
      push(out, m[1], "plain");
      push(out, m[2], m[2].startsWith("[") ? "tag" : "prop");
      push(out, m[3], "plain");
      i = m[0].length;
    }
  }

  while (i < n) {
    if (block && def.block) {
      const end = line.indexOf(def.block[1], i);
      if (end < 0) {
        push(out, line.slice(i), "com");
        i = n;
      } else {
        push(out, line.slice(i, end + def.block[1].length), "com");
        i = end + def.block[1].length;
        block = false;
      }
      continue;
    }
    if (triple) {
      const end = line.indexOf(triple, i);
      if (end < 0) {
        push(out, line.slice(i), "str");
        i = n;
      } else {
        push(out, line.slice(i, end + 3), "str");
        i = end + 3;
        triple = null;
      }
      continue;
    }

    const ch = line[i];
    const rest = line.slice(i, i + 4);

    if (def.line?.some((c) => line.startsWith(c, i))) {
      push(out, line.slice(i), "com");
      break;
    }
    if (def.block && line.startsWith(def.block[0], i)) {
      block = true;
      push(out, def.block[0], "com");
      i += def.block[0].length;
      continue;
    }
    const tq = def.triple?.find((t) => rest.startsWith(t));
    if (tq) {
      triple = tq;
      push(out, tq, "str");
      i += 3;
      continue;
    }
    if (def.charLit && ch === "'") {
      CHAR.lastIndex = i;
      const m = CHAR.exec(line);
      if (m) {
        push(out, m[0], "str");
        i += m[0].length;
        continue;
      }
      // A lifetime such as 'a.
      IDENT.lastIndex = i + 1;
      const life = IDENT.exec(line);
      push(out, life ? `'${life[0]}` : "'", "typ");
      i += life ? life[0].length + 1 : 1;
      continue;
    }
    if (def.quotes?.includes(ch)) {
      let j = i + 1;
      while (j < n && line[j] !== ch) j += line[j] === "\\" ? 2 : 1;
      j = Math.min(n, j + 1);
      const text = line.slice(i, j);
      // A JSON key.
      const next = line.slice(j).trimStart()[0];
      push(out, text, def.mode === "json" && next === ":" ? "prop" : "str");
      i = j;
      continue;
    }
    if (def.mode === "markup") {
      TAG.lastIndex = i;
      const m = TAG.exec(line);
      if (m) {
        push(out, m[0], "tag");
        i += m[0].length;
        continue;
      }
      if (ch === ">" || line.startsWith("/>", i)) {
        const len = ch === ">" ? 1 : 2;
        push(out, line.slice(i, i + len), "tag");
        i += len;
        continue;
      }
    }
    if (def.vars && ch === "$") {
      VAR.lastIndex = i;
      const m = VAR.exec(line);
      if (m) {
        push(out, m[0], "typ");
        i += m[0].length;
        continue;
      }
    }
    if (def.mode === "css") {
      if (ch === "@") {
        IDENT_DASH.lastIndex = i + 1;
        const m = IDENT_DASH.exec(line);
        if (m) {
          push(out, `@${m[0]}`, "kw");
          i += m[0].length + 1;
          continue;
        }
      }
      if (ch === "#") {
        HEX.lastIndex = i;
        const m = HEX.exec(line);
        if (m) {
          push(out, m[0], "num");
          i += m[0].length;
          continue;
        }
      }
    }
    if (/\d/.test(ch)) {
      NUM.lastIndex = i;
      const m = NUM.exec(line);
      if (m) {
        push(out, m[0], "num");
        i += m[0].length;
        continue;
      }
    }

    const ident = def.mode === "css" ? IDENT_DASH : IDENT;
    ident.lastIndex = i;
    const m = /[A-Za-z_$]/.test(ch) ? ident.exec(line) : null;
    if (m) {
      const word = m[0];
      const key = def.nocase ? word.toLowerCase() : word;
      const after = line.slice(i + word.length).trimStart()[0];
      let kind: TokenKind = "plain";
      if (kw.has(key)) kind = "kw";
      else if (lit.has(key)) kind = "lit";
      else if (def.mode === "markup" && line[i + word.length] === "=") kind = "attr";
      else if (def.mode === "css" && after === ":" && !line.includes("{")) kind = "prop";
      else if (def.calls && after === "(") kind = "fn";
      else if (def.types && /^[A-Z][A-Za-z0-9_]*[a-z]/.test(word)) kind = "typ";
      push(out, word, kind);
      i += word.length;
      continue;
    }

    push(out, ch, "plain");
    i += 1;
  }
  return { tokens: out, state: { block, triple } };
}

/** A token split at the edges of a changed range. */
export interface Segment {
  text: string;
  kind: TokenKind;
  changed: boolean;
}

/** Marks which parts of the tokens fall inside `ranges` (sorted, non-overlapping `[start, end)`). */
export function applyRanges(tokens: Token[], ranges: [number, number][] | undefined): Segment[] {
  if (!ranges || ranges.length === 0) return tokens.map((t) => ({ ...t, changed: false }));
  const out: Segment[] = [];
  let pos = 0;
  let r = 0;
  for (const t of tokens) {
    let start = 0;
    const end = t.text.length;
    while (start < end) {
      while (r < ranges.length && ranges[r][1] <= pos + start) r++;
      const at = pos + start;
      const [rs, re] = ranges[r] ?? [Infinity, Infinity];
      if (at >= rs) {
        const stop = Math.min(end, re - pos);
        out.push({ text: t.text.slice(start, stop), kind: t.kind, changed: true });
        start = stop;
      } else {
        const stop = Math.min(end, rs - pos);
        out.push({ text: t.text.slice(start, stop), kind: t.kind, changed: false });
        start = stop;
      }
    }
    pos += end;
  }
  return out;
}
