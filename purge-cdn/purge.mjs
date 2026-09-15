#!/usr/bin/env node
/**
 * Purge Bunny CDN URLs for stable shell paths (not hashed bundles).
 *
 * Usage:
 *   node purge.mjs --self-check
 *   node purge.mjs --app-url <https://host> --paths-file <file> [--dry-run]
 *
 * Env: BUNNY_CDN_API_KEY (unless --dry-run)
 *
 * Paths file = one path per line (`#` comments ok). Wildcards like `images/*` are allowed.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

function parseArgs(argv) {
  const out = { selfCheck: false, dryRun: false, appUrl: '', pathsFile: '' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--self-check') out.selfCheck = true
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--app-url') {
      out.appUrl = argv[++i] || ''
      if (!out.appUrl) throw new Error('--app-url needs a value')
    } else if (a === '--paths-file') {
      out.pathsFile = argv[++i] || ''
      if (!out.pathsFile) throw new Error('--paths-file needs a path')
    } else if (a.startsWith('--')) {
      throw new Error(`unknown flag: ${a}`)
    } else {
      throw new Error(`unexpected arg: ${a}`)
    }
  }
  return out
}

function parsePaths(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean)
}

function purgeUrl(appUrl, path) {
  const base = appUrl.replace(/\/$/, '')
  const rel = path.replace(/^\//, '')
  return `${base}/${rel}`
}

function selfCheck() {
  assert.equal(purgeUrl('https://example.com/', 'index.html'), 'https://example.com/index.html')
  assert.equal(purgeUrl('https://example.com', 'images/*'), 'https://example.com/images/*')
  assert.deepEqual(parsePaths('# x\nindex.html\nfonts/*\n'), ['index.html', 'fonts/*'])
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  selfCheck()
  if (args.selfCheck) {
    console.log('OK: purge.mjs self-check')
    return
  }

  if (!args.appUrl || !args.pathsFile) {
    throw new Error('usage: node purge.mjs --app-url <url> --paths-file <path> [--dry-run]')
  }

  const apiKey = process.env.BUNNY_CDN_API_KEY?.trim()
  if (!args.dryRun && !apiKey) throw new Error('missing BUNNY_CDN_API_KEY')

  const paths = parsePaths(await readFile(args.pathsFile, 'utf8'))
  if (paths.length === 0) throw new Error(`empty paths file: ${args.pathsFile}`)

  for (const path of paths) {
    const url = purgeUrl(args.appUrl, path)
    if (args.dryRun) {
      console.log(`dry-run purge ${url}`)
      continue
    }
    const res = await fetch(
      `https://api.bunny.net/purge?${new URLSearchParams({ url, async: 'false' })}`,
      {
        method: 'POST',
        headers: { AccessKey: apiKey },
      }
    )
    if (!res.ok) {
      throw new Error(`purge ${url} -> ${res.status} ${await res.text()}`)
    }
    console.log(`purged ${url}`)
  }

  console.log(`OK: ${paths.length} paths purged.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
