import { describe, expect, it } from 'vitest';
import { parseTaxonomy } from './taxonomy-schema';

/**
 * The parser is pure — it takes text, not a path — precisely so these tests can drive it
 * with deliberately broken files without writing anything to disk.
 */
const valid = `
version: 1
families:
  - id: kind
    label: Kind
    param: kind
    description: What the artifact is.
    cardinality: one
    source: analyzer
    facet: true
    values:
      - id: cli
        label: CLI
        description: A command-line binary.
        aliases: [cli, command-line]
      - id: operator
        label: Operator
        description: A CRD plus its controller.
  - id: openness
    label: Openness
    param: openness
    description: Whether the whole product is open source.
    cardinality: one
    source: derived
    values:
      - id: fully-open
        label: Fully open
        description: Everything is under an OSI licence.
      - id: unknown
        label: Unknown
        description: Not enough evidence.
        hidden: true
`;

describe('parseTaxonomy', () => {
  it('parses a valid file', () => {
    const taxonomy = parseTaxonomy(valid);
    expect(taxonomy.version).toBe(1);
    expect(taxonomy.families).toHaveLength(2);
    expect(taxonomy.families[0]!.values[0]!.id).toBe('cli');
  });

  it('defaults aliases to empty and hidden to false', () => {
    const kind = parseTaxonomy(valid).families[0]!;
    expect(kind.values[1]!.aliases).toEqual([]);
    expect(kind.values[1]!.hidden).toBe(false);
  });

  it('rejects a duplicate family id', () => {
    const text = valid + valid.slice(valid.indexOf('  - id: kind'));
    expect(() => parseTaxonomy(text)).toThrow(/duplicate family id: kind/);
  });

  it('rejects a duplicate value id within a family', () => {
    const text = valid.replace('      - id: operator', '      - id: cli');
    expect(() => parseTaxonomy(text)).toThrow(/duplicate value id: kind\/cli/);
  });

  it('rejects a duplicate alias within a family', () => {
    const text = valid.replace('aliases: [cli, command-line]', 'aliases: [cli, cli]');
    expect(() => parseTaxonomy(text)).toThrow(/duplicate alias: kind\/cli/);
  });

  it('rejects a derived family with no unknown value', () => {
    const text = valid.replace('      - id: unknown', '      - id: mystery');
    expect(() => parseTaxonomy(text)).toThrow(/derived family openness has no "unknown" value/);
  });

  it('rejects min or max on a cardinality: one family', () => {
    const text = valid.replace('    cardinality: one\n    source: analyzer', '    cardinality: one\n    max: 3\n    source: analyzer');
    expect(() => parseTaxonomy(text)).toThrow(/family kind is cardinality: one and cannot declare min or max/);
  });

  it('rejects min greater than max', () => {
    const text = valid.replace(
      '    cardinality: one\n    source: analyzer',
      '    cardinality: many\n    min: 4\n    max: 3\n    source: analyzer',
    );
    expect(() => parseTaxonomy(text)).toThrow(/family kind has min 4 greater than max 3/);
  });

  it('rejects a duplicate param across families', () => {
    const text = valid.replace('    param: openness', '    param: kind');
    expect(() => parseTaxonomy(text)).toThrow(/duplicate family param: kind/);
  });

  it('rejects malformed YAML', () => {
    expect(() => parseTaxonomy('version: 1\nfamilies: [')).toThrow(/^taxonomy: invalid YAML:/);
  });

  it('rejects an unknown source', () => {
    const text = valid.replace('source: analyzer', 'source: magic');
    // Shape errors go through the same `taxonomy: ` prefix and read as prose (via
    // z.prettifyError), not a raw ZodError with a JSON-stringified issue array.
    expect(() => parseTaxonomy(text)).toThrow(/^taxonomy: .*\bsource\b/s);
  });

  it('rejects an unknown value that is not hidden in a derived family', () => {
    const text = valid.replace('        hidden: true', '');
    expect(() => parseTaxonomy(text)).toThrow(
      /family openness has an "unknown" value that is not hidden/,
    );
  });

  it('rejects an unknown value that is not hidden in an analyzer family', () => {
    const text = valid.replace(
      '      - id: operator\n        label: Operator\n        description: A CRD plus its controller.\n',
      '      - id: operator\n        label: Operator\n        description: A CRD plus its controller.\n' +
        '      - id: unknown\n        label: Unknown\n        description: Not enough evidence.\n',
    );
    expect(() => parseTaxonomy(text)).toThrow(
      /family kind has an "unknown" value that is not hidden/,
    );
  });
});
