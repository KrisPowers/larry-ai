import React, { useEffect, useRef, useState } from 'react';
import { getModelDisplayName, getModelProvider, getModelProviderLabel } from '../lib/ollama';
import {
  IconArrowUp,
  IconCheck,
  IconChevronDown,
  IconHourglass,
  IconPlus,
  IconSlidersHorizontal,
  IconStop,
} from './Icon';
import { ProviderIcon } from './ProviderIcon';

export interface ChatComposerOption {
  value: string;
  label: string;
  description: string;
}

interface ChatComposerProps {
  className?: string;
  value: string;
  onValueChange: (value: string) => void;
  onKeyDown?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder: string;
  ariaLabel: string;
  disabled?: boolean;
  textareaRef?: React.MutableRefObject<HTMLTextAreaElement | null>;
  uploadTitle?: string;
  uploadDisabled?: boolean;
  uploadActive?: boolean;
  onUploadFiles?: (files: File[]) => void | Promise<void>;
  reasoningValue: string;
  reasoningOptions: ChatComposerOption[];
  onReasoningChange: (value: string) => void;
  reasoningDisabled?: boolean;
  presetValue: string;
  presetOptions: ChatComposerOption[];
  onPresetChange: (value: string) => void;
  presetDisabled?: boolean;
  modelValue: string;
  modelOptions: string[];
  onModelChange: (value: string) => void;
  modelDisabled?: boolean;
  onSend: () => void;
  sendDisabled?: boolean;
  isStreaming?: boolean;
  onStop?: () => void;
}

type PickerName = 'reasoning' | 'preset' | 'model' | null;

export function ChatComposer({
  className,
  value,
  onValueChange,
  onKeyDown,
  placeholder,
  ariaLabel,
  disabled = false,
  textareaRef,
  uploadTitle = 'Upload files or zip',
  uploadDisabled = false,
  uploadActive = false,
  onUploadFiles,
  reasoningValue,
  reasoningOptions,
  onReasoningChange,
  reasoningDisabled = false,
  presetValue,
  presetOptions,
  onPresetChange,
  presetDisabled = false,
  modelValue,
  modelOptions,
  onModelChange,
  modelDisabled = false,
  onSend,
  sendDisabled = false,
  isStreaming = false,
  onStop,
}: ChatComposerProps) {
  const fallbackTextareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const reasoningPickerRef = useRef<HTMLDivElement>(null);
  const presetPickerRef = useRef<HTMLDivElement>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const [openPicker, setOpenPicker] = useState<PickerName>(null);
  const resolvedTextareaRef = textareaRef ?? fallbackTextareaRef;
  const currentReasoning = reasoningOptions.find((option) => option.value === reasoningValue);
  const currentPreset = presetOptions.find((option) => option.value === presetValue);
  const currentModelProvider = getModelProvider(modelValue);
  const currentModelLabel = getModelDisplayName(modelValue);
  const currentModelAvailable = modelOptions.includes(modelValue);

  useEffect(() => {
    const element = resolvedTextareaRef.current;
    if (!element) return;
    element.style.height = '0px';
    element.style.height = `${Math.min(Math.max(element.scrollHeight, 35), 35)}px`;
  }, [resolvedTextareaRef, value]);

  useEffect(() => {
    if (!openPicker) return undefined;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!reasoningPickerRef.current?.contains(target) && !presetPickerRef.current?.contains(target) && !modelPickerRef.current?.contains(target)) {
        setOpenPicker(null);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenPicker(null);
      }
    };

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [openPicker]);

  async function handleUploadChange(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (!files.length || !onUploadFiles) return;
    await onUploadFiles(files);
  }

  function togglePicker(name: Exclude<PickerName, null>, pickerDisabled: boolean) {
    if (pickerDisabled || disabled) return;
    setOpenPicker((current) => (current === name ? null : name));
  }

  function renderOptionList(options: ChatComposerOption[], selectedValue: string, onChange: (value: string) => void) {
    return (
      <div className="chatbar-menu-list" role="listbox">
        {options.map((option) => {
          const isSelected = option.value === selectedValue;
          return (
            <button
              key={option.value}
              type="button"
              className={`chatbar-menu-item${isSelected ? ' active' : ''}`}
              onClick={() => {
                onChange(option.value);
                setOpenPicker(null);
              }}
            >
              <span className="chatbar-menu-item-copy">
                <strong>{option.label}</strong>
                <span>{option.description}</span>
              </span>
              <span className="chatbar-menu-item-mark">
                {isSelected ? <IconCheck size={15} /> : null}
              </span>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className={`chatbar-shell${className ? ` ${className}` : ''}`}>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={handleUploadChange}
      />

      <textarea
        ref={resolvedTextareaRef}
        className="chatbar-textarea"
        rows={1}
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={onKeyDown}
        disabled={disabled}
      />

      <div className="chatbar-footer">
        <div className="chatbar-left">
          <button
            type="button"
            className={`chatbar-mini-btn${uploadActive ? ' active' : ''}`}
            title={uploadTitle}
            disabled={uploadDisabled || disabled || !onUploadFiles}
            onClick={() => fileInputRef.current?.click()}
          >
            <IconPlus size={15} />
            {uploadActive ? <span className="chatbar-mini-btn-indicator" aria-hidden="true" /> : null}
          </button>

          <div className={`chatbar-picker${openPicker === 'reasoning' ? ' open' : ''}`} ref={reasoningPickerRef}>
            <button
              type="button"
              className="chatbar-mini-btn"
              title={`Reasoning: ${currentReasoning?.label ?? reasoningValue}`}
              onClick={() => togglePicker('reasoning', reasoningDisabled)}
              disabled={reasoningDisabled || disabled}
              aria-haspopup="listbox"
              aria-expanded={openPicker === 'reasoning'}
            >
              <IconSlidersHorizontal size={14} />
            </button>

            {openPicker === 'reasoning' ? (
              <div className="chatbar-menu chatbar-menu-upward" aria-label="Reasoning effort">
                <div className="chatbar-menu-head">
                  <span>Reasoning</span>
                  <strong>{currentReasoning?.label ?? reasoningValue}</strong>
                </div>
                {renderOptionList(reasoningOptions, reasoningValue, onReasoningChange)}
              </div>
            ) : null}
          </div>

          <div className={`chatbar-picker${openPicker === 'preset' ? ' open' : ''}`} ref={presetPickerRef}>
            <button
              type="button"
              className="chatbar-pill chatbar-pill-accent"
              onClick={() => togglePicker('preset', presetDisabled)}
              disabled={presetDisabled || disabled}
              aria-haspopup="listbox"
              aria-expanded={openPicker === 'preset'}
            >
              <span className="chatbar-pill-icon">
                <IconHourglass size={14} />
              </span>
              <span className="chatbar-pill-label">{currentPreset?.label ?? presetValue}</span>
              <span className="chatbar-pill-chevron">
                <IconChevronDown size={14} />
              </span>
            </button>

            {openPicker === 'preset' ? (
              <div className="chatbar-menu chatbar-menu-upward" aria-label="Preset type">
                <div className="chatbar-menu-head">
                  <span>Preset Type</span>
                  <strong>{currentPreset?.label ?? presetValue}</strong>
                </div>
                {renderOptionList(presetOptions, presetValue, onPresetChange)}
              </div>
            ) : null}
          </div>
        </div>

        <div className="chatbar-right">
          <div className={`chatbar-picker${openPicker === 'model' ? ' open' : ''}`} ref={modelPickerRef}>
            <button
              type="button"
              className="chatbar-model-btn"
              onClick={() => togglePicker('model', modelDisabled)}
              disabled={modelDisabled || disabled || !modelOptions.length}
              aria-haspopup="listbox"
              aria-expanded={openPicker === 'model'}
            >
              <span className="chatbar-model-copy">
                <ProviderIcon provider={currentModelProvider} size={20} className="chatbar-provider-icon" />
                <span className="chatbar-model-label">
                  {currentModelAvailable ? currentModelLabel : 'No model'}
                </span>
              </span>
              <span className="chatbar-model-chevron">
                <IconChevronDown size={18} />
              </span>
            </button>

            {openPicker === 'model' ? (
              <div className="chatbar-menu chatbar-menu-upward chatbar-model-menu" aria-label="Chat models">
                <div className="chatbar-menu-head">
                  <span>Model</span>
                  <strong>{currentModelAvailable ? currentModelLabel : 'No model detected'}</strong>
                </div>

                <div className="chatbar-menu-list" role="listbox">
                  {(modelOptions.length ? modelOptions : ['']).map((option) => {
                    const isSelected = option === modelValue;
                    const provider = getModelProvider(option);
                    const label = option ? getModelDisplayName(option) : 'No model detected';
                    const description = option
                      ? `Use ${getModelProviderLabel(option)} for this conversation.`
                      : 'No hosted or local models are available right now.';

                    return (
                      <button
                        key={option || 'none'}
                        type="button"
                        className={`chatbar-menu-item${isSelected ? ' active' : ''}`}
                        onClick={() => {
                          onModelChange(option);
                          setOpenPicker(null);
                        }}
                      >
                        <span className="chatbar-menu-item-main">
                          {option ? <ProviderIcon provider={provider} size={24} className="chatbar-provider-icon" /> : null}
                          <span className="chatbar-menu-item-copy">
                            <strong>{label}</strong>
                            <span>{description}</span>
                          </span>
                        </span>
                        <span className="chatbar-menu-item-mark">
                          {isSelected ? <IconCheck size={15} /> : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>

          {isStreaming && onStop ? (
            <button type="button" className="chatbar-send-btn stop" onClick={onStop} title="Stop generation">
              <IconStop size={14} />
            </button>
          ) : (
            <button
              type="button"
              className="chatbar-send-btn"
              onClick={onSend}
              disabled={sendDisabled || disabled}
              title="Send message"
            >
              <IconArrowUp size={15} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
