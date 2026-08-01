import { describe, expect, it } from 'vitest';
import type { RuleInput } from './kind';
import { classifyRuntime } from './runtime';

const base: RuleInput = {
  repo: 'acme/thing',
  name: 'thing',
  description: null,
  topics: [],
  tree: ['README.md'],
  manifests: {},
  language: 'Go',
};

describe('classifyRuntime', () => {
  it('calls a distribution the cluster itself', () => {
    expect(classifyRuntime(base, 'distribution').runtime).toBe('cluster-itself');
  });

  it('puts a krew plugin on the workstation even when it also ships a chart', () => {
    const input = { ...base, tree: ['.krew.yaml', 'charts/thing/Chart.yaml'] };
    expect(classifyRuntime(input, 'kubectl-plugin').runtime).toBe('workstation');
  });

  it('puts a chart in the cluster', () => {
    expect(classifyRuntime({ ...base, tree: ['Chart.yaml'] }, 'helm-chart').runtime).toBe('in-cluster');
  });

  it('puts CRDs in the cluster', () => {
    const input = { ...base, tree: ['config/crd/bases/x.yaml', 'PROJECT'] };
    expect(classifyRuntime(input, 'operator').runtime).toBe('in-cluster');
  });

  it('recognises a GitHub Action as a pipeline step', () => {
    expect(classifyRuntime({ ...base, tree: ['action.yml'] }, null).runtime).toBe('ci-pipeline');
  });

  it('does not mistake a workflow file for an action', () => {
    const input = { ...base, tree: ['.github/workflows/ci.yml'] };
    expect(classifyRuntime(input, null).runtime).toBe('unknown');
  });

  it('recognises a library with no command', () => {
    const input = { ...base, manifests: { 'go.mod': 'require k8s.io/client-go v0.29.0' } };
    expect(classifyRuntime(input, 'library-sdk').runtime).toBe('in-your-code');
  });

  it('falls back to in-cluster for an in-cluster kind with no structural evidence', () => {
    expect(classifyRuntime(base, 'controller').runtime).toBe('in-cluster');
  });

  it('returns unknown with zero confidence when nothing fires', () => {
    const verdict = classifyRuntime(base, null);
    expect(verdict.runtime).toBe('unknown');
    expect(verdict.confidence).toBe(0);
    expect(verdict.rule).toBe('none');
  });

  it('puts a bare cli kind on the workstation at the weaker kind-only confidence', () => {
    const verdict = classifyRuntime(base, 'cli');
    expect(verdict.runtime).toBe('workstation');
    expect(verdict.confidence).toBe(0.65);
    expect(verdict.rule).toBe('kind:cli');
  });

  it('puts a bare ide-extension kind on the workstation', () => {
    expect(classifyRuntime(base, 'ide-extension').runtime).toBe('workstation');
  });

  it('does not turn the LLM fallback kind "service" into a runtime guess', () => {
    // `service` is FALLBACK_KIND — what the LLM assigns when it could not classify the repo
    // at all (confidence 0.3, needs_review: true). It must never imply a runtime.
    const verdict = classifyRuntime(base, 'service');
    expect(verdict.runtime).toBe('unknown');
    expect(verdict.confidence).toBe(0);
  });

  it('does not guess a runtime for dashboard-ui, which spans both', () => {
    // Lens and k9s are workstation apps that connect out to a cluster; Kubernetes Dashboard
    // and Headlamp run as in-cluster workloads. No single mapping is right.
    const verdict = classifyRuntime(base, 'dashboard-ui');
    expect(verdict.runtime).toBe('unknown');
    expect(verdict.confidence).toBe(0);
  });

  it('still falls back to in-cluster for a bare operator kind', () => {
    const verdict = classifyRuntime(base, 'operator');
    expect(verdict.runtime).toBe('in-cluster');
    expect(verdict.confidence).toBe(0.6);
  });
});
