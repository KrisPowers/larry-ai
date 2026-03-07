// FILE: src/components/StreamingPhaseIndicator.tsx
import React from 'react';
import type { StreamingPhase } from '../types';

interface Props {
  phase: StreamingPhase;
}

/**
 * Progress indicator shown during multi-step generation.
 * Mirrors Claude's own step-by-step UI — shows the current step label,
 * a step counter, and a progress bar when there are multiple steps.
 */
export function StreamingPhaseIndicator({ phase }: Props) {
  const isPlanning = phase.stepIndex === 0;
  const progress = phase.totalSteps > 0
    ? Math.round((phase.stepIndex / phase.totalSteps) * 100)
    : 0;

  return (
    <div className="phase-indicator">
      <div className="phase-indicator-top">
        <div className="thinking-dots">
          <span /><span /><span />
        </div>
        <span className="phase-label">{phase.label}</span>
        {!isPlanning && phase.totalSteps > 1 && (
          <span className="phase-step-counter">
            {phase.stepIndex} / {phase.totalSteps}
          </span>
        )}
      </div>

      {!isPlanning && phase.totalSteps > 1 && (
        <div className="phase-progress-wrap">
          <div className="phase-progress-bar">
            <div
              className="phase-progress-fill"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
