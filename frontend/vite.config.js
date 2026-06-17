import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(() => ({
  base: process.env.GH_PAGES === 'true' ? '/mos-sport/' : '/',
  plugins: [react()]
}))

