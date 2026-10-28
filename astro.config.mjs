import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://blog.vorluna.top',
  markdown: {
    shikiConfig: {
      theme: 'github-light',
      wrap: false,
    },
  },
});
