// FIXTURE — this file MUST fail the token test. It is the self-test's proof
// that the check can still fail; a guard nobody has watched fail is a guard
// nobody knows works.
export function Broken() {
  return (
    <article className="bg-slate-950 border-surface-raised">
      {/* `coral` was the hub's family and is retired from this palette. It is
          not one of our families any more, so the check must SKIP it rather
          than report it — reporting it would mean the check judges every
          hyphenated class in the codebase. */}
      <p className="text-ink-4 border-coral-line">Illisible</p>
    </article>
  );
}
