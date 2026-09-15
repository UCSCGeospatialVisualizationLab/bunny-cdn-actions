#!/usr/bin/env node
/**
 * Copy catalog S3 objects from Nautilus to the app Bunny Storage zone.
 *
 * Catalog = one `bucket/key` path per line (`#` comments and blanks ok).
 * Trailing slash = prefix copy. `.m3u8` copies the parent prefix (HLS segments).
 *
 * Usage:
 *   node copy.mjs --self-check
 *   node copy.mjs --catalog-file paths.txt --check-source-only
 *   node copy.mjs --catalog-file paths.txt [--dry-run]
 *
 * Env (check-source-only): NAUTILUS_ACCESS_KEY_ID, NAUTILUS_SECRET_ACCESS_KEY
 * Env (copy / dry-run): those plus BUNNY_STORAGE_ZONE,
 *             BUNNY_STORAGE_PASSWORD, BUNNY_STORAGE_HOST
 */
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const NAUTILUS_S3_HOST_DEFAULT = 's3-west.nrp-nautilus.io'

function parseArgs(argv) {
  const out = {
    selfCheck: false,
    checkSourceOnly: false,
    dryRun: false,
    catalogFile: '',
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--self-check') out.selfCheck = true
    else if (a === '--check-source-only') out.checkSourceOnly = true
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--catalog-file') {
      out.catalogFile = argv[++i] || ''
      if (!out.catalogFile) throw new Error('--catalog-file needs a path')
    } else if (a.startsWith('--')) {
      throw new Error(`unknown flag: ${a}`)
    } else {
      throw new Error(`unexpected arg: ${a}`)
    }
  }
  return out
}

/** Catalog lists .m3u8 only; HLS needs sibling .ts segments.
 * Copy the parent prefix for playlists. Trailing slash = whole prefix.
 * Upgrade: parse the m3u8 if a folder ever grows files the player does not reference. */
function copyTarget(s3Path) {
  if (s3Path.endsWith('/')) return { prefix: s3Path.replace(/\/+$/, '') }
  if (s3Path.endsWith('.m3u8')) return { prefix: s3Path.replace(/\/[^/]+$/, '') }
  return { key: s3Path }
}

function parseCatalog(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean)
}

function selfCheck() {
  assert.deepEqual(copyTarget('nbs-adapts-videos/foo/foo.m3u8'), {
    prefix: 'nbs-adapts-videos/foo',
  })
  assert.deepEqual(copyTarget('cl-lake-test/global-102925/vector/ACA_v2.pmtiles'), {
    key: 'cl-lake-test/global-102925/vector/ACA_v2.pmtiles',
  })
  assert.deepEqual(copyTarget('vizlab-geodatalake-exports/cosmos-adapts/raster/sedero/09-02-26/'), {
    prefix: 'vizlab-geodatalake-exports/cosmos-adapts/raster/sedero/09-02-26',
  })
  assert.deepEqual(parseCatalog('# comment\n\na/b.pmtiles\nc/d/  # prefix\n'), [
    'a/b.pmtiles',
    'c/d/',
  ])
  assert.equal(s3EndpointFromStorageHost('ny.storage.bunnycdn.com'), 'ny-s3.storage.bunnycdn.com')
  assert.equal(
    s3EndpointFromStorageHost('https://ny-s3.storage.bunnycdn.com/'),
    'ny-s3.storage.bunnycdn.com'
  )
  assert.equal(s3EndpointFromStorageHost('storage.bunnycdn.com'), 'de-s3.storage.bunnycdn.com')
}

function requireEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`missing ${name}`)
  return value
}

function stripScheme(host) {
  return host.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

/** HTTP API host → S3 API host. */
function s3EndpointFromStorageHost(host) {
  const h = stripScheme(host)
  if (/^[a-z]+-s3\.storage\.bunnycdn\.com$/i.test(h)) return h
  if (/^storage\.bunnycdn\.com$/i.test(h)) return 'de-s3.storage.bunnycdn.com'
  const http = h.match(/^([a-z]+)\.storage\.bunnycdn\.com$/i)
  if (http?.[1]) return `${http[1]}-s3.storage.bunnycdn.com`
  throw new Error(`unrecognized BUNNY_STORAGE_HOST: ${h}`)
}

function regionFromBunnyHost(host) {
  const match = stripScheme(host).match(/^([a-z]+)-s3\.storage\.bunnycdn\.com$/i)
  return match?.[1] ?? 'ny'
}

function configureNautilus() {
  process.env.RCLONE_CONFIG_NAUTILUS_TYPE = 's3'
  process.env.RCLONE_CONFIG_NAUTILUS_PROVIDER = 'Ceph'
  process.env.RCLONE_CONFIG_NAUTILUS_ACCESS_KEY_ID = requireEnv('NAUTILUS_ACCESS_KEY_ID')
  process.env.RCLONE_CONFIG_NAUTILUS_SECRET_ACCESS_KEY = requireEnv('NAUTILUS_SECRET_ACCESS_KEY')
  process.env.RCLONE_CONFIG_NAUTILUS_ENDPOINT = stripScheme(
    process.env.NAUTILUS_S3_HOST || NAUTILUS_S3_HOST_DEFAULT
  )
  process.env.RCLONE_CONFIG_NAUTILUS_FORCE_PATH_STYLE = 'true'
  process.env.RCLONE_CONFIG_NAUTILUS_NO_CHECK_BUCKET = 'true'
  process.env.RCLONE_CONFIG_NAUTILUS_REGION = 'us-east-1'
}

function configureBunny() {
  const zone = requireEnv('BUNNY_STORAGE_ZONE')
  const host = s3EndpointFromStorageHost(requireEnv('BUNNY_STORAGE_HOST'))
  process.env.RCLONE_CONFIG_BUNNY_TYPE = 's3'
  process.env.RCLONE_CONFIG_BUNNY_PROVIDER = 'Other'
  process.env.RCLONE_CONFIG_BUNNY_ACCESS_KEY_ID = zone
  process.env.RCLONE_CONFIG_BUNNY_SECRET_ACCESS_KEY = requireEnv('BUNNY_STORAGE_PASSWORD')
  process.env.RCLONE_CONFIG_BUNNY_ENDPOINT = host
  process.env.RCLONE_CONFIG_BUNNY_FORCE_PATH_STYLE = 'true'
  process.env.RCLONE_CONFIG_BUNNY_NO_CHECK_BUCKET = 'true'
  process.env.RCLONE_CONFIG_BUNNY_REGION = regionFromBunnyHost(host)
  return zone
}

function nautilusPath(s3Path) {
  return `nautilus:${s3Path}`
}

function bunnyPath(zone, s3Path) {
  return `bunny:${zone}/${s3Path}`
}

async function rcloneStat(remotePath) {
  try {
    const { stdout } = await execFileAsync('rclone', ['lsjson', '--stat', remotePath], {
      maxBuffer: 1024 * 1024,
    })
    return JSON.parse(stdout)
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error('rclone not found on PATH')
    }
    return null
  }
}

async function sourceSize(s3Path) {
  const stat = await rcloneStat(nautilusPath(s3Path))
  if (!stat || stat.IsDir || typeof stat.Size !== 'number') {
    throw new Error(`missing on Nautilus: ${s3Path}`)
  }
  return stat.Size
}

async function sourcePrefixExists(prefix) {
  // ponytail: lsjson one level is enough to prove the prefix is present; ceiling =
  // empty prefix that only has nested objects with no immediate children.
  try {
    const { stdout } = await execFileAsync(
      'rclone',
      ['lsjson', `${nautilusPath(prefix)}/`, '--max-depth', '1'],
      { maxBuffer: 8 * 1024 * 1024 }
    )
    const entries = JSON.parse(stdout)
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error(`empty or missing prefix on Nautilus: ${prefix}/`)
    }
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('rclone not found on PATH')
    if (err.message?.startsWith('empty or missing')) throw err
    throw new Error(`missing prefix on Nautilus: ${prefix}/`)
  }
}

function copyFlags(dryRun) {
  const flags = [
    '--size-only',
    '--s3-no-check-bucket',
    '--multi-thread-streams',
    '0',
    '--retries',
    '5',
    '--stats',
    '30s',
  ]
  if (dryRun) flags.push('--dry-run')
  return flags
}

function rclone(args) {
  return new Promise((resolve, reject) => {
    console.log(`rclone ${args.join(' ')}`)
    const child = spawn('rclone', args, { stdio: 'inherit' })
    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(new Error('rclone not found on PATH'))
        return
      }
      reject(err)
    })
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`rclone exited ${code}`))
    })
  })
}

async function copyKey(s3Path, zone, srcSize, dryRun) {
  const dest = bunnyPath(zone, s3Path)
  const destStat = await rcloneStat(dest)
  if (destStat && !destStat.IsDir && destStat.Size === srcSize) {
    console.log(`skip (size match ${srcSize}): ${s3Path}`)
    return
  }
  await rclone(['copyto', nautilusPath(s3Path), dest, ...copyFlags(dryRun)])
}

async function copyPrefix(prefix, zone, dryRun) {
  await rclone([
    'copy',
    `${nautilusPath(prefix)}/`,
    `${bunnyPath(zone, prefix)}/`,
    ...copyFlags(dryRun),
  ])
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  selfCheck()
  if (args.selfCheck) {
    console.log('OK: copy.mjs self-check')
    return
  }

  if (!args.catalogFile) {
    throw new Error('usage: node copy.mjs --catalog-file <path> [--check-source-only] [--dry-run]')
  }

  const catalog = parseCatalog(await readFile(args.catalogFile, 'utf8'))
  if (catalog.length === 0) throw new Error(`empty catalog: ${args.catalogFile}`)

  configureNautilus()
  const zone = args.checkSourceOnly ? '' : configureBunny()

  for (const s3Path of catalog) {
    console.log(`=== ${s3Path} ===`)
    const target = copyTarget(s3Path)

    if (target.prefix) {
      if (args.checkSourceOnly) {
        await sourcePrefixExists(target.prefix)
        console.log(`  nautilus prefix present: ${target.prefix}/`)
        continue
      }
      await copyPrefix(target.prefix, zone, args.dryRun)
      continue
    }

    const srcSize = await sourceSize(s3Path)
    console.log(`  nautilus size: ${srcSize}`)
    if (args.checkSourceOnly) continue
    await copyKey(target.key, zone, srcSize, args.dryRun)
  }

  const ok = args.checkSourceOnly
    ? `OK: ${catalog.length} catalog objects exist on Nautilus.`
    : args.dryRun
      ? `OK: dry-run for ${catalog.length} catalog objects (nothing written).`
      : `OK: ${catalog.length} catalog objects synced to Bunny Storage.`
  console.log(ok)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
