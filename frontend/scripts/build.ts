/**
 * 分步构建编排：
 *   1. 环境预检   —— 工具链/平台原生依赖是否齐备（缺什么直接点名）
 *   2. 类型检查   —— vue-tsc --noEmit，单独输出通过/失败与错误数
 *   3. 样例数据校验 —— 三个内置预设（悬臂梁/桥梁桁架/简单框架）能求解且结果合理
 *   4. 生产打包   —— vite build 输出到临时暂存目录（绝不污染正式产物目录）
 *   5. 发布与汇总 —— 暂存目录原子替换 dist，扫描实际产物生成清单并核对
 *
 * 任何一步失败立即终止，打印失败步骤/原因/修复建议并清理暂存目录，
 * dist 中永远只保留上一次完整成功的产物，不会留下半成品。
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  rmSync,
  renameSync,
  readdirSync,
  statSync,
  readFileSync,
  writeFileSync,
  createReadStream,
} from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { join, resolve, relative, sep } from 'node:path';
import process from 'node:process';
import { build } from 'vite';
import { transformSync } from 'esbuild';

const ROOT = resolve(__dirname, '..');
const DIST = join(ROOT, 'dist');
const MANIFEST = 'build-manifest.json';

interface CheckResult {
  ok: boolean;
  detail: string;
  hint?: string;
}

// ─── 输出工具 ────────────────────────────────────────────────────────────────
const c = process.stdout.isTTY
  ? {
      dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
      green: (s: string) => `\x1b[32m${s}\x1b[0m`,
      red: (s: string) => `\x1b[31m${s}\x1b[0m`,
      yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
      cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
      bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
    }
  : { dim: (s: string) => s, green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s, cyan: (s: string) => s, bold: (s: string) => s };

function stepHeader(n: number, total: number, title: string) {
  console.log(`\n${c.cyan(`[${n}/${total}]`)} ${c.bold(title)}`);
}
function pass(detail: string) {
  console.log(`  ${c.green('✓ 通过')}  ${detail}`);
}
function fail(detail: string) {
  console.log(`  ${c.red('✗ 失败')}  ${detail}`);
}
function info(detail: string) {
  console.log(`  ${c.dim('·')} ${c.dim(detail)}`);
}
function hint(detail: string) {
  console.log(`  ${c.yellow('→ 修复建议')}  ${detail}`);
}

// ─── 步骤 1：环境预检 ──────────────────────────────────────────────────────────
function checkEnvironment(): CheckResult {
  const problems: string[] = [];
  const notes: string[] = [];

  // 1a. node_modules 是否安装
  if (!existsSync(join(ROOT, 'node_modules'))) {
    return {
      ok: false,
      detail: '缺少 node_modules（依赖未安装）',
      hint: '在 frontend/ 目录执行 npm install',
    };
  }

  // 1b. 关键工具链包是否就位
  const requiredPkgs: Record<string, string> = {
    typescript: 'tsc',
    'vue-tsc': 'vue-tsc（Vue SFC 类型检查）',
    vite: 'vite（打包器）',
    esbuild: 'esbuild（vite 依赖的转译器）',
    rollup: 'rollup（vite 依赖的打包内核）',
  };
  const missingPkgs: string[] = [];
  for (const [pkg, label] of Object.entries(requiredPkgs)) {
    const p = join(ROOT, 'node_modules', pkg, 'package.json');
    if (!existsSync(p)) missingPkgs.push(`${pkg}（${label}）`);
  }
  if (missingPkgs.length) {
    return {
      ok: false,
      detail: `缺少依赖包：${missingPkgs.join('、')}`,
      hint: '执行 npm install；若仍失败，删除 node_modules 后重新安装',
    };
  }

  // 1c. 平台原生依赖是否匹配（node_modules 跨平台拷贝时最常见的故障）
  const { platform, arch } = process;
  const isMusl = platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime;

  // esbuild: @esbuild/<platform>-<arch>，包内 bin/esbuild 必须可加载
  const esbuildPkg =
    platform === 'win32'
      ? `@esbuild/${platform}-${arch}`
      : `@esbuild/${platform}-${arch}`;
  try {
    const esbuild = require(join(ROOT, 'node_modules', 'esbuild'));
    esbuild.transformSync('const x: number = 1;', { loader: 'ts' });
    notes.push(`esbuild 原生二进制可用（${esbuildPkg}）`);
  } catch {
    problems.push(
      `esbuild 缺少当前平台二进制：需要 ${esbuildPkg}（node_modules 可能是在其他平台安装后拷贝过来的）`
    );
  }

  // rollup: @rollup/rollup-<platform>-<arch>[-gnu|musl]
  const rollupBase = (() => {
    const map: Record<string, Record<string, { base: string; musl?: string | null }>> = {
      linux: {
        arm: { base: 'linux-arm-gnueabihf', musl: 'linux-arm-musleabihf' },
        arm64: { base: 'linux-arm64-gnu', musl: 'linux-arm64-musl' },
        x64: { base: 'linux-x64-gnu', musl: 'linux-x64-musl' },
      },
      darwin: {
        arm64: { base: 'darwin-arm64' },
        x64: { base: 'darwin-x64' },
      },
      win32: {
        arm64: { base: 'win32-arm64-msvc' },
        ia32: { base: 'win32-ia32-msvc' },
        x64: { base: 'win32-x64-msvc' },
      },
    };
    const entry = map[platform]?.[arch];
    if (!entry) return null;
    if (platform === 'linux' && isMusl && entry.musl) return entry.musl;
    return entry.base;
  })();
  const rollupPkg = rollupBase ? `@rollup/rollup-${rollupBase}` : null;
  if (!rollupPkg || !existsSync(join(ROOT, 'node_modules', rollupPkg, 'package.json'))) {
    problems.push(
      rollupPkg
        ? `rollup 缺少当前平台原生包：${rollupPkg}`
        : `rollup 未提供当前平台（${platform}/${arch}）的预编译包`
    );
  } else {
    notes.push(`rollup 原生包就位（${rollupPkg}）`);
  }

  if (problems.length) {
    return {
      ok: false,
      detail: problems.join('；'),
      hint:
        `在当前平台执行：npm install --save-dev ${esbuildPkg}${rollupPkg ? ' ' + rollupPkg : ''}；` +
        '或删除 node_modules 后重新 npm install',
    };
  }
  return {
    ok: true,
    detail: `node ${process.version} / ${platform}-${arch}${isMusl ? ' (musl)' : ''}；${notes.join('；')}`,
  };
}

// ─── 步骤 2：类型检查 ──────────────────────────────────────────────────────────
function checkTypes(): CheckResult {
  const res = spawnSync(
    process.execPath,
    [join(ROOT, 'node_modules', 'vue-tsc', 'bin', 'vue-tsc.js'), '--noEmit'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();

  if (res.error) {
    return {
      ok: false,
      detail: `类型检查进程无法启动：${res.error.message}`,
      hint: '确认 node_modules 完整（npm install），Node 版本满足 package.json engines 要求',
    };
  }
  if (res.status !== 0) {
    const errors = output.split('\n').filter((l) => /error TS\d+:/.test(l));
    // vue-tsc 自身崩溃（如版本与 typescript 不兼容时的 "Search string not found"）
    if (errors.length === 0) {
      return {
        ok: false,
        detail: `vue-tsc 异常退出（code ${res.status}），未产生类型错误报告，疑似工具链版本不兼容：\n${indent(output, 6)}`,
        hint: '升级 vue-tsc 至 ^2（与 typescript 5.x 匹配）：npm install -D vue-tsc@^2',
      };
    }
    console.log(indent(output, 6));
    return {
      ok: false,
      detail: `TypeScript 类型检查未通过，共 ${errors.length} 处类型错误（见上方明细）`,
      hint: '按文件与 error TS 编号逐个修复；只有该步通过后才会进入打包',
    };
  }
  // exit 0 但有残留错误行的情况也当作失败，防止工具行为变化时漏判
  const strayErrors = output.split('\n').filter((l) => /error TS\d+:/.test(l));
  if (strayErrors.length > 0) {
    return {
      ok: false,
      detail: `vue-tsc 退出码为 0 但输出了 ${strayErrors.length} 条错误，请检查工具版本`,
    };
  }
  return { ok: true, detail: 'vue-tsc --noEmit 通过，src 下 .ts/.vue 无类型错误' };
}

// ─── 步骤 3：样例数据校验 ─────────────────────────────────────────────────────
/**
 * 应用的“样例数据”是 fea-solver.ts 内置的三个预设模型（非外部文件）。
 * 用 esbuild 把 solver 转译成当前 Node 可执行的模块后在本进程内实际求解，
 * 校验：预设存在 → 模型结构完整 → 能求解 → 结果为有限数值且符合物理直觉。
 */
async function checkSampleData(): Promise<CheckResult> {
  const solverPath = join(ROOT, 'src', 'utils', 'fea-solver.ts');
  if (!existsSync(solverPath)) {
    return {
      ok: false,
      detail: `样例数据源文件缺失：${relative(ROOT, solverPath)}`,
      hint: '恢复 src/utils/fea-solver.ts（三个预设模型与求解器均在其中）',
    };
  }

  const source = readFileSync(solverPath, 'utf8');
  const transformed = transformSync(source, {
    loader: 'ts',
    format: 'cjs',
    target: 'node20',
  });

  const mod = { exports: {} as Record<string, unknown> };
  const runner = new Function('module', 'exports', 'require', transformed.code);
  try {
    runner(mod, mod.exports, require);
  } catch (err) {
    return {
      ok: false,
      detail: `样例求解器无法加载（语法/运行时错误）：${(err as Error).message}`,
      hint: '检查 src/utils/fea-solver.ts 是否可被正常 import',
    };
  }
  const api = mod.exports;

  const presets: { key: string; fnName: string; label: string; minElements: number }[] = [
    { key: 'cantilever', fnName: 'presetCantileverBeam', label: '悬臂梁', minElements: 10 },
    { key: 'bridge', fnName: 'presetBridgeTruss', label: '桥梁桁架', minElements: 10 },
    { key: 'frame', fnName: 'presetSimpleFrame', label: '简单框架', minElements: 10 },
  ];

  const summaries: string[] = [];
  for (const preset of presets) {
    const factory = api[preset.fnName];
    if (typeof factory !== 'function') {
      return {
        ok: false,
        detail: `样例数据缺失：预设「${preset.label}」的导出 ${preset.fnName} 不存在`,
        hint: `在 fea-solver.ts 中恢复导出函数 ${preset.fnName}`,
      };
    }

    let model: any;
    try {
      model = factory();
    } catch (err) {
      return {
        ok: false,
        detail: `样例「${preset.label}」生成失败：${(err as Error).message}`,
      };
    }

    // 结构完整性
    const structural = validateModelStructure(model, preset.label);
    if (!structural.ok) return structural;

    // 实际求解
    const solve = api.solve;
    if (typeof solve !== 'function') {
      return { ok: false, detail: '求解器导出 solve 缺失，无法校验样例数据' };
    }
    let result: any;
    try {
      result = solve(model);
    } catch (err) {
      return {
        ok: false,
        detail: `样例「${preset.label}」求解过程中抛错：${(err as Error).message}`,
        hint: '通常是网格/边界条件数据损坏（节点引用缺失、零长度单元等）',
      };
    }

    const numerical = validateResult(result, model, preset);
    if (!numerical.ok) return numerical;

    summaries.push(
      `${preset.label}：${model.nodes.length} 节点 / ${model.elements.length} 单元 / ${model.loads.length} 载荷，` +
        `最大应力 ${(result.maxStress / 1e6).toFixed(2)} MPa，` +
        `最大位移 ${(result.maxDisplacement * 1000).toFixed(3)} mm`
    );
  }

  summaries.forEach((s) => info(s));
  return { ok: true, detail: `3 组样例数据完整且可求解（${presets.map((p) => p.label).join('、')}）` };
}

function validateModelStructure(model: any, label: string): CheckResult {
  const where = `样例「${label}」`;
  if (!model || typeof model !== 'object')
    return { ok: false, detail: `${where}未返回模型对象` };
  if (!Array.isArray(model.nodes) || model.nodes.length === 0)
    return { ok: false, detail: `${where}缺少节点数据（nodes 为空）` };
  if (!Array.isArray(model.elements) || model.elements.length === 0)
    return { ok: false, detail: `${where}缺少单元数据（elements 为空）` };
  if (!Array.isArray(model.loads))
    return { ok: false, detail: `${where}缺少载荷数组（loads）` };

  const nodeIds = new Set<number>();
  for (const n of model.nodes) {
    if (typeof n.id !== 'number' || !Number.isFinite(n.x) || !Number.isFinite(n.y))
      return { ok: false, detail: `${where}存在非法节点（id/坐标缺失或非数值）` };
    nodeIds.add(n.id);
  }
  for (const el of model.elements) {
    if (!Array.isArray(el.nodeIds) || el.nodeIds.length !== 2)
      return { ok: false, detail: `${where}单元 #${el.id} 的 nodeIds 必须是 2 个节点` };
    const [a, b] = el.nodeIds;
    if (!nodeIds.has(a) || !nodeIds.has(b))
      return { ok: false, detail: `${where}单元 #${el.id} 引用了不存在的节点（${a}, ${b}）` };
    if (a === b)
      return { ok: false, detail: `${where}单元 #${el.id} 两端为同一节点（零长度单元）` };
    if (!(el.area > 0) || !(el.youngsModulus > 0))
      return { ok: false, detail: `${where}单元 #${el.id} 的面积/弹性模量必须为正数` };
  }
  for (const ld of model.loads) {
    if (!nodeIds.has(ld.nodeId))
      return { ok: false, detail: `${where}载荷引用了不存在的节点 #${ld.nodeId}` };
  }
  if (!model.nodes.some((n: any) => n.fixed))
    return {
      ok: false,
      detail: `${where}没有任何固定约束（fixed 节点），体系为机构、无法求解`,
      hint: '检查预设的边界条件生成逻辑',
    };
  if (model.loads.length === 0)
    return { ok: false, detail: `${where}没有任何外加载荷，结果无意义` };
  return { ok: true, detail: '' };
}

function validateResult(result: any, model: any, preset: { label: string; minElements: number }): CheckResult {
  const where = `样例「${preset.label}」`;
  if (!result || typeof result !== 'object')
    return { ok: false, detail: `${where}求解未返回结果` };
  if (model.elements.length < preset.minElements)
    return {
      ok: false,
      detail: `${where}网格过稀：仅 ${model.elements.length} 个单元，预期 ≥ ${preset.minElements}`,
    };
  const arrays = ['displacements', 'stresses', 'strains'] as const;
  for (const key of arrays) {
    if (!Array.isArray(result[key]))
      return { ok: false, detail: `${where}求解结果缺少数组字段 ${key}` };
  }
  if (result.stresses.length !== model.elements.length)
    return {
      ok: false,
      detail: `${where}应力结果数量（${result.stresses.length}）与单元数量（${model.elements.length}）不一致`,
    };
  const allValues = [...result.displacements, ...result.stresses, ...result.strains];
  if (!allValues.every((v: unknown) => typeof v === 'number' && Number.isFinite(v)))
    return { ok: false, detail: `${where}求解结果含 NaN/Infinity，矩阵可能奇异（约束不足？）` };
  if (!(result.maxDisplacement > 0))
    return {
      ok: false,
      detail: `${where}最大位移为 0 或非法，外载下结构应有变形`,
      hint: '检查边界条件与载荷是否实际生效',
    };
  if (!(result.maxStress > 0))
    return { ok: false, detail: `${where}最大应力为 0 或非法` };
  // 合理性护栏：位移超过米级、应力超过钢材理论强度量级，基本意味着单位/数据损坏
  if (result.maxDisplacement > 1)
    return {
      ok: false,
      detail: `${where}最大位移 ${result.maxDisplacement} m 异常偏大（>1m），请检查样例数据单位`,
    };
  if (Math.abs(result.maxStress) > 1e15)
    return {
      ok: false,
      detail: `${where}最大应力 ${result.maxStress} Pa 异常偏大，求解可能发散`,
    };
  return { ok: true, detail: '' };
}

// ─── 步骤 4：生产打包（输出到暂存目录）────────────────────────────────────────
async function runBundle(stageDir: string): Promise<CheckResult> {
  let chunks = 0;
  try {
    await build({
      root: ROOT,
      logLevel: 'info',
      configFile: join(ROOT, 'vite.config.ts'),
      build: {
        outDir: stageDir,
        emptyOutDir: true,
        sourcemap: false,
      },
      plugins: [
        {
          name: 'build-orchestrator-count',
          generateBundle() {
            chunks++;
          },
        },
      ],
    });
  } catch (err) {
    return {
      ok: false,
      detail: `vite 打包中断：${(err as Error).message.split('\n')[0]}`,
      hint: '通常是源码 import 解析失败、平台原生依赖缺失或配置错误；上方为 vite 原始输出',
    };
  }

  if (!existsSync(join(stageDir, 'index.html'))) {
    return {
      ok: false,
      detail: '打包结束但暂存目录中缺少 index.html，产物不完整',
      hint: '检查 vite.config.ts 的 build 配置与 index.html 入口',
    };
  }
  const files = listFiles(stageDir);
  if (files.length === 1) {
    return { ok: false, detail: '暂存目录只有 index.html，没有任何 JS/CSS 资源，打包不完整' };
  }
  return {
    ok: true,
    detail: `打包完成，${files.length} 个文件输出到暂存目录（含 ${chunks} 个 chunk）`,
  };
}

// ─── 步骤 5：发布 + 产物清单 ──────────────────────────────────────────────────
interface ManifestEntry {
  path: string;
  bytes: number;
  sha256: string;
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out.sort();
}

function hashFile(file: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const h = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('error', rejectPromise);
    stream.on('data', (chunk) => h.update(chunk));
    stream.on('end', () => resolvePromise(h.digest('hex')));
  });
}

async function publishAndManifest(stageDir: string): Promise<CheckResult> {
  const files = listFiles(stageDir);
  const entries: ManifestEntry[] = [];
  for (const f of files) {
    entries.push({
      path: relative(stageDir, f).split(sep).join('/'),
      bytes: statSync(f).size,
      sha256: await hashFile(f),
    });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));

  const manifest = {
    buildTime: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    fileCount: entries.length,
    totalBytes: entries.reduce((s, e) => s + e.bytes, 0),
    files: entries,
  };
  writeFileSync(join(stageDir, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');

  // 原子替换：dist 旧产物先改名，暂存目录整体 rename 上位；
  // 任一环节失败则回滚，保证 dist 不出现新旧混杂。
  const backup = `${DIST}.old-${process.pid}`;
  let hadOld = false;
  try {
    if (existsSync(DIST)) {
      renameSync(DIST, backup);
      hadOld = true;
    }
    renameSync(stageDir, DIST);
    if (hadOld) rmSync(backup, { recursive: true, force: true });
  } catch (err) {
    if (existsSync(backup) && !existsSync(DIST)) {
      try {
        renameSync(backup, DIST);
      } catch {
        /* 回滚也失败时交给上层报错，暂存目录仍在磁盘上 */
      }
    }
    return {
      ok: false,
      detail: `产物发布到 dist 失败：${(err as Error).message}（已尝试回滚到上一版本）`,
    };
  }

  // 发布后重新扫描 dist，与清单逐项核对（防止“清单写的”和“目录里的”不一致）
  const verify = verifyManifest(DIST);
  if (!verify.ok) return verify;

  const kb = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(2)} KB` : `${n} B`);
  console.log(`  ${c.bold('本次构建产物清单')}（${manifest.fileCount} 个文件，合计 ${kb(manifest.totalBytes)}）：`);
  for (const e of entries) {
    console.log(`    ${c.green('·')} ${e.path}  ${c.dim(kb(e.bytes) + '  sha256:' + e.sha256.slice(0, 12) + '…')}`);
  }
  console.log(`    ${c.green('·')} ${MANIFEST}  ${c.dim('（含完整路径/大小/sha256，与目录实际内容已核对一致）')}`);
  return { ok: true, detail: '产物已原子发布至 dist/，清单与目录实际内容一致' };
}

function verifyManifest(dir: string): CheckResult {
  const manifestPath = join(dir, MANIFEST);
  if (!existsSync(manifestPath))
    return { ok: false, detail: '发布后校验失败：dist 中缺少清单文件' };
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    files: ManifestEntry[];
  };
  const actual = new Set(listFiles(dir).map((f) => relative(dir, f).split(sep).join('/')));
  const listed = new Set([...manifest.files.map((f) => f.path), MANIFEST]);
  const missing = [...listed].filter((p) => !actual.has(p));
  const extra = [...actual].filter((p) => !listed.has(p));
  if (missing.length || extra.length) {
    const parts: string[] = [];
    if (missing.length) parts.push(`清单有但目录缺失：${missing.join(', ')}`);
    if (extra.length) parts.push(`目录有但清单未记录：${extra.join(', ')}`);
    return { ok: false, detail: `产物清单与 dist 实际内容不一致：${parts.join('；')}` };
  }
  return { ok: true, detail: '' };
}

// ─── 辅助 ────────────────────────────────────────────────────────────────────
function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((l) => pad + l)
    .join('\n');
}

// ─── 主编排 ───────────────────────────────────────────────────────────────────
const TOTAL_STEPS = 5;

async function main() {
  console.log(c.bold('\n=== frontend 分步构建 ==='));

  const checks: { name: string; run: () => CheckResult | Promise<CheckResult> }[] = [
    { name: '环境预检（node_modules / 平台原生依赖）', run: checkEnvironment },
    { name: '类型检查（vue-tsc --noEmit）', run: checkTypes },
    { name: '样例数据校验（3 个内置预设模型实际求解）', run: checkSampleData },
  ];

  let stageDir: string | null = null;
  try {
    for (let i = 0; i < checks.length; i++) {
      stepHeader(i + 1, TOTAL_STEPS, checks[i].name);
      const r = await checks[i].run();
      if (r.ok) pass(r.detail);
      else {
        fail(r.detail);
        if (r.hint) hint(r.hint);
        return abort(i + 1, checks[i].name, stageDir);
      }
    }

    // 步骤 4：打包到独立暂存目录，失败与正式 dist 完全隔离。
    // 暂存目录必须与 dist 在同一文件系统上，步骤 5 才能用 rename 做原子替换
    // （放在 /tmp 下会触发 EXDEV: cross-device link not permitted）。
    stageDir = join(ROOT, `.build-stage-${process.pid}-${randomUUID()}`);
    mkdirSync(stageDir, { recursive: true });
    stepHeader(4, TOTAL_STEPS, '生产打包（vite build → 临时暂存目录）');
    info(`暂存目录：${stageDir}（与 dist 同文件系统，供原子替换）`);
    const bundleResult = await runBundle(stageDir);
    if (!bundleResult.ok) {
      fail(bundleResult.detail);
      if (bundleResult.hint) hint(bundleResult.hint);
      return abort(4, '生产打包', stageDir);
    }
    pass(bundleResult.detail);

    // 步骤 5：原子发布 + 清单核对
    stepHeader(5, TOTAL_STEPS, '发布产物并核对清单');
    const published = await publishAndManifest(stageDir);
    if (!published.ok) {
      fail(published.detail);
      return abort(5, '发布产物并核对清单', stageDir);
    }
    pass(published.detail);

    console.log(c.green(c.bold('\n✔ 构建全部成功')));
    console.log(c.dim(`产物目录：${DIST}`));
  } catch (err) {
    fail(`编排脚本发生未预期错误：${(err as Error).stack ?? (err as Error).message}`);
    cleanupStage(stageDir);
    process.exitCode = 1;
  }
}

function abort(stepNo: number, stepName: string, stageDir: string | null) {
  console.log(
    `\n${c.red(c.bold('✘ 构建失败'))} ${c.red(`停在第 ${stepNo}/${TOTAL_STEPS} 步：${stepName}`)}`
  );
  console.log(c.dim('后续步骤未执行；dist/ 仍为上一次成功构建的完整产物（若存在），无半成品残留。'));
  console.log(c.dim('修复后重新执行 npm run build 即可从头重试。'));
  cleanupStage(stageDir);
  process.exit(1);
}

function cleanupStage(stageDir: string | null) {
  if (stageDir && existsSync(stageDir)) {
    rmSync(stageDir, { recursive: true, force: true });
  }
  // 兜底：清理任何异常遗留的暂存/备份目录（均位于项目根，与 dist 同文件系统）
  if (!existsSync(ROOT)) return;
  for (const name of readdirSync(ROOT)) {
    if (name.startsWith('.build-stage-') || name.startsWith('dist.old-')) {
      rmSync(join(ROOT, name), { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
