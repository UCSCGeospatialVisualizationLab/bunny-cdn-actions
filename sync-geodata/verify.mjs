#!/usr/bin/env node
/**
 * Smoke test: every catalog S3 path is geodata (not index.html) at
 * `${CDN_ASSETS_CDN_HOST}/${s3-path}`, reachable, and (for playlists)
 * edge-cached on a second fetch.
 *
 * Catalog = one `bucket/key` path per line (`#` comments and blanks ok).
 * Trailing-slash prefixes are skipped (no single URL to smoke).
 *
 * Usage:
 *   node verify.mjs --self-check
 *   node verify.mjs --catalog-file paths.txt
 *
 * Env:
 *   CDN_ASSETS_CDN_HOST  required host (CI sets vars.APP_URL)
 *   SKIP_EDGE_HIT=1      skip HIT check (cold PoP / pre-merge origin check)
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const skipEdgeHit = process.env.SKIP_EDGE_HIT === '1'

function parseArgs(argv) {
  const out = { selfCheck: false, catalogFile: '' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--self-check') out.selfCheck = true
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

function parseCatalog(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean)
}

function resolveHost(envValue) {
  const trimmed = envValue?.trim()
  if (!trimmed) throw new Error('missing CDN_ASSETS_CDN_HOST')
  return trimmed.replace(/\/$/, '')
}

function kind(pathOrUrl) {
  const p = pathOrUrl.toLowerCase()
  if (p.includes('.m3u8')) return 'hls'
  if (p.includes('.pmtiles')) return 'pmtiles'
  if (/\.(json|gpkg)(\?|$)/.test(p) || p.endsWith('.json') || p.endsWith('.gpkg')) {
    return 'generic'
  }
  return 'cog'
}

function selfCheck() {
  assert.equal(kind('a/b.pmtiles'), 'pmtiles')
  assert.equal(kind('a/b.m3u8'), 'hls')
  assert.equal(kind('a/b.tif'), 'cog')
  assert.equal(kind('a/manifest.json'), 'generic')
  assert.equal(kind('a/data.gpkg'), 'generic')
  assert.deepEqual(parseCatalog('# x\na/b.pmtiles\nc/d/\n'), ['a/b.pmtiles', 'c/d/'])
  assert.equal(resolveHost('https://example.com/'), 'https://example.com')
}

async function fetchOnce(url, range) {
  const dir = await mkdtemp(join(tmpdir(), 'cdn-smoke-'))
  const bodyPath = join(dir, 'body')
  const args = ['-sS', '-D', '-', '-o', bodyPath, '--max-time', '120']
  if (range) args.push('-H', `Range: ${range}`)
  args.push(url)
  try {
    const { stdout: headers } = await execFileAsync('curl', args, { maxBuffer: 2 * 1024 * 1024 })
    return { headers, body: await readFile(bodyPath) }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function statusLine(headers) {
  const lines = headers.split(/\r?\n/).filter((line) => /^HTTP\//.test(line))
  return lines.at(-1)?.trim() ?? ''
}

function headerValue(headers, name) {
  const match = headers.match(new RegExp(`^${name}:\\s*(.+)$`, 'im'))
  return match?.[1]?.trim()
}

function assertOk(label, headers) {
  const status = statusLine(headers)
  if (!/^HTTP\/\d(?:\.\d)?\s+(200|206)\b/.test(status)) {
    throw new Error(`${label}: expected 200/206, got ${status || '(no status)'}`)
  }
  return status
}

function assertNotHtml(label, headers, body) {
  const ct = headerValue(headers, 'content-type') ?? ''
  const preview = body.subarray(0, 512).toString('utf8')
  if (/text\/html/i.test(ct) || /^\s*<(!doctype\s+html|html)\b/i.test(preview)) {
    throw new Error(
      `${label}: got HTML (pull zone served the shell, not geodata). content-type=${ct || '(none)'}`
    )
  }
}

function assertPmtiles(label, body) {
  if (body.subarray(0, 7).toString('ascii') !== 'PMTiles') {
    throw new Error(`${label}: expected PMTiles magic bytes`)
  }
}

function assertTiff(label, body) {
  const little = body[0] === 0x49 && body[1] === 0x49
  const big = body[0] === 0x4d && body[1] === 0x4d
  if (!little && !big) {
    throw new Error(`${label}: expected TIFF/COG magic bytes`)
  }
}

function firstPlaylistUri(playlist) {
  for (const line of playlist.split(/\r?\n/).map((l) => l.trim())) {
    if (line && !line.startsWith('#')) return line
  }
}

async function assertHls(label, playlistUrl, body) {
  const text = body.toString('utf8')
  if (!text.includes('#EXTM3U')) {
    throw new Error(`${label}: expected HLS playlist (#EXTM3U)`)
  }
  const uri = firstPlaylistUri(text)
  if (!uri) throw new Error(`${label}: playlist has no media URI`)
  const mediaUrl = new URL(uri, playlistUrl).href
  const media = await fetchOnce(mediaUrl)
  const mediaStatus = assertOk(`${label} segment`, media.headers)
  assertNotHtml(`${label} segment`, media.headers, media.body)
  const mediaCache = headerValue(media.headers, 'cdn-cache') ?? '(none)'
  console.log(`  segment: ${mediaStatus} cdn-cache: ${mediaCache} ${mediaUrl}`)
  if (mediaUrl.endsWith('.m3u8')) {
    await assertHls(`${label} nested`, mediaUrl, media.body)
  }
}

async function checkTarget(label, url, expectEdgeCacheHit, range) {
  const assetKind = kind(url)
  console.log(`=== ${label} (${assetKind}) ===`)
  console.log(`  ${url}`)

  const first = await fetchOnce(url, range)
  const firstStatus = assertOk(label, first.headers)
  const firstCache = headerValue(first.headers, 'cdn-cache') ?? '(none)'
  console.log(`  request 1: ${firstStatus} cdn-cache: ${firstCache}`)
  assertNotHtml(label, first.headers, first.body)
  if (assetKind === 'pmtiles') assertPmtiles(label, first.body)
  if (assetKind === 'cog') assertTiff(label, first.body)
  if (assetKind === 'hls') await assertHls(label, url, first.body)
  // generic (.json / .gpkg): 200 + not HTML only

  const second = await fetchOnce(url, range)
  const secondStatus = assertOk(`${label} (2)`, second.headers)
  const secondCache = headerValue(second.headers, 'cdn-cache') ?? '(none)'
  console.log(`  request 2: ${secondStatus} cdn-cache: ${secondCache}`)
  assertNotHtml(`${label} (2)`, second.headers, second.body)

  if (expectEdgeCacheHit && !skipEdgeHit && !secondCache.toUpperCase().includes('HIT')) {
    throw new Error(`${label}: expected cdn-cache: HIT on second request, got ${secondCache}`)
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  selfCheck()
  if (args.selfCheck) {
    console.log('OK: verify.mjs self-check')
    return
  }

  if (!args.catalogFile) {
    throw new Error('usage: node verify.mjs --catalog-file <path>')
  }

  const cdnHost = resolveHost(process.env.CDN_ASSETS_CDN_HOST)
  const catalog = parseCatalog(await readFile(args.catalogFile, 'utf8'))
  if (catalog.length === 0) throw new Error(`empty catalog: ${args.catalogFile}`)

  console.log(`CDN host: ${cdnHost}${skipEdgeHit ? ' (SKIP_EDGE_HIT)' : ''}`)

  let checked = 0
  for (const s3Path of catalog) {
    if (s3Path.endsWith('/')) {
      console.log(`=== skip prefix (no single URL): ${s3Path} ===`)
      continue
    }
    const url = `${cdnHost}/${s3Path}`
    const range = s3Path.endsWith('.m3u8') ? undefined : 'bytes=0-16383'
    const label = s3Path.split('/').slice(-2).join('/')
    await checkTarget(label, url, range === undefined, range)
    checked++
  }

  console.log(`OK: ${checked} catalog URLs are geodata (not HTML).`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
