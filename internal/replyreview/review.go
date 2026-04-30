package replyreview

import (
	"fmt"
	"regexp"
	"strings"
	"time"
)

type Request struct {
	Prompt               string `json:"prompt"`
	Draft                string `json:"draft"`
	ReferenceDate        string `json:"referenceDate"`
	FetchLiveContext     bool   `json:"fetchLiveContext"`
	VerifiedSourceCount  int    `json:"verifiedSourceCount"`
	PreferredSourceCount int    `json:"preferredSourceCount"`
}

type Issue struct {
	Code     string `json:"code"`
	Severity string `json:"severity"`
	Message  string `json:"message"`
	Evidence string `json:"evidence,omitempty"`
}

type Result struct {
	Approved        bool    `json:"approved"`
	RequiresRewrite bool    `json:"requiresRewrite"`
	SanitizedReply  string  `json:"sanitizedReply"`
	ReviewSummary   string  `json:"reviewSummary"`
	RewritePrompt   string  `json:"rewritePrompt,omitempty"`
	Issues          []Issue `json:"issues"`
}

type datedMatch struct {
	Raw   string
	Start int
	End   int
	When  time.Time
}

var (
	leadingMetaPatterns = []*regexp.Regexp{
		regexp.MustCompile(`(?is)^\s*according to the sources provided,?\s*`),
		regexp.MustCompile(`(?is)^\s*according to the provided sources,?\s*`),
		regexp.MustCompile(`(?is)^\s*based on the sources provided,?\s*`),
		regexp.MustCompile(`(?is)^\s*based on the provided sources,?\s*`),
		regexp.MustCompile(`(?is)^\s*based on the context provided,?\s*`),
		regexp.MustCompile(`(?is)^\s*based on the provided context,?\s*`),
		regexp.MustCompile(`(?is)^\s*based on the research (?:provided|gathered|above),?\s*`),
		regexp.MustCompile(`(?is)^\s*from the context provided,?\s*`),
		regexp.MustCompile(`(?is)^\s*from the provided context,?\s*`),
		regexp.MustCompile(`(?is)^\s*from the sources provided,?\s*`),
		regexp.MustCompile(`(?is)^\s*i reviewed live external sources before responding\.?\s*`),
	}
	trailingSourcesBlockPattern  = regexp.MustCompile(`(?is)\n+(?:sources|references|citations)\s*:\s*\n(?:\s*(?:[-*]|\d+\.)\s+[^\n]*(?:\n|$))+`)
	collapseBlankLinesPattern    = regexp.MustCompile(`\n{3,}`)
	inlineAttributionPattern     = regexp.MustCompile(`(?i)\b(?:according to|as reported by|reported by|per)\s+(?:the\s+)?[A-Z][A-Za-z0-9&.'-]+(?:\s+[A-Z][A-Za-z0-9&.'-]+){0,4}\b`)
	explicitSourcePromptPattern  = regexp.MustCompile(`(?i)\b(?:source|sources|citation|citations|cite|cited|evidence|proof|reference|references|link|links|where did you get|how do you know|show me the source|show me the sources)\b`)
	detailPromptPattern          = regexp.MustCompile(`(?i)\b(?:more details?|detailed|detail|explain|why|how|walk me through|break down|tell me more|elaborate|full context|what happened)\b`)
	shortPromptPattern           = regexp.MustCompile(`(?i)\b(?:brief|briefly|quick|quickly|short|tl;dr|one sentence|few words)\b`)
	isoDatePattern               = regexp.MustCompile(`\b\d{4}-\d{2}-\d{2}\b`)
	monthDatePattern             = regexp.MustCompile(`(?i)\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},\s+\d{4}\b`)
	personNamePattern            = regexp.MustCompile(`\b([A-Z][A-Za-z'’-]+(?:\s+[A-Z][A-Za-z'’-]+){1,3})\b`)
	positiveParticipationPattern = regexp.MustCompile(`(?i)\b(?:was tried|were tried|stood trial|stood trials|was convicted|were convicted|found guilty|sentenced to death)\b`)
	negativeParticipationPattern = regexp.MustCompile(`(?i)\b(?:was not tried|were not tried|not tried|not on trial|not a defendant|never tried|died before (?:the )?(?:trial|hearing|proceedings)|dead before (?:the )?(?:trial|hearing|proceedings)|committed suicide before (?:the )?(?:trial|hearing|proceedings)|killed (?:himself|herself|themselves) before (?:the )?(?:trial|hearing|proceedings)|was dead before)\b`)
	executionOutcomePattern      = regexp.MustCompile(`(?i)\b(?:was executed|were executed|was hanged|were hanged|was hung|were hung|hanged by the gallows|hung by the gallows)\b`)
	suicideOutcomePattern        = regexp.MustCompile(`(?i)\b(?:committed suicide|killed (?:himself|herself|themselves)|died by suicide|suicide by)\b`)
)

var (
	pastTenseMarkers = []string{
		"happened",
		"occurred",
		"launched",
		"announced",
		"completed",
		"ended",
		"began",
		"started",
		"took place",
		"was held",
		"was announced",
		"was launched",
	}
	futureTenseMarkers = []string{
		"scheduled",
		"upcoming",
		"expected",
		"set for",
		"slated",
		"planned",
		"will be",
		"will happen",
		"will launch",
		"due on",
		"coming on",
	}
)

func Review(request Request) Result {
	rawDraft := strings.TrimSpace(normalizeLineEndings(request.Draft))
	if rawDraft == "" {
		return Result{
			Approved:        false,
			RequiresRewrite: true,
			SanitizedReply:  "",
			ReviewSummary:   "The draft was empty and needs a fresh rewrite.",
			RewritePrompt: strings.Join([]string{
				"Rewrite the answer from scratch.",
				"Return only the final answer.",
				"Answer directly without mentioning sources, context, or the retrieval process unless the user explicitly asked for them.",
			}, "\n"),
			Issues: []Issue{{
				Code:     "empty-draft",
				Severity: "error",
				Message:  "The draft was empty.",
			}},
		}
	}

	allowSourceDiscussion := explicitSourcePromptPattern.MatchString(request.Prompt)
	sanitizedReply, removedMetaPhrasing, removedSourceList := sanitizeReply(rawDraft, allowSourceDiscussion)
	if sanitizedReply == "" {
		sanitizedReply = rawDraft
	}

	referenceDate := parseReferenceDate(request.ReferenceDate)
	minWords := minimumWordCount(request.Prompt, request.VerifiedSourceCount)
	wordCount := countWords(sanitizedReply)

	issues := make([]Issue, 0, 4)
	if removedMetaPhrasing {
		issues = append(issues, Issue{
			Code:     "source-meta-phrasing",
			Severity: "warning",
			Message:  "Removed reply-level source or context phrasing so the answer stays direct.",
		})
	}
	if removedSourceList {
		issues = append(issues, Issue{
			Code:     "reply-source-list",
			Severity: "warning",
			Message:  "Removed a trailing sources list because the UI already exposes sources unless the user explicitly asks for them in the reply.",
		})
	}
	if !allowSourceDiscussion && inlineAttributionPattern.MatchString(sanitizedReply) {
		issues = append(issues, Issue{
			Code:     "inline-source-attribution",
			Severity: "warning",
			Message:  "The draft still names sources inline even though the prompt did not ask for citations or source discussion.",
		})
	}
	if wordCount < minWords {
		issues = append(issues, Issue{
			Code:     "insufficient-detail",
			Severity: "warning",
			Message:  fmt.Sprintf("The draft is only %d words and needs more detail for this prompt; target at least %d words.", wordCount, minWords),
		})
	}

	dateIssues := reviewDateTense(sanitizedReply, referenceDate)
	issues = append(issues, dateIssues...)
	entityIssues := reviewEntityContradictions(sanitizedReply)
	issues = append(issues, entityIssues...)

	requiresRewrite := false
	for _, issue := range issues {
		switch issue.Code {
		case "empty-draft", "inline-source-attribution", "insufficient-detail", "date-tense-mismatch", "entity-contradiction", "entity-outcome-contradiction":
			requiresRewrite = true
		}
	}

	return Result{
		Approved:        !requiresRewrite,
		RequiresRewrite: requiresRewrite,
		SanitizedReply:  sanitizedReply,
		ReviewSummary: buildReviewSummary(
			referenceDate,
			removedMetaPhrasing,
			removedSourceList,
			wordCount,
			minWords,
			len(dateIssues),
			len(entityIssues),
			requiresRewrite,
		),
		RewritePrompt: buildRewritePrompt(request, referenceDate, minWords, allowSourceDiscussion, issues),
		Issues:        issues,
	}
}

func sanitizeReply(draft string, allowSourceDiscussion bool) (string, bool, bool) {
	cleaned := normalizeLineEndings(draft)
	removedMetaPhrasing := false
	removedSourceList := false

	for _, pattern := range leadingMetaPatterns {
		next := pattern.ReplaceAllString(cleaned, "")
		if next != cleaned {
			removedMetaPhrasing = true
			cleaned = next
		}
	}

	if !allowSourceDiscussion {
		next := trailingSourcesBlockPattern.ReplaceAllString(cleaned, "")
		if next != cleaned {
			removedSourceList = true
			cleaned = next
		}
	}

	cleaned = collapseBlankLinesPattern.ReplaceAllString(cleaned, "\n\n")
	cleaned = strings.TrimSpace(cleaned)
	return cleaned, removedMetaPhrasing, removedSourceList
}

func buildReviewSummary(
	referenceDate time.Time,
	removedMetaPhrasing bool,
	removedSourceList bool,
	wordCount int,
	minWords int,
	dateIssueCount int,
	entityIssueCount int,
	requiresRewrite bool,
) string {
	parts := make([]string, 0, 5)
	if removedMetaPhrasing {
		parts = append(parts, "Removed source or context lead-in phrasing.")
	}
	if removedSourceList {
		parts = append(parts, "Removed a trailing sources list.")
	}
	if wordCount < minWords {
		parts = append(parts, fmt.Sprintf("Flagged the draft as too short for the prompt (%d words vs. %d target).", wordCount, minWords))
	}
	if dateIssueCount > 0 {
		label := "sentence"
		if dateIssueCount != 1 {
			label = "sentences"
		}
		parts = append(parts, fmt.Sprintf("Flagged %d dated %s that conflict with the runtime date %s.", dateIssueCount, label, referenceDate.Format("January 2, 2006")))
	}
	if entityIssueCount > 0 {
		label := "entity contradiction"
		if entityIssueCount != 1 {
			label = "entity contradictions"
		}
		parts = append(parts, fmt.Sprintf("Flagged %d %s in person-specific claims.", entityIssueCount, label))
	}
	if len(parts) == 0 {
		return fmt.Sprintf("Reviewed the draft for directness, detail, and dated-term consistency against %s.", referenceDate.Format("January 2, 2006"))
	}
	if requiresRewrite {
		parts = append(parts, "A rewrite pass is required before the reply is shown.")
	}
	return strings.Join(parts, " ")
}

func buildRewritePrompt(
	request Request,
	referenceDate time.Time,
	minWords int,
	allowSourceDiscussion bool,
	issues []Issue,
) string {
	if len(issues) == 0 {
		return ""
	}

	lines := []string{
		"Revise your previous answer and return only the rewritten final reply.",
		"Answer the user directly.",
		"Do not mention the retrieval process, the provided context, or phrases like \"based on the sources provided\" or \"from the context above.\"",
	}

	if !allowSourceDiscussion {
		lines = append(lines, "Do not include a Sources, References, or Links section unless the user explicitly asked for it.")
	}

	for _, issue := range issues {
		switch issue.Code {
		case "inline-source-attribution":
			lines = append(lines, "Remove inline source callouts and keep the wording focused on the answer itself.")
		case "insufficient-detail":
			lines = append(lines, fmt.Sprintf("Add enough concrete detail, nuance, and implications to satisfy the prompt. Target at least %d words without adding filler.", minWords))
		case "date-tense-mismatch":
			lines = append(lines, fmt.Sprintf("Check every dated sentence against the runtime date %s and fix any past-or-future tense mismatch.", referenceDate.Format("January 2, 2006")))
		case "entity-contradiction", "entity-outcome-contradiction":
			lines = append(lines, "Resolve contradictory person-specific claims. Do not say someone was tried, convicted, executed, or otherwise involved if the same answer also says they were absent, dead before the proceeding, or died by suicide before that outcome.")
		}
	}

	lines = append(lines, "Keep the chronology consistent and the prose natural.")
	return strings.Join(lines, "\n")
}

func reviewDateTense(reply string, referenceDate time.Time) []Issue {
	referenceDay := truncateToDay(referenceDate)
	issues := make([]Issue, 0, 2)

	for _, sentence := range splitSentences(reply) {
		for _, match := range extractDateMatches(sentence) {
			contextStart := match.Start - 40
			if contextStart < 0 {
				contextStart = 0
			}
			contextEnd := match.End + 40
			if contextEnd > len(sentence) {
				contextEnd = len(sentence)
			}
			contextWindow := strings.ToLower(sentence[contextStart:contextEnd])
			matchDay := truncateToDay(match.When)

			if matchDay.Before(referenceDay) && containsAny(contextWindow, futureTenseMarkers) {
				issues = append(issues, Issue{
					Code:     "date-tense-mismatch",
					Severity: "warning",
					Message:  fmt.Sprintf("A past date is still being described as upcoming or scheduled around %s.", match.Raw),
					Evidence: strings.TrimSpace(sentence),
				})
				continue
			}
			if matchDay.After(referenceDay) && containsAny(contextWindow, pastTenseMarkers) {
				issues = append(issues, Issue{
					Code:     "date-tense-mismatch",
					Severity: "warning",
					Message:  fmt.Sprintf("A future date is being described as if it already happened around %s.", match.Raw),
					Evidence: strings.TrimSpace(sentence),
				})
			}
		}
	}

	return issues
}

type entityClaimState struct {
	positiveParticipationSentence string
	negativeParticipationSentence string
	executionSentence             string
	suicideSentence               string
}

func reviewEntityContradictions(reply string) []Issue {
	states := make(map[string]*entityClaimState)

	for _, sentence := range splitSentences(reply) {
		names := extractPersonNames(sentence)
		if len(names) == 0 {
			continue
		}

		hasPositiveParticipation := positiveParticipationPattern.MatchString(sentence)
		hasNegativeParticipation := negativeParticipationPattern.MatchString(sentence)
		hasExecutionOutcome := executionOutcomePattern.MatchString(sentence)
		hasSuicideOutcome := suicideOutcomePattern.MatchString(sentence)

		if !hasPositiveParticipation && !hasNegativeParticipation && !hasExecutionOutcome && !hasSuicideOutcome {
			continue
		}

		for _, name := range names {
			state := states[name]
			if state == nil {
				state = &entityClaimState{}
				states[name] = state
			}
			if hasPositiveParticipation && state.positiveParticipationSentence == "" {
				state.positiveParticipationSentence = sentence
			}
			if hasNegativeParticipation && state.negativeParticipationSentence == "" {
				state.negativeParticipationSentence = sentence
			}
			if hasExecutionOutcome && state.executionSentence == "" {
				state.executionSentence = sentence
			}
			if hasSuicideOutcome && state.suicideSentence == "" {
				state.suicideSentence = sentence
			}
		}
	}

	issues := make([]Issue, 0, 2)
	for name, state := range states {
		if state.positiveParticipationSentence != "" && state.negativeParticipationSentence != "" {
			issues = append(issues, Issue{
				Code:     "entity-contradiction",
				Severity: "warning",
				Message:  fmt.Sprintf("The draft makes contradictory claims about whether %s was tried or could have been tried.", name),
				Evidence: strings.TrimSpace(state.positiveParticipationSentence + " " + state.negativeParticipationSentence),
			})
		}
		if state.executionSentence != "" && state.suicideSentence != "" {
			issues = append(issues, Issue{
				Code:     "entity-outcome-contradiction",
				Severity: "warning",
				Message:  fmt.Sprintf("The draft makes contradictory outcome claims about %s.", name),
				Evidence: strings.TrimSpace(state.executionSentence + " " + state.suicideSentence),
			})
		}
	}

	return issues
}

func extractPersonNames(sentence string) []string {
	matches := personNamePattern.FindAllStringSubmatch(sentence, -1)
	if len(matches) == 0 {
		return nil
	}

	seen := make(map[string]struct{})
	names := make([]string, 0, len(matches))
	for _, match := range matches {
		if len(match) < 2 {
			continue
		}
		name := strings.TrimSpace(match[1])
		if name == "" {
			continue
		}
		key := strings.ToLower(name)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		names = append(names, name)
	}

	return names
}

func extractDateMatches(sentence string) []datedMatch {
	matches := make([]datedMatch, 0, 4)

	for _, index := range isoDatePattern.FindAllStringIndex(sentence, -1) {
		raw := sentence[index[0]:index[1]]
		when, err := time.Parse("2006-01-02", raw)
		if err != nil {
			continue
		}
		matches = append(matches, datedMatch{Raw: raw, Start: index[0], End: index[1], When: when})
	}

	for _, index := range monthDatePattern.FindAllStringIndex(sentence, -1) {
		raw := sentence[index[0]:index[1]]
		when, err := parseMonthDate(raw)
		if err != nil {
			continue
		}
		matches = append(matches, datedMatch{Raw: raw, Start: index[0], End: index[1], When: when})
	}

	return matches
}

func parseMonthDate(value string) (time.Time, error) {
	layouts := []string{
		"January 2, 2006",
		"Jan 2, 2006",
	}
	for _, layout := range layouts {
		when, err := time.Parse(layout, value)
		if err == nil {
			return when, nil
		}
	}
	return time.Time{}, fmt.Errorf("unsupported month date: %q", value)
}

func splitSentences(text string) []string {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return nil
	}

	sentences := make([]string, 0, 8)
	var builder strings.Builder
	for _, r := range trimmed {
		builder.WriteRune(r)
		switch r {
		case '.', '!', '?', '\n':
			sentence := strings.TrimSpace(builder.String())
			if sentence != "" {
				sentences = append(sentences, sentence)
			}
			builder.Reset()
		}
	}

	if leftover := strings.TrimSpace(builder.String()); leftover != "" {
		sentences = append(sentences, leftover)
	}

	return sentences
}

func minimumWordCount(prompt string, verifiedSourceCount int) int {
	if shortPromptPattern.MatchString(prompt) {
		return 40
	}
	if detailPromptPattern.MatchString(prompt) {
		return 120
	}
	if verifiedSourceCount >= 8 {
		return 90
	}
	if len(strings.Fields(prompt)) >= 18 {
		return 80
	}
	return 60
}

func countWords(text string) int {
	return len(strings.Fields(text))
}

func parseReferenceDate(value string) time.Time {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return truncateToDay(time.Now().UTC())
	}

	layouts := []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02",
	}
	for _, layout := range layouts {
		when, err := time.Parse(layout, trimmed)
		if err == nil {
			return truncateToDay(when)
		}
	}

	return truncateToDay(time.Now().UTC())
}

func truncateToDay(value time.Time) time.Time {
	year, month, day := value.UTC().Date()
	return time.Date(year, month, day, 0, 0, 0, 0, time.UTC)
}

func normalizeLineEndings(value string) string {
	return strings.ReplaceAll(value, "\r\n", "\n")
}

func containsAny(text string, patterns []string) bool {
	for _, pattern := range patterns {
		if strings.Contains(text, pattern) {
			return true
		}
	}
	return false
}
