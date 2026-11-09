// FIXTURE — not shipped, not linted. Every colour class below must resolve.
export function Good() {
  return (
    <article className="bg-surface border border-slate-200 rounded-lg shadow-card p-6">
      <h2 className="text-ink text-xl font-semibold tracking-snug">Capacité</h2>
      <p className="text-ink-2 text-md">62 / 100 personnes</p>
      <span className="bg-surface-muted text-text-tertiary border-border-input px-2">
        pending
      </span>
      <button className="bg-action text-action-on-primary ring-cobalt-500 hover:bg-action-hover">
        Inviter des personnes
      </button>
      <svg aria-hidden="true">
        <circle className="fill-green-500 stroke-amber-600" />
      </svg>
      {/* Classes that touch no family of ours must be ignored, not judged. */}
      <hr className="border-b text-center bg-gradient-to-br" />
    </article>
  );
}
