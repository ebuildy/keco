import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MOCK_MARKERS, scanForMocks } from './assert-no-mocks';

const fixture = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'keco-scan-'));
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, contents, 'utf8');
  }
  return root;
};

describe('scanForMocks', () => {
  it('finds nothing in a clean build', () => {
    const root = fixture({ 'assets/app.js': 'console.log("hello");', 'index.html': '<!doctype html>' });
    expect(scanForMocks(root)).toEqual([]);
  });

  it('detects the corpus sentinel, recursively', () => {
    const root = fixture({ 'assets/nested/chunk.js': 'const s="KECO_MOCK_CORPUS_DO_NOT_SHIP";' });
    const findings = scanForMocks(root);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('KECO_MOCK_CORPUS_DO_NOT_SHIP');
  });

  it('detects the MSW service worker', () => {
    const root = fixture({ 'mockServiceWorker.js': '/* Mock Service Worker */' });
    expect(scanForMocks(root)).not.toEqual([]);
  });

  it('detects the MSW runtime by a distinctive option name', () => {
    const root = fixture({ 'assets/app.js': 'start({onUnhandledRequest:"error"})' });
    expect(scanForMocks(root)).not.toEqual([]);
  });

  it('does not false-positive on short incidental substrings', () => {
    // "msw" occurs by chance in minified identifiers and hashed filenames. A guard that cries
    // wolf is a guard someone switches off, so bare "msw" is deliberately not a marker.
    const root = fixture({ 'assets/index-msw8chq.js': 'const amswitch=1;' });
    expect(scanForMocks(root)).toEqual([]);
  });

  it('declares markers that are all distinctive', () => {
    for (const marker of MOCK_MARKERS) expect(marker.length).toBeGreaterThan(10);
  });
});
