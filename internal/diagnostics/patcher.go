package diagnostics

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.yaml.in/yaml/v3"
)

var validExtractModes = map[string]bool{
	"text":                  true,
	"full_text":             true,
	"rendered_text":         true,
	"attribute":             true,
	"list":                  true,
	"sibling_text":          true,
	"hourly_or_fixed_label": true,
	"ca_item_value":         true,
}

var patchMu sync.Mutex

// FieldRulePatch describes a proposed update to a view field rule in selectors YAML.
type FieldRulePatch struct {
	View            string   `json:"view"`
	Field           string   `json:"field"`
	Selectors       []string `json:"selectors"`
	Extract         string   `json:"extract,omitempty"`
	Attribute       string   `json:"attribute,omitempty"`
	Transforms      []string `json:"transforms,omitempty"`
	SiblingChildTag string   `json:"sibling_child_tag,omitempty"`
	JoinWith        string   `json:"join_with,omitempty"`
	LabelContains   string   `json:"label_contains,omitempty"`
	Required        *bool    `json:"required,omitempty"`
	IsFragile       *bool    `json:"is_fragile,omitempty"`
	FragileReason   *string  `json:"fragile_reason,omitempty"`
	AuthOnly        *bool    `json:"auth_only,omitempty"`
	Description     string   `json:"description,omitempty"`
	Mode            string   `json:"mode,omitempty"`   // "prepend" (default) | "replace"
	Reason          string   `json:"reason,omitempty"` // Audit note
}

// PatchPreview contains the validated updated YAML bytes and unified diff.
type PatchPreview struct {
	OldVersion string `json:"old_version"`
	NewVersion string `json:"new_version"`
	View       string `json:"view"`
	Field      string `json:"field"`
	Diff       string `json:"diff"`
	NewYAML    []byte `json:"-"`
}

// PatchApplyResult summarizes an applied selector YAML patch.
type PatchApplyResult struct {
	OldVersion string `json:"old_version"`
	NewVersion string `json:"new_version"`
	View       string `json:"view"`
	Field      string `json:"field"`
	BackupPath string `json:"backup_path"`
	BackupFile string `json:"backup_file"`
	Diff       string `json:"diff"`
}

// PatchRollbackResult summarizes a YAML selector rollback.
type PatchRollbackResult struct {
	RestoredFrom string `json:"restored_from"`
	BackupFile   string `json:"backup_file"`
	Version      string `json:"version"`
}

type selectorConfigValidation struct {
	Version string `yaml:"version"`
	Site    string `yaml:"site"`
	BaseURL string `yaml:"base_url"`
	Views   map[string]struct {
		ContainerSelectors []string `yaml:"container_selectors,omitempty"`
		Fields             map[string]struct {
			Selectors []string `yaml:"selectors"`
			Extract   string   `yaml:"extract"`
		} `yaml:"fields"`
	} `yaml:"views"`
}

func bumpPatchVersion(version string) string {
	trimmed := strings.TrimSpace(version)
	if trimmed == "" {
		return "2.0.1"
	}
	parts := strings.Split(trimmed, ".")
	switch len(parts) {
	case 1:
		return trimmed + ".0.1"
	case 2:
		return trimmed + ".1"
	default:
		last := parts[len(parts)-1]
		n, err := strconv.Atoi(last)
		if err != nil {
			return trimmed + ".1"
		}
		parts[len(parts)-1] = strconv.Itoa(n + 1)
		return strings.Join(parts, ".")
	}
}

func validateBalancedSelectorDelims(sel string) error {
	var inQuote byte
	var escaped bool
	squareDepth := 0
	parenDepth := 0
	for i := 0; i < len(sel); i++ {
		ch := sel[i]
		if escaped {
			escaped = false
			continue
		}
		if ch == '\\' {
			escaped = true
			continue
		}
		if inQuote != 0 {
			if ch == inQuote {
				inQuote = 0
			}
			continue
		}
		switch ch {
		case '\'', '"':
			inQuote = ch
		case '[':
			squareDepth++
		case ']':
			squareDepth--
			if squareDepth < 0 {
				return errors.New("unbalanced ']'")
			}
		case '(':
			parenDepth++
		case ')':
			parenDepth--
			if parenDepth < 0 {
				return errors.New("unbalanced ')'")
			}
		}
	}
	if inQuote != 0 {
		return errors.New("unterminated string quote")
	}
	if squareDepth != 0 {
		return errors.New("unbalanced '['")
	}
	if parenDepth != 0 {
		return errors.New("unbalanced '('")
	}
	return nil
}

func normalizePatchSelectors(raw []string) ([]string, error) {
	seen := make(map[string]bool, len(raw))
	out := make([]string, 0, len(raw))
	for _, s := range raw {
		trimmed := strings.TrimSpace(s)
		if trimmed == "" {
			continue
		}
		if strings.Contains(trimmed, ":contains(") {
			return nil, fmt.Errorf("invalid selector %q: non-standard :contains() is forbidden", trimmed)
		}
		if err := validateBalancedSelectorDelims(trimmed); err != nil {
			return nil, fmt.Errorf("invalid selector %q: %w", trimmed, err)
		}
		if !seen[trimmed] {
			seen[trimmed] = true
			out = append(out, trimmed)
		}
	}
	if len(out) == 0 {
		return nil, errors.New("at least one non-empty selector is required")
	}
	return out, nil
}

func findMapValue(mapNode *yaml.Node, key string) (*yaml.Node, *yaml.Node, bool) {
	if mapNode == nil || mapNode.Kind != yaml.MappingNode {
		return nil, nil, false
	}
	for i := 0; i+1 < len(mapNode.Content); i += 2 {
		if mapNode.Content[i].Value == key {
			return mapNode.Content[i], mapNode.Content[i+1], true
		}
	}
	return nil, nil, false
}

func ensureMapChild(mapNode *yaml.Node, key string, kind yaml.Kind) *yaml.Node {
	if _, val, ok := findMapValue(mapNode, key); ok {
		return val
	}
	kNode := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}
	vNode := &yaml.Node{Kind: kind}
	mapNode.Content = append(mapNode.Content, kNode, vNode)
	return vNode
}

func setScalarString(mapNode *yaml.Node, key, value string) {
	if _, val, ok := findMapValue(mapNode, key); ok {
		val.Kind = yaml.ScalarNode
		val.Tag = "!!str"
		val.Value = value
		val.Style = yaml.DoubleQuotedStyle
		return
	}
	kNode := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}
	vNode := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: value, Style: yaml.DoubleQuotedStyle}
	mapNode.Content = append(mapNode.Content, kNode, vNode)
}

func setScalarBool(mapNode *yaml.Node, key string, value bool) {
	strVal := "false"
	if value {
		strVal = "true"
	}
	if _, val, ok := findMapValue(mapNode, key); ok {
		val.Kind = yaml.ScalarNode
		val.Tag = "!!bool"
		val.Value = strVal
		val.Style = 0
		return
	}
	kNode := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}
	vNode := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!bool", Value: strVal}
	mapNode.Content = append(mapNode.Content, kNode, vNode)
}

func deleteMapKey(mapNode *yaml.Node, key string) {
	if mapNode == nil || mapNode.Kind != yaml.MappingNode {
		return
	}
	for i := 0; i+1 < len(mapNode.Content); i += 2 {
		if mapNode.Content[i].Value == key {
			mapNode.Content = append(mapNode.Content[:i], mapNode.Content[i+2:]...)
			return
		}
	}
}

func setStringSeq(mapNode *yaml.Node, key string, items []string) {
	seq := &yaml.Node{Kind: yaml.SequenceNode}
	for _, item := range items {
		seq.Content = append(seq.Content, &yaml.Node{
			Kind:  yaml.ScalarNode,
			Tag:   "!!str",
			Value: item,
			Style: yaml.DoubleQuotedStyle,
		})
	}
	if _, val, ok := findMapValue(mapNode, key); ok {
		*val = *seq
		return
	}
	kNode := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}
	mapNode.Content = append(mapNode.Content, kNode, seq)
}

func readStringSeq(mapNode *yaml.Node, key string) []string {
	_, val, ok := findMapValue(mapNode, key)
	if !ok || val.Kind != yaml.SequenceNode {
		return nil
	}
	out := make([]string, 0, len(val.Content))
	for _, item := range val.Content {
		if t := strings.TrimSpace(item.Value); t != "" {
			out = append(out, t)
		}
	}
	return out
}

func defaultExtractForField(field string) string {
	switch field {
	case "skills", "client_activity", "screening_questions", "attachments", "qualifications":
		return "list"
	default:
		return "full_text"
	}
}

// PreviewPatch parses yamlPath as an AST, applies req in memory preserving comments, validates, and returns a unified diff.
func PreviewPatch(yamlPath string, req FieldRulePatch) (*PatchPreview, error) {
	view := strings.TrimSpace(req.View)
	field := strings.TrimSpace(req.Field)
	if view == "" || field == "" {
		return nil, errors.New("view and field are required")
	}

	cleanedSelectors, err := normalizePatchSelectors(req.Selectors)
	if err != nil {
		return nil, err
	}

	mode := strings.ToLower(strings.TrimSpace(req.Mode))
	if mode == "" {
		mode = "prepend"
	}
	if mode != "prepend" && mode != "replace" {
		return nil, fmt.Errorf("invalid mode %q (expected 'prepend' or 'replace')", req.Mode)
	}

	raw, err := os.ReadFile(yamlPath)
	if err != nil {
		return nil, fmt.Errorf("read selectors YAML: %w", err)
	}

	var doc yaml.Node
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("parse selectors YAML: %w", err)
	}
	if len(doc.Content) == 0 || doc.Content[0].Kind != yaml.MappingNode {
		return nil, errors.New("selectors YAML root must be a mapping")
	}
	rootMap := doc.Content[0]

	oldVersion := ""
	if _, verNode, ok := findMapValue(rootMap, "version"); ok {
		oldVersion = strings.TrimSpace(verNode.Value)
	}
	newVersion := bumpPatchVersion(oldVersion)
	setScalarString(rootMap, "version", newVersion)

	viewsMap := ensureMapChild(rootMap, "views", yaml.MappingNode)
	viewNode := ensureMapChild(viewsMap, view, yaml.MappingNode)

	if field == "container_selectors" || field == "job_cards_container" || field == "items_container" {
		existing := readStringSeq(viewNode, "container_selectors")
		finalSelectors := cleanedSelectors
		if mode == "prepend" {
			finalSelectors, err = normalizePatchSelectors(append(append([]string{}, cleanedSelectors...), existing...))
			if err != nil {
				return nil, err
			}
		}
		setStringSeq(viewNode, "container_selectors", finalSelectors)
	} else {
		fieldsMap := ensureMapChild(viewNode, "fields", yaml.MappingNode)
		fieldNode := ensureMapChild(fieldsMap, field, yaml.MappingNode)

		existingSelectors := readStringSeq(fieldNode, "selectors")
		finalSelectors := cleanedSelectors
		if mode == "prepend" && len(existingSelectors) > 0 {
			finalSelectors, err = normalizePatchSelectors(append(append([]string{}, cleanedSelectors...), existingSelectors...))
			if err != nil {
				return nil, err
			}
		}
		setStringSeq(fieldNode, "selectors", finalSelectors)

		extractMode := strings.TrimSpace(req.Extract)
		if extractMode == "" {
			if _, existingExt, ok := findMapValue(fieldNode, "extract"); ok && strings.TrimSpace(existingExt.Value) != "" {
				extractMode = strings.TrimSpace(existingExt.Value)
			} else {
				extractMode = defaultExtractForField(field)
			}
		}
		if !validExtractModes[extractMode] {
			return nil, fmt.Errorf("unsupported extract mode %q", extractMode)
		}
		setScalarString(fieldNode, "extract", extractMode)

		if strings.TrimSpace(req.Attribute) != "" {
			setScalarString(fieldNode, "attribute", strings.TrimSpace(req.Attribute))
		}
		if len(req.Transforms) > 0 {
			setStringSeq(fieldNode, "transforms", req.Transforms)
		}
		if strings.TrimSpace(req.SiblingChildTag) != "" {
			setScalarString(fieldNode, "sibling_child_tag", strings.TrimSpace(req.SiblingChildTag))
		}
		if strings.TrimSpace(req.JoinWith) != "" {
			setScalarString(fieldNode, "join_with", req.JoinWith)
		}
		if strings.TrimSpace(req.LabelContains) != "" {
			setScalarString(fieldNode, "label_contains", req.LabelContains)
		}
		if req.Required != nil {
			setScalarBool(fieldNode, "required", *req.Required)
		}
		if req.IsFragile != nil {
			if !*req.IsFragile {
				deleteMapKey(fieldNode, "is_fragile")
				deleteMapKey(fieldNode, "fragile_reason")
			} else {
				setScalarBool(fieldNode, "is_fragile", true)
			}
		} else if len(finalSelectors) > 0 && !strings.Contains(finalSelectors[0], "data-v-") {
			// Clear stale fragility flag once patched with a stable non-hash primary selector
			if _, fragNode, ok := findMapValue(fieldNode, "is_fragile"); ok && strings.EqualFold(fragNode.Value, "true") {
				deleteMapKey(fieldNode, "is_fragile")
				deleteMapKey(fieldNode, "fragile_reason")
			}
		}
		if req.FragileReason != nil && strings.TrimSpace(*req.FragileReason) != "" {
			setScalarString(fieldNode, "fragile_reason", strings.TrimSpace(*req.FragileReason))
		}
		if req.AuthOnly != nil {
			setScalarBool(fieldNode, "auth_only", *req.AuthOnly)
		}
		if strings.TrimSpace(req.Description) != "" {
			setScalarString(fieldNode, "description", strings.TrimSpace(req.Description))
		}
	}

	var outBuf bytes.Buffer
	enc := yaml.NewEncoder(&outBuf)
	enc.SetIndent(2)
	if err := enc.Encode(&doc); err != nil {
		return nil, fmt.Errorf("encode patched YAML: %w", err)
	}
	if err := enc.Close(); err != nil {
		return nil, fmt.Errorf("close YAML encoder: %w", err)
	}
	newYAML := outBuf.Bytes()

	// Strict validation of generated YAML
	var validated selectorConfigValidation
	if err := yaml.Unmarshal(newYAML, &validated); err != nil {
		return nil, fmt.Errorf("validate patched YAML: %w", err)
	}
	if validated.Views[view].Fields == nil && field != "container_selectors" {
		return nil, fmt.Errorf("patched YAML validation failed: view %q has no fields", view)
	}
	for vName, vCfg := range validated.Views {
		for fName, fRule := range vCfg.Fields {
			if len(fRule.Selectors) == 0 {
				return nil, fmt.Errorf("patched YAML validation failed: %s.%s has empty selectors", vName, fName)
			}
			if !validExtractModes[fRule.Extract] {
				return nil, fmt.Errorf("patched YAML validation failed: %s.%s has invalid extract %q", vName, fName, fRule.Extract)
			}
		}
	}

	diff := unifiedLineDiff(string(raw), string(newYAML), yamlPath)
	return &PatchPreview{
		OldVersion: oldVersion,
		NewVersion: newVersion,
		View:       view,
		Field:      field,
		Diff:       diff,
		NewYAML:    newYAML,
	}, nil
}

// DefaultBackupDir resolves the selector backup directory adjacent to yamlPath.
func DefaultBackupDir(yamlPath string) string {
	return filepath.Join(filepath.Dir(yamlPath), ".backups")
}

// ApplyPatch backs up yamlPath into backupDir and atomically writes the validated patched YAML.
func ApplyPatch(yamlPath, backupDir string, req FieldRulePatch) (*PatchApplyResult, error) {
	patchMu.Lock()
	defer patchMu.Unlock()

	if strings.TrimSpace(backupDir) == "" {
		backupDir = DefaultBackupDir(yamlPath)
	}
	preview, err := PreviewPatch(yamlPath, req)
	if err != nil {
		return nil, err
	}

	origRaw, err := os.ReadFile(yamlPath)
	if err != nil {
		return nil, fmt.Errorf("read original YAML for backup: %w", err)
	}

	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		return nil, fmt.Errorf("create backup dir: %w", err)
	}

	backupFile := fmt.Sprintf("upwork.%s.%s.yaml", time.Now().UTC().Format("20060102-150405"), randomHex4())
	backupPath := filepath.Join(backupDir, backupFile)
	if err := os.WriteFile(backupPath, origRaw, 0o600); err != nil {
		return nil, fmt.Errorf("write backup file: %w", err)
	}

	if err := atomicWriteFile(yamlPath, preview.NewYAML, 0o644); err != nil {
		return nil, fmt.Errorf("write patched YAML: %w", err)
	}

	return &PatchApplyResult{
		OldVersion: preview.OldVersion,
		NewVersion: preview.NewVersion,
		View:       preview.View,
		Field:      preview.Field,
		BackupPath: backupPath,
		BackupFile: backupFile,
		Diff:       preview.Diff,
	}, nil
}

// RollbackLatest restores backupFile (or the most recent .yaml backup in backupDir) atomically onto yamlPath.
func RollbackLatest(yamlPath, backupDir, backupFile string) (*PatchRollbackResult, error) {
	patchMu.Lock()
	defer patchMu.Unlock()

	if strings.TrimSpace(backupDir) == "" {
		backupDir = DefaultBackupDir(yamlPath)
	}

	var targetPath string
	var chosenName string
	trimmedFile := strings.TrimSpace(backupFile)
	if trimmedFile != "" {
		base := filepath.Base(trimmedFile)
		if base != trimmedFile || strings.Contains(base, "..") || !strings.HasSuffix(base, ".yaml") {
			return nil, errors.New("invalid backup_file name")
		}
		targetPath = filepath.Join(backupDir, base)
		chosenName = base
	} else {
		entries, err := os.ReadDir(backupDir)
		if err != nil {
			return nil, fmt.Errorf("read backup dir: %w", err)
		}
		type backupInfo struct {
			name    string
			path    string
			modTime time.Time
		}
		var backups []backupInfo
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".yaml") {
				continue
			}
			info, infoErr := entry.Info()
			if infoErr != nil {
				continue
			}
			backups = append(backups, backupInfo{
				name:    entry.Name(),
				path:    filepath.Join(backupDir, entry.Name()),
				modTime: info.ModTime(),
			})
		}
		if len(backups) == 0 {
			return nil, errors.New("no selector backups available to roll back")
		}
		sort.Slice(backups, func(i, j int) bool {
			if !backups[i].modTime.Equal(backups[j].modTime) {
				return backups[i].modTime.After(backups[j].modTime)
			}
			return backups[i].name > backups[j].name
		})
		targetPath = backups[0].path
		chosenName = backups[0].name
	}

	backupRaw, err := os.ReadFile(targetPath)
	if err != nil {
		return nil, fmt.Errorf("read backup file: %w", err)
	}

	var validated selectorConfigValidation
	if err := yaml.Unmarshal(backupRaw, &validated); err != nil {
		return nil, fmt.Errorf("backup YAML is invalid: %w", err)
	}

	if err := atomicWriteFile(yamlPath, backupRaw, 0o644); err != nil {
		return nil, fmt.Errorf("restore YAML from backup: %w", err)
	}

	return &PatchRollbackResult{
		RestoredFrom: targetPath,
		BackupFile:   chosenName,
		Version:      validated.Version,
	}, nil
}

func atomicWriteFile(targetPath string, content []byte, mode os.FileMode) error {
	dir := filepath.Dir(targetPath)
	tmp, err := os.CreateTemp(dir, ".upwork-selectors-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tmpPath)
		}
	}()

	if _, err := tmp.Write(content); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, targetPath); err != nil {
		return err
	}
	cleanup = false
	return nil
}

func unifiedLineDiff(oldStr, newStr, fileLabel string) string {
	oldLines := strings.Split(strings.TrimRight(oldStr, "\n"), "\n")
	newLines := strings.Split(strings.TrimRight(newStr, "\n"), "\n")

	// LCS matrix for concise readable diff
	n, m := len(oldLines), len(newLines)
	dp := make([][]int, n+1)
	for i := range dp {
		dp[i] = make([]int, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if oldLines[i] == newLines[j] {
				dp[i][j] = dp[i+1][j+1] + 1
			} else if dp[i+1][j] >= dp[i][j+1] {
				dp[i][j] = dp[i+1][j]
			} else {
				dp[i][j] = dp[i][j+1]
			}
		}
	}

	type diffLine struct {
		op   byte
		text string
	}
	var all []diffLine
	i, j := 0, 0
	for i < n && j < m {
		if oldLines[i] == newLines[j] {
			all = append(all, diffLine{' ', oldLines[i]})
			i++
			j++
		} else if dp[i+1][j] >= dp[i][j+1] {
			all = append(all, diffLine{'-', oldLines[i]})
			i++
		} else {
			all = append(all, diffLine{'+', newLines[j]})
			j++
		}
	}
	for i < n {
		all = append(all, diffLine{'-', oldLines[i]})
		i++
	}
	for j < m {
		all = append(all, diffLine{'+', newLines[j]})
		j++
	}

	var out strings.Builder
	fmt.Fprintf(&out, "--- %s\n+++ %s\n", fileLabel, fileLabel)
	hasChanges := false
	for idx, dl := range all {
		if dl.op != ' ' {
			hasChanges = true
			// Include up to 2 context lines around changed blocks cleanly
			_ = idx
		}
	}
	if !hasChanges {
		return ""
	}
	for idx, dl := range all {
		if dl.op != ' ' {
			fmt.Fprintf(&out, "%c%s\n", dl.op, dl.text)
			continue
		}
		nearChange := false
		for d := -2; d <= 2; d++ {
			k := idx + d
			if k >= 0 && k < len(all) && all[k].op != ' ' {
				nearChange = true
				break
			}
		}
		if nearChange {
			fmt.Fprintf(&out, " %s\n", dl.text)
		}
	}
	return out.String()
}
