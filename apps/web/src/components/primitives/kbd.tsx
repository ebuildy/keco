export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-line-strong bg-surface px-1 font-mono text-[10px] text-muted">
      {children}
    </kbd>
  );
}
