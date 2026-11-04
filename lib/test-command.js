function testCommands(scope) {
  if (Array.isArray(scope?.testCommands) && scope.testCommands.length > 0) {
    return scope.testCommands.filter((item) => item && typeof item.command === 'string' && item.command.trim())
  }
  if (scope?.testCommand && typeof scope.testCommand.command === 'string' && scope.testCommand.command.trim()) {
    return [scope.testCommand]
  }
  return []
}

/** One-line representation for replies and prompts. */
export function testCommandText(scope, { empty = '（未检测到）' } = {}) {
  const commands = testCommands(scope)
  if (commands.length === 0) return empty
  return commands.map((item) => `\`${item.command}\``).join('；')
}

/** Markdown list, used in the dispatch, packet, and final replies. */
export function testCommandLines(scope, { label = '测试命令', empty = '（未检测到，执行时会标记“未验证”）' } = {}) {
  const commands = testCommands(scope)
  if (commands.length === 0) return [`- ${label}：${empty}`]
  if (commands.length === 1) return [`- ${label}：\`${commands[0].command}\``]
  return [
    `- ${label}（${commands.length} 个模块）：`,
    ...commands.map((item) => `  - \`${item.command}\`（${item.source}）`),
  ]
}
