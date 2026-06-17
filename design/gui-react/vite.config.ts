import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Design-Prototyp: `base: './'` macht das Build-Artefakt auch via file://
// lauffaehig (relative Asset-Pfade) — praktisch fuer Screenshots/Demos.
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
});
