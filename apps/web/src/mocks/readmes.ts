/**
 * Mock README fixtures — development and test only.
 *
 * Already-safe HTML, matching what apps/api returns after rehype-sanitize and Shiki. Never
 * markdown: rendering untrusted README markdown in the browser is a stored-XSS hole across
 * the whole corpus (§9, §14), and a fixture must not be a worked example of it.
 *
 * Only curated repos have an entry. A generated repo has none on purpose — a missing README is
 * an ordinary state before the crawler reaches a repo, the tool page already handles it, and
 * dev should exercise that path regularly.
 */
export type MockReadme = { html: string; truncated: boolean };

const page = (title: string, blurb: string, install: string): MockReadme => ({
  html: [
    `<h1>${title}</h1>`,
    `<p>${blurb}</p>`,
    '<h2>Installation</h2>',
    `<pre><code>${install}</code></pre>`,
    '<h2>Usage</h2>',
    '<p>This is mock README content served by the development mock backend. It is not the real project documentation.</p>',
    '<h2>License</h2>',
    '<p>See the upstream repository for licensing.</p>',
  ].join('\n'),
  truncated: false,
});

export const MOCK_READMES: Record<string, MockReadme> = {
  'argoproj/argo-cd': page('Argo CD', 'Declarative GitOps continuous delivery for Kubernetes.', 'kubectl apply -n argocd -f install.yaml'),
  'cilium/cilium': page('Cilium', 'eBPF-based networking, observability and security.', 'helm install cilium cilium/cilium'),
  'derailed/k9s': page('K9s', 'Kubernetes CLI to manage your clusters in style.', 'brew install k9s'),
  'helm/helm': page('Helm', 'The Kubernetes package manager.', 'brew install helm'),
  'cert-manager/cert-manager': page('cert-manager', 'Automatically provision and manage TLS certificates.', 'helm install cert-manager jetstack/cert-manager'),
  'ahmetb/kubectx': page('kubectx + kubens', 'Faster way to switch between clusters and namespaces.', 'brew install kubectx'),
  'aquasecurity/trivy': page('Trivy', 'Find vulnerabilities, misconfigurations, secrets and SBOM.', 'brew install trivy'),
  'kubernetes-sigs/kind': page('kind', 'Kubernetes IN Docker — local clusters for testing.', 'brew install kind'),
};
