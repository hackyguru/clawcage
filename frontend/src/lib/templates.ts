// ============================================================================
// Clawcage Environment Templates
// ============================================================================
//
// Add new templates to the TEMPLATES array below. The UI picks them up
// automatically — no other code changes needed.
//
// Each template can optionally define:
//   - setupScript:      Shell commands to run on first boot (idempotent)
//   - requiredDomains:  Domains auto-added to the venv's network allow list
//   - defaultSettings:  Per-venv settings applied on creation
//   - setupForm:        GUI form fields shown in the create dialog
//
// See the VenvTemplate type in types.ts for all available fields.
//
// Quick-start: copy the example below and fill in your values.
//
// ┌─────────────────────────────────────────────────────────┐
// │  {                                                      │
// │    id: 'my-tool',                                       │
// │    name: 'My Tool',                                     │
// │    description: 'One-line description.',                 │
// │    icon: 'bot',           // 'terminal' | 'bot'         │
// │    defaultEphemeral: false,                              │
// │    requiredDomains: ['example.com', '*.example.com'],    │
// │    defaultSettings: {                                    │
// │      'network.proxy_enabled': false,                     │
// │      'network.allow_all_domains': true,                  │
// │    },                                                    │
// │    setupScript: [                                        │
// │      '#!/bin/bash',                                      │
// │      'if [ -d /root/.my-tool ]; then exit 0; fi',       │
// │      'curl -fsSL https://my-tool.dev/install | bash',    │
// │    ].join('\n'),                                         │
// │  },                                                      │
// └─────────────────────────────────────────────────────────┘
//
// Setup script tips:
//   - The script runs inside the user's terminal on first boot
//   - Always include an idempotency check (e.g. if [ -d ... ]; then exit 0; fi)
//   - Use --no-onboard / --skip-setup / --non-interactive flags if the
//     installer has interactive prompts
//   - The rootfs already has: node, npm, python3, pip, git, curl, vim, uv
//   - npm global bin is at /root/.npm-global/bin (already on PATH)
//   - pip installs go to /root/.venv/ (already activated)
//
// ============================================================================

import type { VenvTemplate } from './types';

export const TEMPLATES: VenvTemplate[] = [
  // ── Blank (default) ─────────────────────────────────────────────
  {
    id: 'blank',
    name: 'Blank',
    description: 'Empty environment with standard dev tools.',
    icon: 'terminal',
    defaultEphemeral: false,
  },

  // ── OpenClaw ────────────────────────────────────────────────────
  {
    id: 'openclaw',
    name: 'OpenClaw',
    description: 'Personal AI assistant with chat integrations.',
    icon: 'bot',
    logo: '/openclaw.png',
    defaultEphemeral: false,
    requiredDomains: [
      'openclaw.ai', '*.openclaw.ai',
      'github.com', '*.github.com', '*.githubusercontent.com',
      'registry.npmjs.org', '*.npmjs.org', '*.npmjs.com',
    ],
    defaultSettings: {
      'network.proxy_enabled': false,
      'network.allow_all_domains': true,
    },
    setupScript: [
      '#!/bin/bash',
      'if [ -d /root/.openclaw ]; then exit 0; fi',
      'curl -fsSL https://openclaw.ai/install.sh | bash -s -- --no-onboard',
    ].join('\n'),
  },

  // ── Hermes ──────────────────────────────────────────────────────
  {
    id: 'hermes',
    name: 'Hermes',
    description: 'AI agent by Nous Research.',
    icon: 'bot',
    logo: '/hermes.png',
    defaultEphemeral: false,
    requiredDomains: [
      'github.com', '*.github.com', '*.githubusercontent.com',
      'registry.npmjs.org', '*.npmjs.org', '*.npmjs.com',
      'pypi.org', '*.pypi.org', 'files.pythonhosted.org',
    ],
    defaultSettings: {
      'network.proxy_enabled': false,
      'network.allow_all_domains': true,
    },
    setupScript: [
      '#!/bin/bash',
      'if [ -d /root/.hermes ]; then exit 0; fi',
      'curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash -s -- --skip-setup',
    ].join('\n'),
  },

  // ── Add your template here ──────────────────────────────────────
];

/** Look up a template by ID. Falls back to 'blank'. */
export function getTemplate(id: string): VenvTemplate {
  return TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0];
}
