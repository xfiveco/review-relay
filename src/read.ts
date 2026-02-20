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
const INSTRUCTIONS_TEXT =
  'Read the following discussions carefully. For each discussion that has a "TODO" response, analyze the file ' +
  'and project context. If you have doubts, stop and ask for clarification. If you believe feedback is correct, ' +
  'make necessary changes and update the response to "👍". If you believe feedback is incorrect, update the ' +
  'response with your analysis and a detailed technical explanation. Do not use headings in responses.';

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
  new_line?: number | null;
  old_line?: number | null;
};

function readLineFromRangeSide(lineSide?: MergeRequestLineRangeSide | null): number | null {
  if (!lineSide) {
    return null;
  }

  return toLineNumber(lineSide.new_line) ?? toLineNumber(lineSide.old_line);
}

function readLineRange(position: MergeRequestTextPosition): {
  start: number | null;
  end: number | null;
} {
  const lineRange = position.line_range;
  if (!lineRange) {
    const line = toLineNumber(position.new_line) ?? toLineNumber(position.old_line);
    return { start: line, end: line };
  }

  const start =
    readLineFromRangeSide(lineRange.start) ??
    toLineNumber(position.new_line) ??
    toLineNumber(position.old_line);
  const end =
    readLineFromRangeSide(lineRange.end) ??
    toLineNumber(position.new_line) ??
    toLineNumber(position.old_line);

  return { start, end };
}

function firstPath(position: MergeRequestPosition): string | null {
  return position.new_path?.trim() || position.old_path?.trim() || null;
}

function isTextPosition(position: MergeRequestPosition): position is MergeRequestTextPosition {
  return position.position_type === 'text';
}

function formatFileLocation(note: MergeRequestDiscussionNoteSchema): string | null {
  const position = note.position;
  if (!position) {
    return null;
  }

  const pathValue = firstPath(position);
  if (!pathValue) {
    return null;
  }

  // @ts-expect-error - TODO: fix this
  if (position.position_type === 'file') {
    return pathValue;
  }

  if (isTextPosition(position)) {
    const { start, end } = readLineRange(position);

    if (start && end) {
      if (start === end) {
        return `${pathValue}#${start}`;
      }

      return `${pathValue}#${start}-${end}`;
    }

    if (start) {
      return `${pathValue}#${start}`;
    }
  }

  return pathValue;
}

function buildMarkdown({
  mergeRequest,
  currentUserId,
  discussions,
}: {
  mergeRequest: MergeRequestSchemaWithBasicLabels | ExpandedMergeRequestSchema;
  currentUserId: number;
  discussions: Array<{ id: string; notes: MergeRequestDiscussionNoteSchema[] }>;
}): string {
  const lines: string[] = [];

  lines.push(`# Feedback for !${mergeRequest.iid}: ${mergeRequest.title}`);
  lines.push('');
  lines.push('## Instructions');
  lines.push('');
  lines.push(INSTRUCTIONS_TEXT);
  lines.push('');
  lines.push('## Discussions');
  lines.push('');

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

    lines.push('#### Response');
    lines.push('TODO');
    lines.push('');
  });

  return `${lines.join('\n').trimEnd()}\n`;
}

function isLastResponseByCurrentUser(
  notes: MergeRequestDiscussionNoteSchema[],
  currentUserId: number,
): boolean {
  return notes.at(-1)?.author.id === currentUserId;
}

export default async function read(): Promise<void> {
  const outputPath = path.resolve(process.cwd(), OUTPUT_FILE_NAME);
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
        !isLastResponseByCurrentUser(discussion.notes, currentUser.id),
    );

  const markdown = buildMarkdown({
    mergeRequest,
    currentUserId: currentUser.id,
    discussions,
  });

  const prettierConfig = await prettier.resolveConfig(outputPath);
  const formattedMarkdown = await prettier.format(markdown, {
    ...(prettierConfig || {}),
    parser: 'markdown',
  });

  await writeFile(outputPath, formattedMarkdown, 'utf8');

  console.log(
    `Saved ${discussions.length} discussion(s) from !${mergeRequestIidValue} ` +
      `(${mergeRequest.title}) to ${outputPath}`,
  );
}
