// `?raw` is a Vite primitive: the YAML is inlined into the bundle as a string at build time.
// No YAML loader plugin is involved, and the file stays the single source of truth — this
// module only supplies the bytes that `taxonomy.ts` then parses and validates (AGENTS.md §6).
import raw from '../taxonomy.yaml?raw';

export const readTaxonomySource = (): string => raw;
