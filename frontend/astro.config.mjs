import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  output: 'static',
  server: { port: 5173 },
  integrations: [react()],
  vite: {
    envPrefix: ['VITE_', 'TAURI_'],
    plugins: [tailwindcss()],
  },
});
