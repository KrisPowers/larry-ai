// FILE: src/components/ChecklistIndicator.tsx
import React from 'react';
import { IconCheck, IconCode2, IconListChecks } from './Icon';
import type { DeepStep } from '../lib/deepPlanner';

interface Props {
  steps: DeepStep[];
  /** 0 = planning not done yet, 1+ = step currently executing (1-based) */
  currentStep: number;
  isPlanning: boolean;
}

/**
 * Renders the full step checklist during code-planning execution.
 * Steps that are done get a check. The active step pulses. Future steps
 * are dimmed. Mimics a todo-list style progress view.
 */
export function ChecklistIndicator({ steps, currentStep, isPlanning }: Props) {
  if (isPlanning) {
    return (
      <div className="checklist-indicator">
        <div className="checklist-header">
          <div className="thinking-dots"><span /><span /><span /></div>
          <span className="checklist-header-label">Building implementation plan…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="checklist-indicator">
      <div className="checklist-header">
        <IconListChecks size={13} style={{ color: 'var(--accent)' }} />
        <span className="checklist-header-label">
          Step {Math.min(currentStep, steps.length)} of {steps.length}
        </span>
        <span className="checklist-progress-text">
          {currentStep > steps.length ? 'complete' : steps[currentStep - 1]?.filePath ?? ''}
        </span>
      </div>

      <div className="checklist-steps">
        {steps.map(step => {
          const done   = step.stepNumber < currentStep;
          const active = step.stepNumber === currentStep;
          const future = step.stepNumber > currentStep;

          return (
            <div
              key={step.stepNumber}
              className={`checklist-step ${done ? 'done' : active ? 'active' : 'future'}`}
            >
              <span className="checklist-step-icon">
                {done
                  ? <IconCheck size={10} />
                  : active
                    ? <span className="checklist-step-dot active-dot" />
                    : <span className="checklist-step-dot future-dot" />
                }
              </span>
              <span className="checklist-step-path">{step.filePath}</span>
              {active && (
                <span className="checklist-step-writing">writing…</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
