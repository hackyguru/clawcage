// Venv creation templates.
// Add new templates here — the UI picks them up automatically.
import type { VenvTemplate } from './types';

export const TEMPLATES: VenvTemplate[] = [
  {
    id: 'blank',
    name: 'Blank',
    description: 'Empty environment with standard dev tools.',
    icon: 'terminal',
    defaultEphemeral: false,
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    description: 'Personal AI assistant with chat integrations.',
    icon: 'bot',
    defaultEphemeral: false,
    requiredDomains: [
      'openclaw.ai', '*.openclaw.ai',
      'github.com', '*.github.com',
      '*.githubusercontent.com',
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
  {
    id: 'hermes',
    name: 'Hermes',
    description: 'AI agent by Nous Research.',
    icon: 'bot',
    defaultEphemeral: false,
    requiredDomains: [
      'github.com', '*.github.com',
      '*.githubusercontent.com',
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
];

/** Look up a template by ID. Falls back to 'blank'. */
export function getTemplate(id: string): VenvTemplate {
  return TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0];
}
