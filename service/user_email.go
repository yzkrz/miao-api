package service

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"golang.org/x/net/html"
)

var ErrUserEmailInvalid = errors.New("Enter a subject and message. Images must be PNG, JPEG, GIF or WebP, with at most 5 images and 5 MB total.")
var emailImageCID = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)

type UserEmailDraft struct {
	Subject string                    `json:"subject"`
	HTML    string                    `json:"html"`
	Images  []common.InlineEmailImage `json:"images"`
}

// Bind the full draft, including inline image bytes, to one verification.
func (draft UserEmailDraft) Digest() string {
	var body strings.Builder
	body.WriteString(draft.Subject + "\x00" + draft.HTML)
	for _, image := range draft.Images {
		body.WriteString("\x00" + image.CID + "\x00" + image.ContentType + "\x00" + image.Content)
	}
	digest := sha256.Sum256([]byte(body.String()))
	return hex.EncodeToString(digest[:])
}

// PrepareUserEmail allowlists formatting and URLs. It never fetches external
// images; uploads are embedded as CID attachments, not public server files.
func PrepareUserEmail(draft UserEmailDraft) (string, []common.InlineEmailImage, error) {
	if strings.TrimSpace(draft.Subject) == "" || utf8.RuneCountInString(draft.Subject) > 200 || strings.ContainsAny(draft.Subject, "\r\n\x00") || strings.ContainsRune(draft.HTML, '\x00') || len(draft.HTML) > 200000 || len(draft.Images) > 5 {
		return "", nil, ErrUserEmailInvalid
	}
	images := make([]common.InlineEmailImage, 0, len(draft.Images))
	cids := map[string]bool{}
	total := 0
	for _, image := range draft.Images {
		if !emailImageCID.MatchString(image.CID) || cids[image.CID] {
			return "", nil, ErrUserEmailInvalid
		}
		data, err := base64.StdEncoding.DecodeString(image.Content)
		total += len(data)
		if err != nil || len(data) == 0 || total > 5*1024*1024 {
			return "", nil, ErrUserEmailInvalid
		}
		detected := http.DetectContentType(data)
		extension := map[string]string{"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp"}[detected]
		if extension == "" || detected != image.ContentType {
			return "", nil, ErrUserEmailInvalid
		}
		image.Name = image.CID + "." + extension
		images = append(images, image)
		cids[image.CID] = true
	}
	tree, err := html.Parse(strings.NewReader(draft.HTML))
	if err != nil {
		return "", nil, ErrUserEmailInvalid
	}
	allowed := map[string]bool{"p": true, "div": true, "span": true, "br": true, "b": true, "strong": true, "i": true, "em": true, "u": true, "s": true, "h1": true, "h2": true, "h3": true, "blockquote": true, "ul": true, "ol": true, "li": true, "a": true, "img": true, "table": true, "tbody": true, "tr": true, "td": true, "th": true, "hr": true, "pre": true, "code": true}
	clean := &html.Node{Type: html.ElementNode, Data: "div"}
	var text strings.Builder
	hasImage := false
	var visit func(*html.Node, *html.Node)
	visit = func(node, parent *html.Node) {
		if node.Type == html.TextNode {
			text.WriteString(node.Data)
			parent.AppendChild(&html.Node{Type: html.TextNode, Data: node.Data})
			return
		}
		if node.Type == html.ElementNode && (node.Data == "script" || node.Data == "style" || node.Data == "iframe" || node.Data == "object" || node.Data == "svg" || node.Data == "head") {
			return
		}
		destination := parent
		if node.Type == html.ElementNode && allowed[node.Data] {
			copy := &html.Node{Type: html.ElementNode, Data: node.Data}
			for _, attr := range node.Attr {
				if attr.Namespace != "" {
					continue
				}
				switch attr.Key {
				case "href", "src":
					value := strings.TrimSpace(attr.Val)
					parsed, err := url.Parse(value)
					safe := err == nil && (parsed.Scheme == "https" || parsed.Scheme == "http") && parsed.Host != "" && parsed.User == nil
					if node.Data == "a" && attr.Key == "href" && err == nil && parsed.Scheme == "mailto" {
						safe = true
					}
					if node.Data == "img" && attr.Key == "src" && strings.HasPrefix(value, "cid:") && cids[strings.TrimPrefix(value, "cid:")] {
						safe = true
					}
					if safe && ((node.Data == "a" && attr.Key == "href") || (node.Data == "img" && attr.Key == "src")) {
						copy.Attr = append(copy.Attr, html.Attribute{Key: attr.Key, Val: value})
						if node.Data == "img" {
							hasImage = true
						}
					}
				case "alt", "title":
					copy.Attr = append(copy.Attr, html.Attribute{Key: attr.Key, Val: attr.Val})
				case "style":
					for declaration := range strings.SplitSeq(attr.Val, ";") {
						key, value, ok := strings.Cut(declaration, ":")
						key, value = strings.TrimSpace(key), strings.TrimSpace(value)
						if ok && key == "text-align" && (value == "left" || value == "center" || value == "right" || value == "justify") {
							copy.Attr = append(copy.Attr, html.Attribute{Key: "style", Val: fmt.Sprintf("text-align:%s", value)})
						}
					}
				}
			}
			parent.AppendChild(copy)
			destination = copy
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			visit(child, destination)
		}
	}
	visit(tree, clean)
	if strings.TrimSpace(text.String()) == "" && !hasImage {
		return "", nil, ErrUserEmailInvalid
	}
	var content strings.Builder
	if err := html.Render(&content, clean); err != nil {
		return "", nil, err
	}
	return content.String(), images, nil
}
