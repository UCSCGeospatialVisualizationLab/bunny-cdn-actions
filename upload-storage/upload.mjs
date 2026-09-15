#!/usr/bin/env node
/**
 * Upload a build directory to Bunny Storage (hashed files first, then the rest).
 *
 * Usage:
 *   node upload.mjs --self-check
 *   node upload.mjs <buildDir> <hashedDir> [remotePrefix] [--dry-run]
 *
 * Env: BUNNY_STORAGE_ZONE, BUNNY_STORAGE_HOST
 *      BUNNY_STORAGE_PASSWORD (unless --dry-run)
 */
import assert from 'node:assert/strict'
import { createReadStream } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, posix, relative, sep } from 'node:path'

function parseArgs(argv) {
  const out = { selfCheck: false, dryRun: false, positional: [] }
  for (const a of argv) {
    if (a === '--self-check') out.selfCheck = true
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--') continue
    else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`)
    else out.positional.push(a)
  }
  return out
}

function remotePath(buildDir, remotePrefix, abs) {
  const rel = relative(buildDir, abs).split(sep).join(posix.sep)
  return [remotePrefix, rel].filter(Boolean).join('/')
}

function isHashed(remote, hashedDir) {
  return remote === hashedDir || remote.startsWith(`${hashedDir}/`) || remote.includes(`/${hashedDir}/`)
}

function selfCheck() {
  assert.equal(remotePath('/app/dist', '', '/app/dist/index.html'), 'index.html')
  assert.equal(remotePath('/app/dist', 'pr-1', '/app/dist/assets/x.js'), 'pr-1/assets/x.js')
  assert.equal(isHashed('assets/x.js', 'assets'), true)
  assert.equal(isHashed('static/js/x.js', 'static'), true)
  assert.equal(isHashed('index.html', 'assets'), false)
}

async function walk(dir) {
  const out = []
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) out.push(...(await walk(p)))
    else out.push(p)
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  selfCheck()
  if (args.selfCheck) {
    console.log('OK: upload.mjs self-check')
    return
  }

  const [buildDir, hashedDir, remotePrefix = ''] = args.positional
  const zone = process.env.BUNNY_STORAGE_ZONE
  const key = process.env.BUNNY_STORAGE_PASSWORD
  const host = process.env.BUNNY_STORAGE_HOST
  if (!buildDir || !hashedDir || !zone || !host || (!args.dryRun && !key)) {
    console.error('usage: upload.mjs <buildDir> <hashedDir> [remotePrefix] [--dry-run]')
    console.error('needs BUNNY_STORAGE_ZONE, BUNNY_STORAGE_HOST')
    console.error('needs BUNNY_STORAGE_PASSWORD unless --dry-run')
    process.exit(1)
  }

  async function put(abs) {
    const dest = remotePath(buildDir, remotePrefix, abs)
    const url = `https://${host}/${zone}/${dest.split('/').map(encodeURIComponent).join('/')}`
    if (args.dryRun) {
      console.log(`dry-run PUT ${url}`)
      return
    }
    const res = await fetch(url, {
      method: 'PUT',
      headers: { AccessKey: key },
      body: createReadStream(abs),
      duplex: 'half',
    })
    if (!res.ok) {
      throw new Error(`PUT ${dest} -> ${res.status} ${await res.text()}`)
    }
    console.log(dest)
  }

  // Bunny Storage has no batch/sync API. Ceiling = one PUT per file;
  // upgrade to rclone/s3-compat if a zone ever has thousands of shell files.
  const files = await walk(buildDir)
  const hashed = files.filter((f) => isHashed(remotePath(buildDir, remotePrefix, f), hashedDir))
  const rest = files.filter((f) => !hashed.includes(f))
  if (args.dryRun) console.log(`dry-run: ${hashed.length} hashed, ${rest.length} rest`)
  for (const f of hashed) await put(f)
  for (const f of rest) await put(f)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
