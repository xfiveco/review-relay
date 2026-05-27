import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import prettier from 'prettier';
import type {
  DiscussionNoteSchema,
  DiscussionSchema,
  ExpandedMergeRequestSchema,
  Gitlab,
  MergeRequestDiscussionNoteSchema,
  MergeRequestSchemaWithBasicLabels,
} from '@gitbeaker/rest';
import {
  createGitlabClient,
  formatError,
  getCurrentBranch,
  parseOptionalPositiveIntEnv,
} from './shared';

const OUTPUT_FILE_NAME = 'feedback.md';
const OPEN_MR_STATE = 'opened';
const READING_INSTRUCTIONS_TEXT =
  'Read the following discussions carefully. For each discussion, analyze the referenced file and project ' +
  'context. If you have doubts, stop and ask for clarification. If you believe feedback is correct, make ' +
  'necessary changes. If you believe feedback is incorrect, prepare a detailed technical explanation.';
const DOCUMENT_RESPONSE_INSTRUCTIONS_TEXT =
  'Write each response under the matching "#### Response" heading. Replace "TODO" with "👍" when feedback ' +
  'was accepted and applied, or with your detailed technical explanation when you disagree. Do not use headings ' +
  'in responses.';
const CLI_RESPONSE_INSTRUCTIONS_TEXT =
  'Use glab CLI to add responses to discussions. For each discussion, reply with ' +
  '`glab mr note create <merge-request-id> --reply <discussion-id> -m "<response>"`. Use "👍" as the ' +
  'response when feedback was accepted and applied. When you disagree, use your detailed technical explanation ' +
  'as the response.';
const NO_DISCUSSIONS_TEXT = 'No discussions need attention.';

type ReadOptions = {
  includeCurrentUser?: boolean;
  output?: string;
  stdout?: boolean;
  cli?: boolean;
};

async function selectMergeRequest({
  api,
  projectPath,
  currentBranch,
  overrideIid,
}: {
  api: Gitlab;
  projectPath: string;
  currentBranch: string;
  overrideIid: number | null;
}): Promise<MergeRequestSchemaWithBasicLabels | ExpandedMergeRequestSchema> {
  if (overrideIid) {
    let mergeRequest: ExpandedMergeRequestSchema;
    try {
      mergeRequest = await api.MergeRequests.show(projectPath, overrideIid);
    } catch (error) {
      throw new Error(
        `Unable to fetch merge request !${overrideIid} in ${projectPath}: ${formatError(error)}`,
      );
    }

    if (mergeRequest.state !== OPEN_MR_STATE) {
      throw new Error(
        `Merge request !${overrideIid} is not opened (state: ${String(mergeRequest.state ?? 'unknown')})`,
      );
    }

    return mergeRequest;
  }

  const openMergeRequests = await api.MergeRequests.all({
    projectId: projectPath,
    state: OPEN_MR_STATE,
    scope: 'all',
    orderBy: 'updated_at',
    sort: 'desc',
    perPage: 100,
    maxPages: 10,
  });

  const matchedByBranch = openMergeRequests.filter(
    (mergeRequest) => mergeRequest.source_branch === currentBranch,
  );

  if (matchedByBranch.length === 0) {
    throw new Error(`No opened merge request found for current branch "${currentBranch}"`);
  }

  if (matchedByBranch.length > 1) {
    const conflicts = matchedByBranch
      .map((mergeRequest) => `!${mergeRequest.iid} (${mergeRequest.title})`)
      .join(', ');

    throw new Error(
      `Multiple opened merge requests found for branch "${currentBranch}": ${conflicts}. ` +
        'Set REVIEW_RELAY_GITLAB_MERGE_REQUEST_IID to pick one.',
    );
  }

  return matchedByBranch[0];
}

function isDiscussionResolved(discussion: DiscussionSchema): boolean {
  const notes = Array.isArray(discussion.notes) ? discussion.notes.filter(isSupportedNoteType) : [];
  const resolvableNotes = notes.filter((note) => note.resolvable === true);
  if (resolvableNotes.length === 0) {
    return false;
  }

  return resolvableNotes.every((note) => Boolean(note.resolved_at?.trim()));
}

function isSupportedNoteType(note: DiscussionNoteSchema): note is MergeRequestDiscussionNoteSchema {
  return !note.system && (note.type === 'DiscussionNote' || note.type === 'DiffNote');
}

function toLineNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }

  return null;
}

type MergeRequestPosition = NonNullable<MergeRequestDiscussionNoteSchema['position']>;
type MergeRequestTextPosition = Extract<MergeRequestPosition, { position_type: 'text' }>;
type MergeRequestLineRangeSide = {
  type?: 'new' | 'old' | null;
  new_line?: number | null;
  old_line?: number | null;
};
type PositionSide = 'base/original' | 'head/changed';
type PositionEndpoint = {
  side: PositionSide;
  path: string;
  line: number | null;
};
type NormalizedPosition = {
  start: PositionEndpoint;
  end?: PositionEndpoint;
};

function isTextPosition(position: MergeRequestPosition): position is MergeRequestTextPosition {
  return position.position_type === 'text';
}

function rangeSideType(side: MergeRequestLineRangeSide): PositionSide {
  return side.type === 'old' || (!side.new_line && side.old_line)
    ? 'base/original'
    : 'head/changed';
}

function pathForSide(position: MergeRequestTextPosition, side: PositionSide): string | null {
  return side === 'base/original'
    ? position.old_path?.trim() || position.new_path?.trim() || null
    : position.new_path?.trim() || position.old_path?.trim() || null;
}

function endpointFromRangeSide(
  position: MergeRequestTextPosition,
  side: MergeRequestLineRangeSide,
): PositionEndpoint | null {
  const sideType = rangeSideType(side);
  const line =
    sideType === 'base/original'
      ? toLineNumber(side.old_line)
      : (toLineNumber(side.new_line) ?? toLineNumber(side.old_line));
  const pathValue = pathForSide(position, sideType);

  if (!pathValue) {
    return null;
  }

  return {
    side: sideType,
    path: pathValue,
    line,
  };
}

function normalizePosition(note: MergeRequestDiscussionNoteSchema): NormalizedPosition | null {
  const position = note.position;
  if (!position) {
    return null;
  }

  const positionType = (position as { position_type?: string }).position_type;
  if (positionType === 'file') {
    const filePosition = position as unknown as {
      new_path?: string | null;
      old_path?: string | null;
    };
    const oldPath = filePosition.old_path?.trim();
    const newPath = filePosition.new_path?.trim();

    if (oldPath && newPath && oldPath !== newPath) {
      return {
        start: { side: 'base/original', path: oldPath, line: null },
        end: { side: 'head/changed', path: newPath, line: null },
      };
    }

    if (newPath) {
      return { start: { side: 'head/changed', path: newPath, line: null } };
    }

    return oldPath ? { start: { side: 'base/original', path: oldPath, line: null } } : null;
  }

  if (!isTextPosition(position)) {
    return null;
  }

  const lineRange = position.line_range;
  if (lineRange?.start && lineRange.end) {
    const start = endpointFromRangeSide(position, lineRange.start);
    const end = endpointFromRangeSide(position, lineRange.end);

    return start ? { start, ...(end ? { end } : {}) } : null;
  }

  const oldPath = position.old_path?.trim();
  const newPath = position.new_path?.trim();
  const oldLine = toLineNumber(position.old_line);
  const newLine = toLineNumber(position.new_line);

  if (oldLine && newLine && oldPath && newPath) {
    return {
      start: { side: 'base/original', path: oldPath, line: oldLine },
      end: { side: 'head/changed', path: newPath, line: newLine },
    };
  }

  if (oldLine && oldPath) {
    return { start: { side: 'base/original', path: oldPath, line: oldLine } };
  }

  if (newLine && newPath) {
    return { start: { side: 'head/changed', path: newPath, line: newLine } };
  }

  return null;
}

function formatEndpoint(endpoint: PositionEndpoint): string {
  return endpoint.line
    ? `${endpoint.side} ${endpoint.path}:${endpoint.line}`
    : `${endpoint.side} ${endpoint.path}`;
}

function formatFileLocation(note: MergeRequestDiscussionNoteSchema): string | null {
  const normalized = normalizePosition(note);
  if (!normalized) {
    return null;
  }

  const { start, end } = normalized;
  if (!end) {
    return formatEndpoint(start);
  }

  if (start.side === end.side && start.path === end.path && start.line && end.line) {
    const lineSuffix = start.line === end.line ? String(start.line) : `${start.line}-${end.line}`;
    return `${start.side} ${start.path}:${lineSuffix}`;
  }

  if (start.path === end.path && start.line && end.line) {
    return `${start.path} ${start.side} line ${start.line} to ${end.side} line ${end.line}`;
  }

  return `${formatEndpoint(start)} to ${formatEndpoint(end)}`;
}

function buildMarkdown({
  mergeRequest,
  currentUserId,
  discussions,
  useCli,
}: {
  mergeRequest: MergeRequestSchemaWithBasicLabels | ExpandedMergeRequestSchema;
  currentUserId: number;
  discussions: Array<{ id: string; notes: MergeRequestDiscussionNoteSchema[] }>;
  useCli: boolean;
}): string {
  const lines: string[] = [];

  lines.push(`# Feedback for !${mergeRequest.iid}: ${mergeRequest.title}`);
  lines.push('');
  lines.push('## Instructions');
  lines.push('');
  lines.push('### Reading and processing');
  lines.push('');
  lines.push(READING_INSTRUCTIONS_TEXT);
  lines.push('');
  lines.push('### Writing responses');
  lines.push('');
  lines.push(useCli ? CLI_RESPONSE_INSTRUCTIONS_TEXT : DOCUMENT_RESPONSE_INSTRUCTIONS_TEXT);
  lines.push('');
  lines.push('## Discussions');
  lines.push('');

  if (discussions.length === 0) {
    lines.push(NO_DISCUSSIONS_TEXT);
    lines.push('');
  }

  discussions.forEach((discussion) => {
    lines.push(`### Discussion ${discussion.id}`);
    lines.push('');

    const discussionFileLocation = formatFileLocation(discussion.notes[0]);
    if (discussionFileLocation) {
      lines.push(`**File:** ${discussionFileLocation}`);
      lines.push('');
    }

    discussion.notes.forEach((note) => {
      lines.push(`#### Note by ${note.author.id === currentUserId ? 'You' : note.author.name}`);

      lines.push('<blockquote>');
      lines.push(note.body);
      lines.push('</blockquote>');
      lines.push('');
    });

    if (!useCli) {
      lines.push('#### Response');
      lines.push('TODO');
      lines.push('');
    }
  });

  return `${lines.join('\n').trimEnd()}\n`;
}

function isLastResponseByCurrentUser(
  notes: MergeRequestDiscussionNoteSchema[],
  currentUserId: number,
): boolean {
  return notes.at(-1)?.author.id === currentUserId;
}

export default async function read(options: ReadOptions = {}): Promise<void> {
  const outputTarget = options.output?.trim() || OUTPUT_FILE_NAME;
  const shouldWriteToStdout = Boolean(options.stdout);
  if (shouldWriteToStdout && options.output?.trim()) {
    throw new Error('Use either --stdout or --output <file>, not both');
  }

  const outputPath = path.resolve(process.cwd(), outputTarget);
  const includeCurrentUserDiscussions = Boolean(options.includeCurrentUser);
  const useCli = Boolean(options.cli);
  const overrideIid = parseOptionalPositiveIntEnv('REVIEW_RELAY_GITLAB_MERGE_REQUEST_IID');
  const { api, projectPath } = createGitlabClient();
  const currentUser = await api.Users.showCurrentUser();
  const currentBranch = getCurrentBranch();
  const mergeRequest = await selectMergeRequest({
    api,
    projectPath,
    currentBranch,
    overrideIid,
  });

  const mergeRequestIidValue = mergeRequest.iid;
  const rawDiscussions = await api.MergeRequestDiscussions.all(projectPath, mergeRequestIidValue, {
    perPage: 100,
    maxPages: 10,
  });

  const discussions = rawDiscussions
    .filter((discussion) => !isDiscussionResolved(discussion))
    .map(({ id, notes = [] }) => ({
      id,
      notes: notes.filter(isSupportedNoteType),
    }))
    .filter(
      (discussion) =>
        discussion.notes.length > 0 &&
        (includeCurrentUserDiscussions ||
          !isLastResponseByCurrentUser(discussion.notes, currentUser.id)),
    );

  const markdown = buildMarkdown({
    mergeRequest,
    currentUserId: currentUser.id,
    discussions,
    useCli,
  });

  const prettierConfig = await prettier.resolveConfig(outputPath);
  const formattedMarkdown = await prettier.format(markdown, {
    ...(prettierConfig || {}),
    parser: 'markdown',
  });

  if (shouldWriteToStdout) {
    process.stdout.write(formattedMarkdown);
    return;
  }

  await writeFile(outputPath, formattedMarkdown, 'utf8');

  console.log(
    `Saved ${discussions.length} discussion(s) from !${mergeRequestIidValue} ` +
      `(${mergeRequest.title}) to ${outputPath}`,
  );
}
