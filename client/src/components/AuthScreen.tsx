import type { ReactNode } from 'react';

/**
 * The signed-out screens and the forced credential change (docs/design/ui-foundation.md, "Auth"):
 * one centred 400px column on a card-pattern texture, the logo in Cinzel above a single form.
 */
export function AuthScreen({ children }: { children: ReactNode }) {
  return (
    <div className="auth-screen">
      <main className="page narrow">
        <p className="logo" aria-hidden="true">
          Wizard
        </p>
        <p className="logo-sub" aria-hidden="true">
          The trick-taking card game
        </p>
        <div className="panel">{children}</div>
      </main>
    </div>
  );
}
