import { defineConfig } from 'vite'
import tailwindcss from "@tailwindcss/vite"
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'
import topLevelAwait from 'vite-plugin-top-level-await';
// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react() , tailwindcss(), tsconfigPaths() , topLevelAwait()],
  server : {
    port : 5173,
    // Loopback IPv4: reachable as both localhost and 127.0.0.1 (a bare `localhost` bind is IPv6-only on this stack), but not from the LAN.
    host : "127.0.0.1",
    proxy: {
      // goforge-api (live database connections) - runs separately via
      // `bun run dev` in server/, defaults to :4000.
      '/api': 'http://127.0.0.1:4000'
    }
  } ,
  optimizeDeps: {
    // Don't optimize these packages as they contain web workers and WASM files.
    // https://github.com/vitejs/vite/issues/11672#issuecomment-1415820673
    exclude: ['@journeyapps/wa-sqlite', '@powersync/web' , '@guanmingchiu/sqlparser-ts'],
    include: ['@powersync/web > js-logger']
  },
  worker: {
    format: 'es',
    plugins: () => [ topLevelAwait()]
  } , 

  build: {
    target: "esnext"
  }
})
