import { describe, expect, it } from 'vitest';
import { identifyPackage } from './package-identity';

describe('identifyPackage', () => {
  it('reads the module path from go.mod', () => {
    expect(
      identifyPackage({ 'go.mod': 'module sigs.k8s.io/controller-runtime\n\ngo 1.22\n' }),
    ).toEqual({
      ecosystem: 'Go',
      name: 'sigs.k8s.io/controller-runtime',
    });
  });

  it('reads the name field from package.json', () => {
    expect(
      identifyPackage({ 'package.json': JSON.stringify({ name: '@kubernetes/client-node' }) }),
    ).toEqual({
      ecosystem: 'npm',
      name: '@kubernetes/client-node',
    });
  });

  it('reads the package name from Cargo.toml', () => {
    const cargo = '[package]\nname = "kube"\nversion = "0.1.0"\n';
    expect(identifyPackage({ 'Cargo.toml': cargo })).toEqual({
      ecosystem: 'crates.io',
      name: 'kube',
    });
  });

  it('reads the project name from pyproject.toml', () => {
    const pyproject = '[project]\nname = "kopf"\nversion = "1.0"\n';
    expect(identifyPackage({ 'pyproject.toml': pyproject })).toEqual({
      ecosystem: 'PyPI',
      name: 'kopf',
    });
  });

  it('degrades to null rather than guess when no manifest gives a clean identity', () => {
    expect(identifyPackage({})).toBeNull();
    expect(identifyPackage({ 'package.json': '{not json' })).toBeNull();
  });

  it('prefers go.mod when a repo somehow carries more than one manifest', () => {
    expect(
      identifyPackage({
        'go.mod': 'module example.com/foo\n',
        'package.json': JSON.stringify({ name: 'foo' }),
      }),
    ).toEqual({ ecosystem: 'Go', name: 'example.com/foo' });
  });
});
