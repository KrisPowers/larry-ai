import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ResponseTraceSource } from '../types';
import { IconLink, IconX } from './Icon';

interface Props {
  sources: ResponseTraceSource[];
  onClose: () => void;
}

function getSourceHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

function getSourceFaviconUrl(url: string): string | null {
  const hostname = getSourceHostname(url);
  if (!hostname) return null;
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=128`;
}

function formatSourceDate(value?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function prettifySourceType(value?: ResponseTraceSource['sourceType']): string | null {
  if (!value) return null;
  return value.replace(/-/g, ' ');
}

function cleanPreview(value?: string): string {
  if (!value) return '';
  return value.replace(/\s+/g, ' ').trim();
}

function SourceRow({ source }: { source: ResponseTraceSource }) {
  const [iconFailed, setIconFailed] = useState(false);
  const hostname = getSourceHostname(source.url);
  const faviconUrl = getSourceFaviconUrl(source.url);
  const sourceDate = formatSourceDate(source.publishedAt);
  const sourceType = prettifySourceType(source.sourceType);
  const preview = cleanPreview(source.preview);
  const domainLabel = hostname || source.provider || source.title || source.url;

  return (
    <a
      className={`message-sources-item${source.status === 'error' ? ' error' : ''}`}
      href={source.url}
      target="_blank"
      rel="noreferrer"
    >
      <div className="message-sources-item-head">
        <span className="message-sources-item-mark">
          {faviconUrl && !iconFailed ? (
            <img
              src={faviconUrl}
              alt=""
              className="message-sources-item-favicon"
              onError={() => setIconFailed(true)}
            />
          ) : (
            <span className="message-sources-item-fallback">
              <IconLink size={13} />
            </span>
          )}
        </span>
        <div className="message-sources-item-domain">{domainLabel}</div>
      </div>

      <strong className="message-sources-item-title">{source.title || hostname || source.url}</strong>

      <div className="message-sources-item-meta">
        {sourceDate && <span>{sourceDate}</span>}
        {sourceType && <span>{sourceType}</span>}
        {source.credibility && <span>{source.credibility.replace(/-/g, ' ')}</span>}
      </div>

      {preview && <p className="message-sources-item-preview">{preview}</p>}
    </a>
  );
}

export function MessageSourcesPanel({ sources, onClose }: Props) {
  const primarySources = sources.slice(0, 5);
  const moreSources = sources.slice(5);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  const modal = (
    <div className="message-sources-layer" role="presentation">
      <button
        type="button"
        className="message-sources-backdrop"
        aria-label="Close sources"
        onClick={onClose}
      />

      <div
        className="message-sources-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="message-sources-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="message-sources-header">
          <h2 id="message-sources-title">Sources</h2>
          <button
            type="button"
            className="message-sources-close"
            aria-label="Close sources"
            onClick={onClose}
          >
            <IconX size={18} />
          </button>
        </div>

        <div className="message-sources-scroll">
          <div className="message-sources-list">
            {primarySources.map((source) => (
              <SourceRow key={source.id} source={source} />
            ))}
          </div>

          {moreSources.length > 0 && (
            <section className="message-sources-more">
              <div className="message-sources-more-label">More</div>
              <div className="message-sources-list">
                {moreSources.map((source) => (
                  <SourceRow key={source.id} source={source} />
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
