// Zips dist/ into dixvoice-frontend.zip for upload to itch.io.
import { createWriteStream, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { ZipArchive } from 'archiver'

const root = resolve(import.meta.dirname, '..')
const dist = resolve(root, 'dist')
const out = resolve(root, 'dixvoice-frontend.zip')

if (!existsSync(resolve(dist, 'index.html'))) {
  console.error('dist/index.html not found: run `npm run build` first')
  process.exit(1)
}

const output = createWriteStream(out)
const archive = new ZipArchive({ zlib: { level: 9 } })
output.on('close', () => console.log(`Wrote ${out} (${archive.pointer()} bytes)`))
archive.on('error', (err) => {
  throw err
})
archive.pipe(output)
archive.directory(dist, false)
await archive.finalize()
