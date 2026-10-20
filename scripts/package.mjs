import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const dist = path.join(root, 'dist')
const distHtml = path.join(dist, 'index.html')
const release = path.join(root, 'release')

let html = fs.readFileSync(distHtml, 'utf8')

const scriptTag = html.match(/<script[^>]*src="([^"]+)"[^>]*><\/script>/)
const styleTag = html.match(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/)

if (!scriptTag || !styleTag) {
  throw new Error('Could not find built script or stylesheet in dist/index.html')
}

const scriptFile = path.join(dist, scriptTag[1].replace(/^\.\//, ''))
const styleFile = path.join(dist, styleTag[1].replace(/^\.\//, ''))
let script = fs.readFileSync(scriptFile, 'utf8')
const style = fs.readFileSync(styleFile, 'utf8')

// Prevent an inline script terminator inside the bundle from closing the tag.
script = script.replace(/<\/script/gi, '<\\/script')

html = html
  .replace(scriptTag[0], () => `<script type="module">${script}</script>`)
  .replace(styleTag[0], () => `<style>${style}</style>`)

fs.mkdirSync(release, { recursive: true })
const out = path.join(release, 'Pathcraft.html')
fs.writeFileSync(out, html, 'utf8')
console.log(`wrote ${out} (${(Buffer.byteLength(html) / 1024).toFixed(1)} KiB)`)