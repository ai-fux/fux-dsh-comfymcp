#!/usr/bin/env node
/**
 * 生成长驻宿主进程的全新模块树：Node ESM 按 URL 缓存模块记录（含失败记录），
 * 热更场景必须给出从未加载过的 URL。本脚本把 index.js 与 lib/ 复制为
 * plugin-entry.mjs 与 runtime-v<N>/（import 路径同步改写，N 递增）。
 * index.js + lib/ 仍是规范源码；每次改动后重跑本脚本再 reinstall。
 */
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)

// 递增版本号，取一个尚未存在的 runtime-v<N>
let version = 1
while (existsSync(join(root, `runtime-v${version}`))) version++
const runtimeDir = `runtime-v${version}`

cpSync(join(root, 'lib'), join(root, runtimeDir), { recursive: true })

const entry = readFileSync(join(root, 'index.js'), 'utf8')
  .replaceAll("'./lib/", `'./${runtimeDir}/`)
  .replaceAll('"./lib/', `"./${runtimeDir}/`)
writeFileSync(join(root, 'plugin-entry.mjs'), entry)

console.log(`plugin-entry.mjs + ${runtimeDir}/ regenerated`)
