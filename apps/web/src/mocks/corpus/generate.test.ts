import { ToolDocument, allValues } from '@keco/core';
import { describe, expect, it } from 'vitest';
import { generateTools } from './generate';

describe('generateTools', () => {
  it('produces exactly the requested count', () => {
    expect(generateTools(50)).toHaveLength(50);
  });

  it('is deterministic — same seed, byte-identical output', () => {
    expect(JSON.stringify(generateTools(20))).toBe(JSON.stringify(generateTools(20)));
  });

  it('produces unique ids', () => {
    const tools = generateTools(200);
    expect(new Set(tools.map((tool) => tool.id)).size).toBe(200);
  });

  it('produces documents that satisfy the read model schema', () => {
    for (const tool of generateTools(100)) {
      expect(() => ToolDocument.parse(tool)).not.toThrow();
    }
  });

  it('draws values from the taxonomy file, so every kind gets represented at volume', () => {
    const kinds = new Set(generateTools(300).map((tool) => tool.kind));
    for (const value of allValues('kind')) {
      expect(kinds.has(value.id)).toBe(true);
    }
  });
});
