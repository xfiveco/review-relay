import { defineConfig } from 'tsdown';

export default defineConfig({
  unbundle: true,
  external: [/node_modules/, '../package.json'],
});
