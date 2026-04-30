package replyreview

import (
	"strings"
	"testing"
)

func TestReviewSanitizesReplyLevelSourceNarration(t *testing.T) {
	result := Review(Request{
		Prompt:        `Can you give me more details on this cloud infrastructure partnership announcement?`,
		Draft:         "According to the sources provided, the companies signed a multiyear cloud infrastructure agreement.\n\nSources:\n1. https://example.com/a\n2. https://example.com/b",
		ReferenceDate: "2026-04-11T12:00:00Z",
	})

	if strings.Contains(strings.ToLower(result.SanitizedReply), "according to the sources provided") {
		t.Fatalf("expected source lead-in to be removed, got %q", result.SanitizedReply)
	}
	if strings.Contains(strings.ToLower(result.SanitizedReply), "\nsources:") {
		t.Fatalf("expected trailing sources list to be removed, got %q", result.SanitizedReply)
	}
	if !result.RequiresRewrite {
		t.Fatalf("expected short detail-seeking draft to require rewrite")
	}
}

func TestReviewAllowsSourceListWhenPromptAsksForSources(t *testing.T) {
	result := Review(Request{
		Prompt:        "What sources did you use for that answer?",
		Draft:         "Here are the sources I used.\n\nSources:\n1. https://example.com/a\n2. https://example.com/b",
		ReferenceDate: "2026-04-11",
	})

	if !strings.Contains(strings.ToLower(result.SanitizedReply), "\nsources:") {
		t.Fatalf("expected sources list to remain when the prompt asks for it, got %q", result.SanitizedReply)
	}
}

func TestReviewFlagsPastDateDescribedAsUpcoming(t *testing.T) {
	result := Review(Request{
		Prompt:        "What is the current status?",
		Draft:         "The launch is scheduled for April 10, 2026.",
		ReferenceDate: "2026-04-11T00:00:00Z",
	})

	if !result.RequiresRewrite {
		t.Fatalf("expected tense mismatch to require rewrite")
	}
	found := false
	for _, issue := range result.Issues {
		if issue.Code == "date-tense-mismatch" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected a date-tense-mismatch issue, got %#v", result.Issues)
	}
}

func TestReviewFlagsContradictoryEntityClaims(t *testing.T) {
	result := Review(Request{
		Prompt: "Who were the key defendants?",
		Draft: strings.Join([]string{
			"Jordan Vale was tried and convicted at the tribunal.",
			"However, Jordan Vale was not tried because Jordan Vale died before the trial began.",
		}, " "),
		ReferenceDate: "2026-04-12T00:00:00Z",
	})

	if !result.RequiresRewrite {
		t.Fatalf("expected contradictory entity claims to require rewrite")
	}

	found := false
	for _, issue := range result.Issues {
		if issue.Code == "entity-contradiction" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected an entity-contradiction issue, got %#v", result.Issues)
	}
}
