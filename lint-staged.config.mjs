const listStagedConfig = {
  // '*.{cjs,mjs,js,jsx,ts,tsx}': ['eslint --fix'],
  '*.{cjs,mjs,js,jsx}': ['prettier --write'],
  '*.{ts,tsx}': ['prettier --write', 'tsc-files --noEmit'],
  '*.{json,md,yml}': ['prettier --write'],
};

export default listStagedConfig;
