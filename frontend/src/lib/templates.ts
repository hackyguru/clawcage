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
  // Future templates:
  // {
  //   id: 'claw-bot',
  //   name: 'Claw Bot',
  //   description: 'OpenClaw.ai agent pre-configured and ready to go.',
  //   icon: 'bot',
  //   defaultEphemeral: true,
  // },
];

/** Look up a template by ID. Falls back to 'blank'. */
export function getTemplate(id: string): VenvTemplate {
  return TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0];
}
