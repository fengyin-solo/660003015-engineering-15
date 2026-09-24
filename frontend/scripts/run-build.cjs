/**
 * build.ts 的启动器：用项目内的 esbuild 把 TS 构建脚本转译成 CJS 后运行。
 * 不做任何构建逻辑，只负责引导，保证 npm run build 在 Node 20 下可直接执行。
 */
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { transformSync } = require('esbuild');

const scriptPath = join(__dirname, 'build.ts');
const source = readFileSync(scriptPath, 'utf8');
const { code } = transformSync(source, {
  loader: 'ts',
  format: 'cjs',
  target: 'node20',
  sourcemap: 'inline',
});

const module_ = { exports: {} };
new Function('require', 'module', 'exports', '__dirname', '__filename', code)(
  require,
  module_,
  module_.exports,
  __dirname,
  scriptPath
);
