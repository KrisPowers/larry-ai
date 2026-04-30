package searchengine

import (
	"bytes"
	"net/url"
	"slices"
	"strings"

	"golang.org/x/net/html"
)

const maxIndexedContentLength = 48_000

type parsedPage struct {
	Title   string
	Snippet string
	Text    string
	Links   []string
}

func parseHTMLDocument(body []byte, base *url.URL) (parsedPage, error) {
	doc, err := html.Parse(bytes.NewReader(body))
	if err != nil {
		return parsedPage{}, err
	}

	var textParts []string
	var links []string
	title := ""
	description := ""

	var walk func(node *html.Node)
	walk = func(node *html.Node) {
		if node == nil {
			return
		}

		if node.Type == html.ElementNode {
			switch strings.ToLower(node.Data) {
			case "script", "style", "noscript", "svg", "canvas", "iframe":
				return
			case "title":
				title = normalizeWhitespace(nodeText(node))
				return
			case "meta":
				if description == "" && strings.EqualFold(attributeValue(node, "name"), "description") {
					description = normalizeWhitespace(attributeValue(node, "content"))
				}
			case "a":
				href := strings.TrimSpace(attributeValue(node, "href"))
				if href != "" && base != nil {
					if resolved, err := base.Parse(href); err == nil {
						if normalized, _, err := canonicalizeURL(resolved.String()); err == nil {
							links = append(links, normalized)
						}
					}
				}
			}
		}

		if node.Type == html.TextNode {
			clean := normalizeWhitespace(node.Data)
			if clean != "" {
				textParts = append(textParts, clean)
			}
		}

		for child := node.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}

	walk(doc)

	text := truncate(normalizeWhitespace(strings.Join(textParts, " ")), maxIndexedContentLength)
	snippet := truncate(firstNonEmpty(description, text), 260)
	if title == "" && base != nil {
		title = base.Hostname()
	}

	return parsedPage{
		Title:   title,
		Snippet: snippet,
		Text:    text,
		Links:   slices.Compact(links),
	}, nil
}

func nodeText(node *html.Node) string {
	if node == nil {
		return ""
	}

	var parts []string
	var walk func(current *html.Node)
	walk = func(current *html.Node) {
		if current == nil {
			return
		}
		if current.Type == html.TextNode {
			clean := normalizeWhitespace(current.Data)
			if clean != "" {
				parts = append(parts, clean)
			}
		}
		for child := current.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}
	walk(node)
	return strings.Join(parts, " ")
}

func attributeValue(node *html.Node, key string) string {
	for _, attr := range node.Attr {
		if strings.EqualFold(attr.Key, key) {
			return attr.Val
		}
	}
	return ""
}
