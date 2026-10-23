import fs from 'node:fs'
import path from 'node:path'

/**
 * Inline the built JS + CSS into a single `release/Pathcraft.html`.
 *
 * Two builds are supported:
 *   node scripts/package.mjs              → dist/        (ESM, `<script type="module">`)
 *   node scripts/package.mjs --classic    → dist-bundle/ (IIFE, classic `<script>`)
 *
 * The classic form is what gets published: a `file://` document is an opaque
 * origin, and some embedded webviews refuse to run module scripts there, which
 * shows up as a blank page after a double-click. A classic script has no such
 * gate.
 */
const args = process.argv.slice(2)
const classic = args.includes('--classic')
const dirArg = args.find((a) => a.startsWith('--dir='))
const sourceDir = dirArg ? dirArg.slice('--dir='.length) : classic ? 'dist-bundle' : 'dist'

const root = process.cwd()
const dist = path.resolve(root, sourceDir)
const distHtml = path.join(dist, 'index.html')
const release = path.join(root, 'release')

if (!fs.existsSync(distHtml)) {
  throw new Error(`missing ${distHtml} — run the build for ${sourceDir} first`)
}

let html = fs.readFileSync(distHtml, 'utf8')

const scriptTag = html.match(/<script[^>]*src="([^"]+)"[^>]*><\/script>/)
const styleTag = html.match(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/)

if (!scriptTag || !styleTag) {
  throw new Error(`could not find built script or stylesheet in ${distHtml}`)
}

const resolve = (href) => path.join(dist, href.replace(/^\.\//, ''))
const script = fs.readFileSync(resolve(scriptTag[1]), 'utf8')
const style = fs.readFileSync(resolve(styleTag[1]), 'utf8')

// An inline terminator inside the bundle would close the tag early.
const safeScript = script.replace(/<\/script/gi, '<\\/script')

// The IIFE build has no ESM syntax left, so it must NOT be labelled as a module:
// a module script would be blocked on file:// by the opaque-origin rule.
const inlineScript = classic
  ? `<script>${safeScript}</script>`
  : `<script type="module">${safeScript}</script>`

let outHtml = html
  .replace(styleTag[0], () => `<style>${style}</style>`)
  // Preload/prefetch hints point at files that no longer exist once inlined.
  .replace(/<link[^>]*rel="(?:modulepreload|preload)"[^>]*>/g, '')

if (classic) {
  // A module script is deferred by definition; a classic one is not. Keeping it
  // in <head> would run it before #root exists (React "target container is not
  // a DOM element"), so the classic build is moved to the end of <body>.
  outHtml = outHtml
    .replace(scriptTag[0], '')
    .replace('</body>', () => `${inlineScript}\n  </body>`)
} else {
  outHtml = outHtml.replace(scriptTag[0], () => inlineScript)
}

fs.mkdirSync(release, { recursive: true })
const out = path.join(release, 'Pathcraft.html')
fs.writeFileSync(out, outHtml, 'utf8')

const kb = (Buffer.byteLength(outHtml) / 1024).toFixed(1)
console.log(`wrote ${path.relative(root, out)} (${kb} KiB, ${classic ? 'classic script' : 'module'})`)
