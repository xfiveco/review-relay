import { execSync } from 'node:child_process';
import { Gitlab } from '@gitbeaker/rest';

export function formatError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return String(error);
}

function runGitCommand(command: string): string {
  try {
    return execSync(command, { encoding: 'utf8' }).trim();
  } catch (error) {
    throw new Error(`Failed to run "${command}": ${formatError(error)}`);
  }
}

function getOriginUrl(): string {
  const remote = runGitCommand('git config --get remote.origin.url');
  if (!remote) {
    throw new Error('Missing git remote.origin.url');
  }

  return remote;
}

function parseProjectFromRemote(remoteUrl: string): { host: string; projectPath: string } {
  const sshMatch = remoteUrl.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return {
      host: sshMatch[1],
      projectPath: sshMatch[2],
    };
  }

  const sshProtocolMatch = remoteUrl.match(/^ssh:\/\/git@([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshProtocolMatch) {
    return {
      host: sshProtocolMatch[1],
      projectPath: sshProtocolMatch[2],
    };
  }

  const httpsMatch = remoteUrl.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    return {
      host: httpsMatch[1],
      projectPath: httpsMatch[2],
    };
  }

  throw new Error(`Unsupported git remote URL format: ${remoteUrl}`);
}

function normalizeProjectPath(projectPath: string): string {
  return projectPath
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
}

export function getCurrentBranch(): string {
  const branch = runGitCommand('git branch --show-current');
  if (!branch) {
    throw new Error('Unable to determine current git branch');
  }

  return branch;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing ${name} environment variable`);
  }

  return value.trim();
}

export function parseOptionalPositiveIntEnv(name: string): number | null {
  const value = process.env[name]?.trim();
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

export function createGitlabClient(): { api: Gitlab; projectPath: string } {
  const token = requireEnv('REVIEW_RELAY_GITLAB_PRIVATE_TOKEN');
  const inferred = parseProjectFromRemote(getOriginUrl());

  const rawHost = (process.env.REVIEW_RELAY_GITLAB_HOST || inferred.host)
    .trim()
    .replace(/\/+$/, '');
  const host =
    rawHost.startsWith('http://') || rawHost.startsWith('https://')
      ? rawHost
      : `https://${rawHost}`;
  const projectPath = normalizeProjectPath(
    process.env.REVIEW_RELAY_GITLAB_PROJECT_PATH || inferred.projectPath,
  );

  return {
    api: new Gitlab({ host, token }),
    projectPath,
  };
}
