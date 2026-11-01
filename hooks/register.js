/**
 * intent-lens — a Claude Mod that shows the intent of a tool call.
 *
 * Claude Code calls `register` once when the plugin loads and passes `on`.
 * Every hook receives ($, e, next): the mods API, the frozen event, and the
 * continuation.
 */

let lastIntent = null

export function register(on) {
  // Fires for every tool, including subagent and MCP calls.
  on('tool.call', async ($, e, next) => {
    lastIntent = { tool: String(e.tool || 'Tool'), detail: 'about to run' }

    // Ask for a redraw so the band shows this intent before the tool runs.
    try {
      $.ui.invalidate('ui.render')
    } catch {
      // No UI (claude -p, headless): nothing to draw.
    }

    return next(e)
  })

  // The band directly above the prompt. Drawn only while Claude is working.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const working = !e.props || e.props.isWorking !== false
    if (!lastIntent || !working) return next(e)

    const { Box, Text } = $.ui.resolve(e)

    // Keep Claude Code's own band content below ours.
    const theirs = await next(e)

    return Box({
      flexDirection: 'column',
      children: [
        Text({ color: 'cyan', children: ['▸ ' + lastIntent.tool] }),
        theirs,
      ],
    })
  })
}
