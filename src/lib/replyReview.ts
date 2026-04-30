import { isDesktopRuntime } from './persistence';

export interface ReplyReviewIssue {
  code: string;
  severity: string;
  message: string;
  evidence?: string;
}

export interface ReplyReviewRequest {
  prompt: string;
  draft: string;
  referenceDate: string;
  fetchLiveContext: boolean;
  verifiedSourceCount: number;
  preferredSourceCount: number;
}

export interface ReplyReviewResult {
  approved: boolean;
  requiresRewrite: boolean;
  sanitizedReply: string;
  reviewSummary: string;
  rewritePrompt?: string;
  issues: ReplyReviewIssue[];
}

interface ReplyReviewBridge {
  ReviewAssistantReply(request: ReplyReviewRequest): Promise<ReplyReviewResult>;
}

function getBridge(): ReplyReviewBridge | null {
  if (!isDesktopRuntime() || typeof window === 'undefined') return null;
  const app = window.go?.main?.App as Partial<ReplyReviewBridge> | undefined;
  if (!app || typeof app.ReviewAssistantReply !== 'function') return null;
  return app as ReplyReviewBridge;
}

export async function reviewAssistantReply(request: ReplyReviewRequest): Promise<ReplyReviewResult> {
  const bridge = getBridge();
  if (!bridge) {
    return {
      approved: true,
      requiresRewrite: false,
      sanitizedReply: request.draft,
      reviewSummary: 'Reply review bridge unavailable; returning the draft unchanged.',
      issues: [],
    };
  }

  return bridge.ReviewAssistantReply(request);
}
