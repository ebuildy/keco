import { TAXONOMY } from '../taxonomy';

/**
 * `mise run taxonomy:check`. Importing the loader is the check: a malformed file throws at
 * module load with a message naming the problem. This binary exists so a broken taxonomy
 * fails the CI gate on its own line rather than inside an unrelated test's stack trace.
 */
let values = 0;
for (const family of TAXONOMY) {
  values += family.values.length;
  const hidden = family.values.filter((value) => value.hidden).length;
  const aliases = family.values.reduce((total, value) => total + value.aliases.length, 0);
  console.log(
    `${family.id.padEnd(16)} ${family.cardinality.padEnd(5)} ${family.source.padEnd(9)} ` +
      `${String(family.values.length).padStart(3)} values (${hidden} hidden, ${aliases} aliases)`,
  );
}
console.log(`\ntaxonomy ok — ${TAXONOMY.length} families, ${values} values`);
