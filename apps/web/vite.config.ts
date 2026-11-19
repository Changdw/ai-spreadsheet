import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { loadSheetLayout, univerDocSkeleton } from '../../scripts/univer-sheet-build';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [
    {
      name: 'aib-sheet-layout',
      enforce: 'pre',
      apply: 'build',
      load: {
        filter: { id: univerDocSkeleton },
        handler(id) {
          return loadSheetLayout(id);
        },
      },
      generateBundle() {
        if (!Array.from(this.getModuleIds()).some((id) => univerDocSkeleton.test(id))) {
          this.error('Unrecognized Univer web layout entry');
        }
      },
    },
  ],
  build: { outDir: '../../dist/web', emptyOutDir: true, chunkSizeWarningLimit: 7000 },
  server: { host: '127.0.0.1' },
});
