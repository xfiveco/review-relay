#!/usr/bin/env node

import { cac } from 'cac';
import packageJson from '../package.json' with { type: 'json' };
import read from './read';
import { formatError } from './shared';
import write from './write';

const cli = cac('review-relay');

function withErrorHandling<T extends unknown[]>(
  action: (...args: T) => Promise<void>,
): (...args: T) => Promise<void> {
  return async (...args: T) => {
    try {
      await action(...args);
    } catch (error) {
      console.error(formatError(error));
      process.exitCode = 1;
    }
  };
}

cli
  .command('read', 'Fetch unresolved merge request discussions into feedback.md')
  .option(
    '--include-current-user',
    'Include discussions where the latest note is by the current GitLab user',
  )
  .option('--output <file>', 'Write feedback to a file path (default: feedback.md)')
  .option('--stdout', 'Print feedback markdown to stdout instead of writing a file')
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
