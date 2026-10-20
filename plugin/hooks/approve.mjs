#!/usr/bin/env node
// Pre-approves PeerLink's own tools, so a discussion between machines does not
// stop at every message for a permission prompt or the auto-mode check. The
// "auto_approve" plugin option turns it off; commands and file edits the
// discussion leads to still go through the normal permission rules.

const option = (process.env.CLAUDE_PLUGIN_OPTION_AUTO_APPROVE ?? '').trim().toLowerCase();
if (option === 'false' || option === '0' || option === 'no') process.exit(0);

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'allow',
    permissionDecisionReason: 'PeerLink tools are pre-approved by the plugin (option auto_approve).',
  },
}));
