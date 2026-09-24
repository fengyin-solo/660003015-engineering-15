#!/usr/bin/env node
/**
 * 分步构建脚本
 *
 * 每一步单独校验并报告结果；任一步失败时：
 *   - 指出是哪一步、缺什么、卡在哪个环节
 *   - 清理中间产物（暂存目录）和上一次遗留的旧产物，修复后可直接重试
 * 全部成功后发布产物并生成与实际目录一致的清单（dist/manifest.json）。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = path.join(root, 'dist')
const stagingDir = path.join(root, '.build-staging')

const isWin = process.platform === 'win32'
const bin = (name) => path.join(root, 'node_modules', '.bin', name + (isWin ? '.cmd' : ''))

// ---- 输出工具 ------------------------------------------------------------

const icons = { ok: '✓', fail: '✗', info: '·' }
const say = (icon, msg) => console.log(`  ${icon} ${msg}`)

function stepOk(name, detail) {
  console.log(`\n[${icons.ok}] ${name}`)
  if (detail) say(icons.info, detail)
}

function stepFail(name, reason, hints = []) {
  console.error(`\n[${icons.fail}] ${name} —— 失败`)
  console.error(`  原因: ${reason}`)
  for (const h of hints) console.error(`  提示: ${h}`)
}

// ---- 清理 ----------------------------------------------------------------

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
}

/** 失败时调用：清掉暂存目录与旧产物，保证重试时不会把旧结果当新结果。 */
function cleanupAfterFailure() {
  const removed = []
  if (fs.existsSync(stagingDir)) { rmrf(stagingDir); removed.push('.build-staging/') }
  if (fs.existsSync(distDir)) { rmrf(distDir); removed.push('dist/') }
  if (removed.length) {
    say(icons.info, `已清理 ${removed.join('、')}，未留下半成品，修复后可直接重新构建`)
  }
  process.exitCode = 1
}

// ---- 步骤 1：前置校验（依赖与必需输入） -----------------------------------

function checkPrerequisites() {
  const step = '步骤 1/4 前置校验（依赖与输入文件）'

  const missingDeps = []
  if (!fs.existsSync(bin('vue-tsc'))) missingDeps.push('vue-tsc')
  if (!fs.existsSync(bin('vite'))) missingDeps.push('vite')
  if (missingDeps.length) {
    stepFail(step, `缺少构建工具: ${missingDeps.join('、')}`, ['先在 frontend/ 下执行 npm install'])
    return false
  }

  // 构建必需的输入：入口、源码与样例/预设数据所在模块
  const required = [
    'index.html',
    'vite.config.ts',
    'tsconfig.json',
    'src/main.ts',
    'src/App.vue',
    'src/store/fea.ts',
    'src/utils/fea-solver.ts',
    'src/types/index.ts',
  ]
  const missing = required.filter((f) => !fs.existsSync(path.join(root, f)))
  if (missing.length) {
    stepFail(step, `缺少 ${missing.length} 个必需文件`, missing.map((f) => `缺失: ${f}`))
    return false
  }

  stepOk(step, `依赖齐全，${required.length} 个必需输入文件全部存在`)
  return true
}

// ---- 步骤 2：类型检查 -----------------------------------------------------

function runTypeCheck() {
  const step = '步骤 2/4 类型检查（vue-tsc）'
  const res = spawnSync(bin('vue-tsc'), [], { cwd: root, encoding: 'utf8', shell: isWin })
  const out = [res.stdout, res.stderr].filter(Boolean).join('\n').trim()

  if (res.error) {
    stepFail(step, `无法启动 vue-tsc: ${res.error.message}`)
    return false
  }
  if (res.status !== 0) {
    stepFail(step, '存在类型错误', out ? out.split('\n') : [])
    return false
  }
  stepOk(step, '无类型错误')
  return true
}

// ---- 步骤 3：打包（先构建到暂存目录，成功后才发布） -------------------------

function runBundle() {
  const step = '步骤 3/4 打包（vite build → 暂存目录）'
  rmrf(stagingDir)

  const res = spawnSync(
    bin('vite'),
    ['build', '--outDir', stagingDir, '--emptyOutDir'],
    { cwd: root, encoding: 'utf8', shell: isWin },
  )
  const out = [res.stdout, res.stderr].filter(Boolean).join('\n').trim()

  if (res.error) {
    stepFail(step, `无法启动 vite: ${res.error.message}`)
    return false
  }
  if (res.status !== 0) {
    stepFail(step, 'vite 打包中断', out ? out.split('\n').slice(-20) : [])
    return false
  }
  if (!fs.existsSync(path.join(stagingDir, 'index.html'))) {
    stepFail(step, '打包结束但暂存目录中没有 index.html，产物不完整')
    return false
  }
  stepOk(step, '打包完成，产物暂存于 .build-staging/（校验通过后才发布到 dist/）')
  return true
}

// ---- 步骤 4：产物校验、发布与清单 ------------------------------------------

function listFiles(dir) {
  const files = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...listFiles(full))
    else files.push(full)
  }
  return files.sort()
}

function publishAndManifest() {
  const step = '步骤 4/4 产物校验与发布'

  const staged = listFiles(stagingDir)
  if (staged.length === 0) {
    stepFail(step, '暂存目录为空，没有可发布的产物')
    return false
  }

  // 发布：用本次产物整体替换旧产物
  rmrf(distDir)
  fs.renameSync(stagingDir, distDir)

  // 清单：基于发布后的实际目录内容生成，保证一致
  const files = listFiles(distDir)
  const entries = files.map((full) => {
    const buf = fs.readFileSync(full)
    return {
      path: path.relative(distDir, full).split(path.sep).join('/'),
      bytes: buf.length,
      sha256: createHash('sha256').update(buf).digest('hex'),
    }
  })
  const total = entries.reduce((s, e) => s + e.bytes, 0)

  const manifest = {
    builtAt: new Date().toISOString(),
    fileCount: entries.length,
    totalBytes: total,
    files: entries,
  }
  fs.writeFileSync(path.join(distDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

  stepOk(step, `已发布到 dist/，共 ${entries.length} 个文件，${(total / 1024).toFixed(1)} KiB`)
  console.log('\n产物清单（与 dist/ 实际内容一致，已写入 dist/manifest.json）:')
  for (const e of entries) {
    console.log(`  ${(e.bytes / 1024).toFixed(1).padStart(9)} KiB  ${e.path}`)
  }
  return true
}

// ---- 主流程 ---------------------------------------------------------------

console.log('开始构建（分步校验，任一步失败即停止并清理）')

const steps = [checkPrerequisites, runTypeCheck, runBundle, publishAndManifest]
for (const step of steps) {
  if (!step()) {
    cleanupAfterFailure()
    process.exit(1)
  }
}

console.log('\n构建成功：所有步骤校验通过，产物已发布到 dist/')
