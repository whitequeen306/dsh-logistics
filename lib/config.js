import { resolve } from 'node:path'
import { DEFAULT_CONFIG, DEFAULT_IGNORES } from './constants.js'
import { readJsonFile } from './util.js'

export const CONFIG_FILE = '.logistics/config.json'

const KNOWN_KEYS = new Set([
  'ignore',
  'maxFiles',
  'maxFindingsPerPass',
  'includeLastCommitWhenClean',
  'gate',
])

function cloneDefaults() {
  return {
    ...DEFAULT_CONFIG,
    ignore: [...DEFAULT_IGNORES, ...DEFAULT_CONFIG.ignore],
    gate: { ...DEFAULT_CONFIG.gate },
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function toPositiveInt(value, fallback, min, max, key, warnings) {
  if (value === undefined) return fallback
  if (Number.isFinite(value)) {
    const rounded = Math.trunc(value)
    if (rounded >= min && rounded <= max) return rounded
  }
  warnings.push(`配置项 ${key} 必须是 ${min}-${max} 的整数，已使用默认值 ${fallback}`)
  return fallback
}

/**
 * Load `.logistics/config.json` from the workspace root and merge it over the
 * plugin defaults. Invalid values fall back with a warning instead of failing
 * the command: a typo in a config file must not block an analysis run.
 */
export function loadConfig(root) {
  const configPath = resolve(root, CONFIG_FILE)
  const warnings = []
  const raw = readJsonFile(configPath, undefined)
  const config = cloneDefaults()

  if (raw === undefined) {
    return { config, warnings, found: false, configPath }
  }
  if (!isPlainObject(raw)) {
    warnings.push(`${CONFIG_FILE} 必须是 JSON 对象，已使用默认配置`)
    return { config, warnings, found: false, configPath }
  }

  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) warnings.push(`未知配置项 "${key}" 已忽略`)
  }

  if (raw.ignore !== undefined) {
    if (Array.isArray(raw.ignore) && raw.ignore.every((item) => typeof item === 'string')) {
      config.ignore = [...DEFAULT_IGNORES, ...raw.ignore.map((item) => item.trim()).filter(Boolean)]
    } else {
      warnings.push('配置项 ignore 必须是字符串数组，已使用默认值')
    }
  }

  config.maxFiles = toPositiveInt(raw.maxFiles, config.maxFiles, 1, 5000, 'maxFiles', warnings)
  config.maxFindingsPerPass = toPositiveInt(raw.maxFindingsPerPass, config.maxFindingsPerPass, 1, 100, 'maxFindingsPerPass', warnings)

  if (raw.includeLastCommitWhenClean !== undefined) {
    if (typeof raw.includeLastCommitWhenClean === 'boolean') {
      config.includeLastCommitWhenClean = raw.includeLastCommitWhenClean
    } else {
      warnings.push('配置项 includeLastCommitWhenClean 必须是布尔值，已使用默认值')
    }
  }

  if (raw.gate !== undefined) {
    if (!isPlainObject(raw.gate)) {
      warnings.push('配置项 gate 必须是对象，已使用默认值')
    } else {
      if (raw.gate.failOnNewHigh !== undefined) {
        if (typeof raw.gate.failOnNewHigh === 'boolean') {
          config.gate.failOnNewHigh = raw.gate.failOnNewHigh
        } else {
          warnings.push('配置项 gate.failOnNewHigh 必须是布尔值，已使用默认值')
        }
      }
      if (raw.gate.maxScoreDrop !== undefined) {
        if (Number.isFinite(raw.gate.maxScoreDrop) && raw.gate.maxScoreDrop >= 0 && raw.gate.maxScoreDrop <= 100) {
          config.gate.maxScoreDrop = raw.gate.maxScoreDrop
        } else {
          warnings.push('配置项 gate.maxScoreDrop 必须是 0-100 的数字，已使用默认值')
        }
      }
    }
  }

  return { config, warnings, found: true, configPath }
}
