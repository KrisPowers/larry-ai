/**
 * Icon.tsx — Lucide-style SVG icon components.
 *
 * All icons are inline SVG, sized via the `size` prop (default 16).
 * Stroke colour inherits from `currentColor` so they respond to CSS color.
 *
 * To add a new icon: copy the <path> / <polyline> data from lucide.dev,
 * wrap it in a new export using the Icon() helper below.
 */

import React from 'react';

interface SVGProps {
  size?: number;
  className?: string;
  style?: React.CSSProperties;
  strokeWidth?: number;
}

function Svg({
  size = 16,
  strokeWidth = 1.75,
  className,
  style,
  children,
}: SVGProps & { children: React.ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ flexShrink: 0, display: 'inline-block', verticalAlign: 'middle', ...style }}
    >
      {children}
    </svg>
  );
}

export function IconSend(p: SVGProps) {
  return <Svg {...p}><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></Svg>;
}

export function IconStop(p: SVGProps) {
  return <Svg {...p}><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/></Svg>;
}

export function IconRotateCcw(p: SVGProps) {
  return <Svg {...p}><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.5"/></Svg>;
}

export function IconX(p: SVGProps) {
  return <Svg {...p}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></Svg>;
}

export function IconMenu(p: SVGProps) {
  return <Svg {...p}><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></Svg>;
}

export function IconPlus(p: SVGProps) {
  return <Svg {...p}><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></Svg>;
}

/** Empty / welcome state logo */
export function IconHexagon(p: SVGProps) {
  return <Svg {...p} strokeWidth={1}><polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5 12 2"/><line x1="12" y1="2" x2="12" y2="22"/><line x1="2" y1="8.5" x2="22" y2="8.5"/><line x1="2" y1="15.5" x2="22" y2="15.5"/></Svg>;
}

export function IconChevronDown(p: SVGProps) {
  return <Svg {...p}><polyline points="6 9 12 15 18 9"/></Svg>;
}

export function IconChevronUp(p: SVGProps) {
  return <Svg {...p}><polyline points="18 15 12 9 6 15"/></Svg>;
}

export function IconChevronRight(p: SVGProps) {
  return <Svg {...p}><polyline points="9 18 15 12 9 6"/></Svg>;
}

export function IconFileText(p: SVGProps) {
  return <Svg {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></Svg>;
}

export function IconFolder(p: SVGProps) {
  return <Svg {...p}><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></Svg>;
}

export function IconFolderOpen(p: SVGProps) {
  return <Svg {...p}><path d="M5 19a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1"/><path d="M22 19H2l4-8h16l-4 8z"/></Svg>;
}

export function IconDownload(p: SVGProps) {
  return <Svg {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></Svg>;
}

export function IconArchive(p: SVGProps) {
  return <Svg {...p}><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></Svg>;
}

export function IconMessageSquare(p: SVGProps) {
  return <Svg {...p}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></Svg>;
}

export function IconCopy(p: SVGProps) {
  return <Svg {...p}><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></Svg>;
}

export function IconCheck(p: SVGProps) {
  return <Svg {...p}><polyline points="20 6 9 17 4 12"/></Svg>;
}

export function IconPaperclip(p: SVGProps) {
  return <Svg {...p}><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></Svg>;
}

export function IconGripHorizontal(p: SVGProps) {
  return <Svg {...p}><circle cx="9" cy="9" r="1" fill="currentColor"/><circle cx="15" cy="9" r="1" fill="currentColor"/><circle cx="9" cy="15" r="1" fill="currentColor"/><circle cx="15" cy="15" r="1" fill="currentColor"/></Svg>;
}

export function IconRefreshCw(p: SVGProps) {
  return <Svg {...p}><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></Svg>;
}

export function IconTrash2(p: SVGProps) {
  return <Svg {...p}><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></Svg>;
}

export function IconTerminal(p: SVGProps) {
  return <Svg {...p}><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></Svg>;
}

export function IconSparkles(p: SVGProps) {
  return <Svg {...p}><path d="M12 3L9.5 9.5 3 12l6.5 2.5L12 21l2.5-6.5L21 12l-6.5-2.5L12 3z"/></Svg>;
}

export function IconCode2(p: SVGProps) {
  return <Svg {...p}><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/></Svg>;
}

export function IconListChecks(p: SVGProps) {
  return <Svg {...p}><path d="M11 17H19"/><path d="M11 12H19"/><path d="M11 7H19"/><polyline points="4 7 5.5 8.5 8 6"/><polyline points="4 12 5.5 13.5 8 11"/><polyline points="4 17 5.5 18.5 8 16"/></Svg>;
}
