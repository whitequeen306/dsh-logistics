import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCommands } from './commands.js'
import { parseSkillFile, toPosix } from './util.js'

export const name = 'dsh-logistics'
export const inject = ['commands', 'skills']

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function pluginRootFrom(moduleUrl) {
  return dirname(dirname(fileURLToPath(moduleUrl)))
}

function loadSkills(pluginRoot, logger) {
  const skillsDir = resolve(pluginRoot, 'skills')
  if (!existsSync(skillsDir)) return []
  const skills = []
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = resolve(skillsDir, entry.name, 'SKILL.md')
    if (!existsSync(file)) continue
    let parsed
    try {
      parsed = parseSkillFile(readFileSync(file, 'utf8'), entry.name)
    } catch (error) {
      logger?.warn?.(`dsh-logistics: 无法读取 skill ${entry.name}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const skillName = parsed.name || entry.name
    if (!SKILL_NAME.test(skillName)) {
      logger?.warn?.(`dsh-logistics: skill 名称不合法，已跳过：${skillName}`)
      continue
    }
    if (!parsed.description.trim()) {
      logger?.warn?.(`dsh-logistics: skill ${skillName} 缺少 description，已跳过`)
      continue
    }
    skills.push({
      name: skillName,
      description: parsed.description.trim(),
      content: parsed.content,
      source: 'dsh-logistics',
      metadata: { plugin: 'dsh-logistics', path: toPosix(file) },
    })
  }
  return skills
}

/**
 * DSH/Cordis entry point. Commands and skills are both owned by this plugin;
 * their registrations are disposed with the plugin context.
 */
export function apply(ctx) {
  const pluginRoot = pluginRootFrom(import.meta.url)
  const skills = loadSkills(pluginRoot, ctx.logger)
  for (const skill of skills) ctx.skills.register(skill)
  for (const command of createCommands({ pluginRoot })) ctx.commands.register(command)
  ctx.logger?.info?.(`dsh-logistics: 已注册 ${skills.length} 个 skill、12 个命令`)
}

export { pluginRootFrom }
