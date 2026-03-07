// FILE: src/components/NoCodeWarning.tsx
import React, { useState } from 'react';
import { IconX } from './Icon';

interface Props {
  model: string;
}

/**
 * Shown inline in a chat when the assistant produced a plan and/or changelog
 * but zero actual file code blocks. Tells the user exactly what happened and
 * what to do about it.
 */
export function NoCodeWarning({ model }: Props) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  return (
    <div className="no-code-warning">
      <div className="no-code-warning-header">
        <span className="no-code-warning-title">⚠ No code was produced</span>
        <button className="no-code-warning-close" onClick={() => setDismissed(true)}>
          <IconX size={12} />
        </button>
      </div>
      <p>
        The model listed files and wrote a changelog but did not output any
        code blocks. This usually means <strong>{model || 'the selected model'}</strong> is
        too small to follow the Code preset's instructions reliably.
      </p>
      <p className="no-code-warning-suggestions-label">Try one of the following:</p>
      <ul>
        <li>Switch to a larger or more capable model (13B+ recommended for complex tasks, 70B+ for large projects).</li>
        <li>Break the request into smaller pieces — ask for one file or one feature at a time.</li>
        <li>Send a follow-up: <code>"You listed the files but didn't write them. Write all the code now."</code></li>
      </ul>
    </div>
  );
}
