/** Tiny argument parser for the bundled zero-dependency CLIs. */
export function parseArgs(argv = process.argv.slice(2)) {
  const values = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (typeof arg !== 'string') continue
    if (!arg.startsWith('--')) {
      values._.push(arg)
      continue
    }
    const equals = arg.indexOf('=')
    if (equals >= 0) {
      values[arg.slice(2, equals)] = arg.slice(equals + 1)
      continue
    }
    const key = arg.slice(2)
    const next = argv[index + 1]
    if (typeof next === 'string' && !next.startsWith('--')) {
      values[key] = next
      index += 1
    } else {
      values[key] = true
    }
  }
  return values
}

export function requireArg(values, name) {
  const value = values[name]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`缺少参数 --${name}`)
  }
  return value
}

export function splitList(value) {
  if (typeof value !== 'string') return []
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}
