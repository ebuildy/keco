import { allValues } from '@keco/core';
import { describe, expect, it, vi } from 'vitest';
import { classifyWithLlm, type LlmClient, type LlmInput } from './llm';

const INPUT: LlmInput = {
  repo: 'someone/mystery-tool',
  readme: '# mystery-tool\n\nRuns things in your cluster.',
  topics: ['kubernetes'],
  tree: ['main.go', 'go.mod'],
  signals: { scorecard: null, osv: null, dependents: null },
};

function toolUseResponse(input: unknown) {
  return { content: [{ type: 'tool_use', input }] };
}

describe('classifyWithLlm', () => {
  it('returns the validated verdict from a well-formed tool call', async () => {
    const client: LlmClient = {
      messages: {
        create: vi.fn().mockResolvedValue(
          toolUseResponse({
            summary: 'Runs a controller that reconciles a custom resource.',
            kind: 'controller',
            domains: ['dev-experience'],
            confidence: 0.8,
            needs_review: false,
          }),
        ),
      },
    };

    const verdict = await classifyWithLlm(INPUT, {
      apiKey: 'test',
      model: 'claude-haiku-4-5-20251001',
      client,
    });

    expect(verdict).toEqual({
      summary: 'Runs a controller that reconciles a custom resource.',
      kind: 'controller',
      domains: ['dev-experience'],
      confidence: 0.8,
      needs_review: false,
    });
    expect(client.messages.create).toHaveBeenCalledTimes(1);
  });

  it('retries once on an invalid tool call, then succeeds', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        toolUseResponse({
          summary: 'x',
          kind: 'not-a-real-kind',
          domains: [],
          confidence: 2,
          needs_review: false,
        }),
      )
      .mockResolvedValueOnce(
        toolUseResponse({
          summary: 'x',
          kind: 'cli',
          domains: ['dev-experience'],
          confidence: 0.5,
          needs_review: true,
        }),
      );
    const client: LlmClient = { messages: { create } };

    const verdict = await classifyWithLlm(INPUT, {
      apiKey: 'test',
      model: 'claude-haiku-4-5-20251001',
      client,
    });

    expect(verdict?.kind).toBe('cli');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('gives up after two invalid attempts and returns null', async () => {
    const create = vi.fn().mockResolvedValue(toolUseResponse({ summary: 'x' }));
    const client: LlmClient = { messages: { create } };

    const verdict = await classifyWithLlm(INPUT, {
      apiKey: 'test',
      model: 'claude-haiku-4-5-20251001',
      client,
    });

    expect(verdict).toBeNull();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('treats a response with no tool call as invalid and retries', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({ content: [{ type: 'text' }] })
      .mockResolvedValueOnce(
        toolUseResponse({
          summary: 'x',
          kind: 'cli',
          domains: ['dev-experience'],
          confidence: 0.4,
          needs_review: true,
        }),
      );
    const client: LlmClient = { messages: { create } };

    const verdict = await classifyWithLlm(INPUT, {
      apiKey: 'test',
      model: 'claude-haiku-4-5-20251001',
      client,
    });

    expect(verdict?.kind).toBe('cli');
  });

  it('degrades to null instead of rejecting when the API call throws', async () => {
    const create = vi.fn().mockRejectedValue(new Error('rate limited'));
    const client: LlmClient = { messages: { create } };

    await expect(
      classifyWithLlm(INPUT, { apiKey: 'test', model: 'claude-haiku-4-5-20251001', client }),
    ).resolves.toBeNull();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('recovers via retry when the first API call throws and the second succeeds', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(
        toolUseResponse({
          summary: 'x',
          kind: 'cli',
          domains: ['dev-experience'],
          confidence: 0.6,
          needs_review: false,
        }),
      );
    const client: LlmClient = { messages: { create } };

    const verdict = await classifyWithLlm(INPUT, {
      apiKey: 'test',
      model: 'claude-haiku-4-5-20251001',
      client,
    });

    expect(verdict?.kind).toBe('cli');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('sends a request shaped for forced, taxonomy-constrained tool use', async () => {
    const create = vi.fn().mockResolvedValue(
      toolUseResponse({
        summary: 'x',
        kind: 'cli',
        domains: ['dev-experience'],
        confidence: 0.6,
        needs_review: false,
      }),
    );
    const client: LlmClient = { messages: { create } };

    await classifyWithLlm(INPUT, { apiKey: 'test', model: 'claude-haiku-4-5-20251001', client });

    expect(create).toHaveBeenCalledTimes(1);
    const params = create.mock.calls[0]![0] as {
      model: string;
      tool_choice: { type: string; name: string };
      tools: Array<{ name: string; strict: boolean; input_schema: Record<string, unknown> }>;
      messages: Array<{ content: string }>;
    };

    expect(params.model).toBe('claude-haiku-4-5-20251001');
    expect(params.tool_choice).toEqual({ type: 'tool', name: 'classify_repo' });

    const tool = params.tools[0]!;
    expect(tool.name).toBe('classify_repo');
    expect(tool.strict).toBe(true);

    // Strict mode (per Anthropic's structured-outputs docs) rejects a raw messages.create
    // request with a 400 if the schema carries a bound it doesn't support. `additionalProperties:
    // false` is required; `maxLength`, `minimum`/`maximum` and any `minItems`/`maxItems` beyond
    // 0/1 are not — regression coverage for exactly that class of bug.
    expect(tool.input_schema.additionalProperties).toBe(false);
    const schemaJson = JSON.stringify(tool.input_schema);
    expect(schemaJson).not.toContain('maxLength');
    expect(schemaJson).not.toContain('minimum');
    expect(schemaJson).not.toContain('maximum');
    expect(schemaJson).not.toContain('minItems');
    expect(schemaJson).not.toContain('maxItems');

    const properties = tool.input_schema.properties as {
      kind: { enum: string[] };
      domains: { items: { enum: string[] }; description: string };
      summary: { description: string };
      confidence: { description: string };
    };
    expect(properties.kind.enum).toEqual(allValues('kind').map((v) => v.id));
    expect(properties.domains.items.enum).toEqual(allValues('domains').map((v) => v.id));
    // The bounds strict mode can't express are pushed into the descriptions instead.
    expect(properties.summary.description).toContain('400 characters');
    expect(properties.confidence.description).toContain('between 0 and 1');
    expect(properties.domains.description).toContain('1 to 3');

    const prompt = params.messages[0]!.content;
    expect(prompt).toContain(INPUT.repo);
    expect(prompt).toContain(INPUT.readme);
    expect(prompt).toContain(INPUT.topics[0]);
    expect(prompt).toContain(INPUT.tree[0]);
    expect(prompt).toContain('untrusted third-party content');
  });
});
