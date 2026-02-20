import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { toMarkdown } from 'mdast-util-to-markdown';
import type { Content, Heading, Root } from 'mdast';
import { createGitlabClient } from './shared';

const INPUT_FILE_NAME = 'feedback.md';
const TODO_RESPONSE = 'TODO';
const DISCUSSION_PREFIX = 'Discussion ';
const DISCUSSION_DEPTH = 3;
const RESPONSE_DEPTH = 4;

type DiscussionResponse = {
  discussionId: string;
  body: string;
};

function isHeading(node: Content, depth: number): node is Heading {
  return node.type === 'heading' && node.depth === depth;
}

function headingText(node: Heading): string {
  return toMarkdown(node)
    .replace(/^#{1,6}\s*/, '')
    .trim();
}

function parseMergeRequestIid(nodes: Content[]): number {
  const heading = nodes.find((node): node is Heading => isHeading(node, 1));
  if (!heading) {
    throw new Error('Missing level-1 heading with merge request reference');
  }

  const match = headingText(heading).match(/^Feedback for !(\d+):/);
  if (!match) {
    throw new Error('Unable to parse merge request IID from feedback heading');
  }

  return Number(match[1]);
}

function parseDiscussionId(heading: Heading): string | null {
  const text = headingText(heading);
  if (!text.startsWith(DISCUSSION_PREFIX)) {
    return null;
  }

  const discussionId = text.slice(DISCUSSION_PREFIX.length).trim();
  return discussionId || null;
}

function responseFromNodes(nodes: Content[]): string {
  return nodes
    .map((node) => toMarkdown(node).trimEnd())
    .join('\n\n')
    .trim();
}

function extractDiscussionResponses(nodes: Content[]): DiscussionResponse[] {
  const responses: DiscussionResponse[] = [];
  let currentDiscussionId: string | null = null;

  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (!isHeading(node, DISCUSSION_DEPTH) && !isHeading(node, RESPONSE_DEPTH)) {
      continue;
    }

    if (isHeading(node, DISCUSSION_DEPTH)) {
      const discussionId = parseDiscussionId(node);
      if (discussionId) {
        currentDiscussionId = discussionId;
      }

      continue;
    }

    if (
      !isHeading(node, RESPONSE_DEPTH) ||
      headingText(node) !== 'Response' ||
      !currentDiscussionId
    ) {
      continue;
    }

    const responseNodes: Content[] = [];
    for (let offset = index + 1; offset < nodes.length; offset += 1) {
      const next = nodes[offset];
      if (next.type === 'heading' && next.depth <= RESPONSE_DEPTH) {
        break;
      }

      responseNodes.push(next);
    }

    const responseBody = responseFromNodes(responseNodes);
    if (!responseBody || responseBody === TODO_RESPONSE) {
      continue;
    }

    responses.push({
      discussionId: currentDiscussionId,
      body: responseBody,
    });
  }

  return responses;
}

export default async function write(): Promise<void> {
  const inputPath = path.resolve(process.cwd(), INPUT_FILE_NAME);
  const markdown = await readFile(inputPath, 'utf8');
  const ast = fromMarkdown(markdown) as Root;
  const nodes = ast.children || [];

  const mergeRequestIid = parseMergeRequestIid(nodes);
  const responses = extractDiscussionResponses(nodes);

  if (responses.length === 0) {
    console.log(`No discussion responses to submit in ${inputPath}`);
    return;
  }

  const { api, projectPath } = createGitlabClient();

  for (const response of responses) {
    await api.MergeRequestDiscussions.addNote(
      projectPath,
      mergeRequestIid,
      response.discussionId,
      response.body,
    );
    console.log(`Submitted response for discussion ${response.discussionId}`);
  }

  console.log(`Submitted ${responses.length} response(s) to !${mergeRequestIid}`);
}
