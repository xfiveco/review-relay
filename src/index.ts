#!/usr/bin/env node

import { cac } from 'cac';
import packageJson from '../package.json' with { type: 'json' };
import read from './read';
import { formatError } from './shared';
import write from './write';

const cli = cac('review-relay');

function withErrorHandling(action: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      await action();
    } catch (error) {
      console.error(formatError(error));
      process.exitCode = 1;
    }
  };
}

cli
  .command('read', 'Fetch unresolved merge request discussions into feedback.md')
  .action(withErrorHandling(read));

cli
  .command('write', 'Submit responses from feedback.md to merge request discussions')
  .action(withErrorHandling(write));

cli.help();
cli.version(packageJson.version);

const parsed = cli.parse();
const isHelpRequested = Boolean(parsed.options.help);
const isVersionRequested = Boolean(parsed.options.version);

if (!cli.matchedCommand && !isHelpRequested && !isVersionRequested) {
  cli.outputHelp();
}
