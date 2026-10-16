/** 临时体检：成果物页渲染出的 body 片段。 */
import { renderArtifactsHtml, artifactsRunsHtml } from '../plugins/dsh-comfymcp-client/lib/wfpage.js'

const runs = [{ id: 'r1', name: 'x', state: 'completed', localFiles: [{ path: 'C:/a.png', filename: 'a.png', kind: 'image' }] }]
const rendered = artifactsRunsHtml({ runs, tags: {}, token: 'tk' })
console.log('artifactsRunsHtml →', JSON.stringify({ shown: rendered.shown, html: rendered.html.slice(0, 120) }))
const html = renderArtifactsHtml({ runs, tags: {}, token: 'tk' })
const start = html.indexOf('class="wrap"')
console.log('body 片段:', JSON.stringify(html.slice(start, start + 400)))
