import { defineConfig } from 'vite';

export default defineConfig({
  // Caminhos relativos permitem abrir o build via file:// dentro do Electron.
  base: './',
  server: { port: 5173, open: true },
  build: { target: 'es2022', outDir: 'dist', sourcemap: false },
});
