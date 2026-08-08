import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// https://vite.dev/config/

export default defineConfig({
  base: '/frog_label/',
  plugins: [
    react(),
    tailwindcss(),
  ],
  assetsInclude: ['**/*.mp3'],
  resolve: {
    alias: {
      react: path.resolve('./node_modules/react'),
      'react-dom': path.resolve('./node_modules/react-dom'),
    },
  },
})

