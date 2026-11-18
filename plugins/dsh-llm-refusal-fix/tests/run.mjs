// Offline fixture runner.
//
// Why stage at all: the adapter under test is a copy of the one shipped inside
// DSH, so it imports `@deepseek-ai/*` packages that resolve from the DSH
// installation at runtime. A test run needs those packages from npm; installing
// them into the plugin directory would shadow DSH's own copies for every live
// session (LlmError identity is instance-based), so they are installed into a
// scratch dir instead and the adapter is imported from there.
//
// Usage: npm test   (or: node tests/run.mjs)
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const work = join(here, '.work');

// Pinned to the DSH release line this bundle vendors (0.2.2-rc.3).
const DEPS = {
	'@deepseek-ai/cosmokit': '^1.9.0',
	'@deepseek-ai/dsh-anonymous-user-id': '0.2.2-rc.3',
	'@deepseek-ai/dsh-atomic-write': '0.2.2-rc.3',
	'@deepseek-ai/dsh-attachment': '0.2.2-rc.3',
	'@deepseek-ai/dsh-home-paths': '0.2.2-rc.3',
	'@deepseek-ai/dsh-launch-environment': '0.2.2-rc.3',
	'@deepseek-ai/dsh-llm': '0.2.2-rc.3',
	'@deepseek-ai/dsh-timeout': '0.2.2-rc.3',
	'@deepseek-ai/dsh-util-values': '0.2.2-rc.3',
	'@deepseek-ai/schemastery': '^3.19.0',
	'eventsource-parser': '^3.1.1',
	semver: '^7.8.0',
};

await rm(work, { recursive: true, force: true });
await mkdir(join(work, 'lib'), { recursive: true });
await copyFile(join(root, 'lib', 'adapter.js'), join(work, 'lib', 'adapter.js'));
await writeFile(
	join(work, 'package.json'),
	JSON.stringify({ name: 'refusal-fix-fixtures', private: true, type: 'module', dependencies: DEPS }, null, 2),
);

console.log(`staging deps in ${work} ...`);
// .cmd shims need a shell on Windows; a single command string avoids the
// "args + shell" deprecation warning.
const install = spawnSync('npm install --no-audit --no-fund --loglevel=error', {
	cwd: work,
	stdio: 'inherit',
	shell: true,
});
if (install.status !== 0) {
	console.error(`npm install failed (exit ${install.status})`);
	process.exit(install.status ?? 1);
}

const { translate } = await import(pathToFileURL(join(work, 'lib', 'adapter.js')).href);
const { run } = await import(pathToFileURL(join(here, 'fixtures.mjs')).href);
const summary = await run(translate);

for (const entry of summary.results) {
	console.log(`${entry.pass ? 'PASS' : 'FAIL'}  ${entry.name}${entry.detail ? `\n      ${entry.detail}` : ''}`);
}
console.log(`\n${summary.passed}/${summary.total} cases passed (node ${process.version})`);
process.exitCode = summary.failed.length === 0 ? 0 : 1;
