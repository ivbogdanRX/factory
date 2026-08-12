import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5190,
    strictPort: true,
    allowedHosts: ['uneffervescently-uncitable-clement.ngrok-free.dev', 'adsuploader.ngrok.io'],
    // Proxy Graph API through same origin so VPN/browser TLS to Meta
    // doesn't kill large video chunk uploads (Failed to fetch / SSL errors).
    proxy: {
      '/meta-graph': {
        target: 'https://graph.facebook.com',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/meta-graph/, ''),
      },
    },
  },
});
