import { z } from 'zod';

/**
 * Configuration, validated once at boot (AGENTS.md §13: validate every external payload with
 * zod at the boundary — the environment is one). A missing variable takes the process down
 * with the variable's name in the message, rather than surfacing as a confusing failure in
 * some request hours later.
 *
 * Nothing here is `VITE_`-prefixed. Those are inlined into the browser bundle at build time
 * and are public forever (§12); the portal reads its own, and none of them are secrets.
 */
const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  /** Absolute base for canonical links and the sitemap. */
  SITE_URL: z.url().default('http://localhost:3000'),

  MEILI_HOST: z.url().default('http://localhost:7700'),
  /** Server-side only, and the only copy in the system (§12). */
  MEILI_MASTER_KEY: z.string().min(1),

  /** Read-only, by key. Relative paths resolve against the workspace root (§3). */
  CACHE_DIR: z.string().min(1).default('.cache'),
  /** Where `vite build` put the portal. Served by @fastify/static. */
  WEB_DIST: z.string().min(1).default('apps/web/dist'),

  /** Signs the admin session cookie. 32 bytes minimum. */
  SESSION_SECRET: z.string().min(32),
  /** `scrypt$<salt>$<key>` — produced by `mise run admin:hash` (§12). */
  ADMIN_PASSWORD_HASH: z.string().min(1).optional(),
  /** Accepted by /api/commands/* in place of an admin session (§12). */
  COMMAND_TOKEN: z.string().min(1).optional(),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (parsed.success) return parsed.data;

  const issues = parsed.error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  throw new Error(`apps/api: invalid environment\n${issues}`);
}
