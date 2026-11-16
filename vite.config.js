import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  plugins: [viteSingleFile()],
  server: {
    // no file watching: this box runs out of inotify instances (EMFILE).
    // HMR is off; hard-refresh the browser after edits.
    watch: null,
  },
  build: {
    chunkSizeWarningLimit: 900,
  },
});
