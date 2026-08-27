// The single acceptance witness: build an index of this repository's own src/
// through the real CLI and answer a query from it. Requires a supported Node
// (this machine keeps scoop's nodejs-lts side-by-side for exactly this).
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'dist', 'bin', 'codegraph.js');
const graphDir = path.join(repo, '.codegraph');

const run = (args, opts = {}) =>
  execFileSync(process.execPath, [cli, ...args], {
    cwd: repo,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'inherit'],
    ...opts,
  });

rmSync(graphDir, { recursive: true, force: true });
run(['init'], { stdio: ['ignore', 'inherit', 'inherit'] });
if (!existsSync(path.join(graphDir, 'codegraph.db'))) {
  throw new Error('witness: init produced no .codegraph/codegraph.db');
}
const answer = run(['explore', 'resolveWasmPath']);
if (!answer.includes('grammars.ts')) {
  throw new Error('witness: explore did not surface the known symbol');
}
console.log('witness green: indexed own src and resolved a known symbol');
