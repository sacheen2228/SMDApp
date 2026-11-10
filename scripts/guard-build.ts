/// <reference types="bun-types" />
//
// Cheap build guard — run before a commit or a deploy.
//
// It transpiles every TS/TSX file in src/, scripts/ and tests/ with Bun and
// parses it with TypeScript. That catches the class of edit that silently took
// every route down: unmatched braces / stray `export`, and duplicate lexical
// declarations (e.g. the same `const scanStats` three times). It does NOT
// typecheck (the repo intentionally ignores TS errors), so it stays fast.
//
//   bun scripts/guard-build.ts
//
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const ROOTS = ["src", "scripts", "tests"];
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "dist", "build", "coverage"]);

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|cts)$/.test(name)) out.push(p);
  }
}

const files: string[] = [];
for (const r of ROOTS) walk(join(ROOT, r), files);

const transpiler = new Bun.Transpiler({ loader: "tsx" });
let errors = 0;

for (const file of files) {
  const src = readFileSync(file, "utf8");
  const rel = relative(ROOT, file);
  const isTsx = file.endsWith(".tsx");
  let fileBad = false;

  // 1) Syntax: TypeScript parser diagnostics (missing braces, stray tokens).
  const sf = ts.createSourceFile(
    file,
    src,
    ts.ScriptTarget.Latest,
    true,
    isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  for (const d of sf.parseDiagnostics) {
    const { line, character } = sf.getLineAndCharacterOfPosition(d.start);
    console.error(`${rel}:${line + 1}:${character + 1}  ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
    fileBad = true;
  }

  // 2) Transpile: also catches scope errors the parser alone permits
  //    (duplicate `const`, duplicate function declarations, etc.).
  if (!fileBad) {
    try {
      transpiler.transformSync(src, isTsx ? "tsx" : "ts");
    } catch (err: any) {
      console.error(`${rel}  ${String(err?.message || err).split("\n")[0]}`);
      fileBad = true;
    }
  }

  if (fileBad) errors++;
}

if (errors > 0) {
  console.error(`\n✖ build guard failed — ${errors} broken file(s) of ${files.length}`);
  process.exit(1);
}
console.log(`✔ build guard passed — ${files.length} TS/TSX files compile`);
