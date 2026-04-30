// FILE: src/components/ChecklistIndicator.tsx
import { IconCheck, IconListChecks } from './Icon';
import type { DeepStep, RequestMode } from '../lib/deepPlanner';

const MODE_LABELS: Record<RequestMode, string> = {
  complete_project:    'New Project',
  feature_build:       'Feature Build',
  feature_integration: 'Integration',
  debug:               'Debug',
  refactor:            'Refactor',
  code_snippet:        'Snippet',
  explain:             'Explain',
  edit_file:           'Edit',
  docs_only:           'Docs',
  add_files:           'Add Files',
};

const MODE_COLORS: Record<RequestMode, string> = {
  complete_project:    'var(--accent)',
  feature_build:       'var(--accent2)',
  feature_integration: '#a78bfa',
  debug:               'var(--danger)',
  refactor:            'var(--accent3)',
  code_snippet:        '#5d87d6',
  explain:             'var(--muted)',
  edit_file:           'var(--accent2)',
  docs_only:           '#34d399',
  add_files:           '#fb923c',
};

interface Props {
  steps: DeepStep[];
  /** 0 = planning not done yet, 1+ = step currently executing (1-based) */
  currentStep: number;
  isPlanning: boolean;
  /** Classification mode — shown as a badge in the header */
  mode?: RequestMode;
  /** True while classification is running (before planning starts) */
  isClassifying?: boolean;
}

/**
 * Renders the full step checklist during code-planning execution.
 * Steps that are done get a check. The active step pulses. Future steps
 * are dimmed. Mimics a todo-list style progress view.
 */
export function ChecklistIndicator({ steps, currentStep, isPlanning, mode, isClassifying }: Props) {
  if (isClassifying) {
    return (
      <div className="checklist-indicator">
        <div className="checklist-header">
          <div className="thinking-dots"><span /><span /><span /></div>
          <span className="checklist-header-label">Analysing request…</span>
        </div>
      </div>
    );
  }

  if (isPlanning) {
    return (
      <div className="checklist-indicator">
        <div className="checklist-header">
          <div className="thinking-dots"><span /><span /><span /></div>
          <span className="checklist-header-label">Building implementation plan…</span>
          {mode && (
            <span className="checklist-mode-badge" style={{ background: `color-mix(in srgb, ${MODE_COLORS[mode]} 15%, transparent)`, color: MODE_COLORS[mode], borderColor: `color-mix(in srgb, ${MODE_COLORS[mode]} 35%, transparent)` }}>
              {MODE_LABELS[mode]}
            </span>
          )}
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
        {mode && (
          <span className="checklist-mode-badge" style={{ background: `color-mix(in srgb, ${MODE_COLORS[mode]} 15%, transparent)`, color: MODE_COLORS[mode], borderColor: `color-mix(in srgb, ${MODE_COLORS[mode]} 35%, transparent)` }}>
            {MODE_LABELS[mode]}
          </span>
        )}
        <span className="checklist-progress-text">
          {currentStep > steps.length ? 'complete' : steps[currentStep - 1]?.filePath ?? ''}
        </span>
      </div>

      <div className="checklist-steps">
        {steps.map(step => {
          const done   = step.stepNumber < currentStep;
          const active = step.stepNumber === currentStep;

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
