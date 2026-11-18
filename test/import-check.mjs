import * as entry from '../index.js'
import * as tools from '../lib/tools.js'
import * as api from '../lib/api.js'
import * as engine from '../lib/engine.js'
import * as hub from '../lib/hub.js'

const checks = [
  ['index.apply', typeof entry.apply === 'function'],
  ['index.inject', Array.isArray(entry.inject) && entry.inject.join(',') === 'tools,webServer,systemPrompt'],
  ['tools.registerTools', typeof tools.registerTools === 'function'],
  ['api.registerApi', typeof api.registerApi === 'function'],
  ['engine.createEngine', typeof engine.createEngine === 'function'],
  ['engine.tokenize', typeof engine.tokenize === 'function'],
  ['hub.createHub', typeof hub.createHub === 'function'],
]
let bad = 0
for (const [name, ok] of checks) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name)
  if (!ok) bad += 1
}
process.exit(bad === 0 ? 0 : 1)
