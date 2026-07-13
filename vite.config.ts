import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Personal tool on an evergreen browser: emit modern syntax as-is instead of
  // down-transpiling to the conservative default.
  build: { target: 'esnext' },
  server: {
    // Honor the port assigned by the preview harness (PORT env), else default.
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
  },
})
