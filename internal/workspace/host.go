package workspace

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	goruntime "runtime"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	maxIndexedFileSize = 256 * 1024
)

var ignoredDirectories = map[string]struct{}{
	".git":         {},
	".idea":        {},
	".next":        {},
	".turbo":       {},
	".vscode":      {},
	"build":        {},
	"coverage":     {},
	"dist":         {},
	"node_modules": {},
	"out":          {},
}

var ignoredExtensions = map[string]struct{}{
	".avi":   {},
	".bmp":   {},
	".dll":   {},
	".doc":   {},
	".docx":  {},
	".eot":   {},
	".exe":   {},
	".gif":   {},
	".gz":    {},
	".ico":   {},
	".jar":   {},
	".jpeg":  {},
	".jpg":   {},
	".lock":  {},
	".mov":   {},
	".mp3":   {},
	".mp4":   {},
	".pdf":   {},
	".png":   {},
	".pyc":   {},
	".so":    {},
	".svgz":  {},
	".tar":   {},
	".ttf":   {},
	".wasm":  {},
	".webm":  {},
	".webp":  {},
	".woff":  {},
	".woff2": {},
	".zip":   {},
}

type FileEntry struct {
	Path      string `json:"path"`
	Content   string `json:"content"`
	Lang      string `json:"lang"`
	UpdatedAt int    `json:"updatedAt"`
}

type FileNode struct {
	Name      string     `json:"name"`
	Path      string     `json:"path"`
	Kind      string     `json:"kind"`
	Extension string     `json:"extension,omitempty"`
	Children  []FileNode `json:"children,omitempty"`
}

type Snapshot struct {
	RootPath       string      `json:"rootPath"`
	FileTree       []FileNode  `json:"fileTree"`
	FileEntries    []FileEntry `json:"fileEntries"`
	FileCount      int         `json:"fileCount"`
	DirectoryCount int         `json:"directoryCount"`
	SyncedAt       int64       `json:"syncedAt"`
}

type Selection struct {
	Label    string   `json:"label"`
	RootPath string   `json:"rootPath"`
	Snapshot Snapshot `json:"snapshot"`
}

type Document struct {
	Path       string `json:"path"`
	Content    string `json:"content"`
	Lang       string `json:"lang"`
	SizeBytes  int64  `json:"sizeBytes"`
	ModifiedAt int64  `json:"modifiedAt"`
}

type BackupSummary struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	CreatedAt   int64  `json:"createdAt"`
	ArchivePath string `json:"archivePath"`
}

type RuntimeCommand struct {
	Kind    string `json:"kind"`
	Label   string `json:"label"`
	Command string `json:"command"`
}

type RuntimeProfile struct {
	Ecosystem     string           `json:"ecosystem"`
	Label         string           `json:"label"`
	DetectedFiles []string         `json:"detectedFiles"`
	Commands      []RuntimeCommand `json:"commands"`
}

type CommandResult struct {
	Command        string `json:"command"`
	ExitCode       int    `json:"exitCode"`
	Stdout         string `json:"stdout"`
	Stderr         string `json:"stderr"`
	CombinedOutput string `json:"combinedOutput"`
	DurationMs     int64  `json:"durationMs"`
	TimedOut       bool   `json:"timedOut"`
}

func PickDirectory(ctx context.Context) (Selection, error) {
	selectedPath, err := runtime.OpenDirectoryDialog(ctx, runtime.OpenDialogOptions{
		Title: "Select workspace folder",
	})
	if err != nil {
		return Selection{}, fmt.Errorf("open workspace directory dialog: %w", err)
	}
	if strings.TrimSpace(selectedPath) == "" {
		return Selection{}, nil
	}

	return BuildSelection(selectedPath)
}

func BuildSelection(rootPath string) (Selection, error) {
	snapshot, err := Scan(rootPath)
	if err != nil {
		return Selection{}, err
	}

	label := filepath.Base(snapshot.RootPath)
	if label == "." || label == string(filepath.Separator) || label == "" {
		label = "Workspace"
	}

	return Selection{
		Label:    label,
		RootPath: snapshot.RootPath,
		Snapshot: snapshot,
	}, nil
}

func CreateManagedWorkspace(label string) (Selection, error) {
	rootDir, err := managedWorkspaceRoot()
	if err != nil {
		return Selection{}, err
	}

	directoryName := sanitizeWorkspaceDirectoryName(label)
	targetPath, err := ensureWorkspaceDirectory(rootDir, directoryName)
	if err != nil {
		return Selection{}, err
	}

	return BuildSelection(targetPath)
}

func Scan(rootPath string) (Snapshot, error) {
	cleanRoot, err := normaliseRootPath(rootPath)
	if err != nil {
		return Snapshot{}, err
	}

	fileTree, fileEntries, fileCount, directoryCount, err := scanDirectory(cleanRoot, cleanRoot)
	if err != nil {
		return Snapshot{}, err
	}

	return Snapshot{
		RootPath:       cleanRoot,
		FileTree:       fileTree,
		FileEntries:    fileEntries,
		FileCount:      fileCount,
		DirectoryCount: directoryCount,
		SyncedAt:       time.Now().UnixMilli(),
	}, nil
}

func ReadFile(rootPath string, relativePath string) (Document, error) {
	targetPath, normalizedPath, err := resolveWorkspacePath(rootPath, relativePath)
	if err != nil {
		return Document{}, err
	}

	info, err := os.Stat(targetPath)
	if err != nil {
		return Document{}, fmt.Errorf("stat workspace file %q: %w", relativePath, err)
	}
	if info.IsDir() {
		return Document{}, fmt.Errorf("workspace path %q is a directory", relativePath)
	}

	content, err := os.ReadFile(targetPath)
	if err != nil {
		return Document{}, fmt.Errorf("read workspace file %q: %w", relativePath, err)
	}
	if bytes.Contains(content, []byte{0}) {
		return Document{}, errors.New("this file looks binary and cannot be opened in the workspace editor yet")
	}
	if !utf8.Valid(content) {
		return Document{}, errors.New("only UTF-8 text files can be opened in the workspace editor right now")
	}

	return Document{
		Path:       normalizedPath,
		Content:    string(content),
		Lang:       languageFromPath(normalizedPath),
		SizeBytes:  info.Size(),
		ModifiedAt: info.ModTime().UnixMilli(),
	}, nil
}

func CreateDirectory(rootPath string, relativePath string) (Snapshot, error) {
	targetPath, _, err := resolveWorkspacePath(rootPath, relativePath)
	if err != nil {
		return Snapshot{}, err
	}

	if err := os.MkdirAll(targetPath, 0o755); err != nil {
		return Snapshot{}, fmt.Errorf("create directory %q: %w", relativePath, err)
	}

	return Scan(rootPath)
}

func CreateFile(rootPath string, relativePath string, content string) (Snapshot, error) {
	targetPath, _, err := resolveWorkspacePath(rootPath, relativePath)
	if err != nil {
		return Snapshot{}, err
	}

	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		return Snapshot{}, fmt.Errorf("create file parent directory for %q: %w", relativePath, err)
	}

	if _, err := os.Stat(targetPath); err == nil {
		return Snapshot{}, fmt.Errorf("file %q already exists", relativePath)
	} else if !errors.Is(err, os.ErrNotExist) {
		return Snapshot{}, fmt.Errorf("check existing file %q: %w", relativePath, err)
	}

	if err := os.WriteFile(targetPath, []byte(content), 0o644); err != nil {
		return Snapshot{}, fmt.Errorf("write file %q: %w", relativePath, err)
	}

	return Scan(rootPath)
}

func WriteFile(rootPath string, relativePath string, content string) (Snapshot, error) {
	targetPath, _, err := resolveWorkspacePath(rootPath, relativePath)
	if err != nil {
		return Snapshot{}, err
	}

	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		return Snapshot{}, fmt.Errorf("create file parent directory for %q: %w", relativePath, err)
	}

	if err := os.WriteFile(targetPath, []byte(content), 0o644); err != nil {
		return Snapshot{}, fmt.Errorf("write file %q: %w", relativePath, err)
	}

	return Scan(rootPath)
}

func WriteFileDocument(rootPath string, relativePath string, content string) (Document, error) {
	targetPath, normalizedPath, err := resolveWorkspacePath(rootPath, relativePath)
	if err != nil {
		return Document{}, err
	}

	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		return Document{}, fmt.Errorf("create file parent directory for %q: %w", relativePath, err)
	}

	if err := os.WriteFile(targetPath, []byte(content), 0o644); err != nil {
		return Document{}, fmt.Errorf("write file %q: %w", relativePath, err)
	}

	return ReadFile(rootPath, normalizedPath)
}

func RenameEntry(rootPath string, relativePath string, nextRelativePath string) (Snapshot, error) {
	sourcePath, normalizedSourcePath, err := resolveWorkspacePath(rootPath, relativePath)
	if err != nil {
		return Snapshot{}, err
	}

	targetPath, normalizedTargetPath, err := resolveWorkspacePath(rootPath, nextRelativePath)
	if err != nil {
		return Snapshot{}, err
	}

	if normalizedSourcePath == normalizedTargetPath {
		return Scan(rootPath)
	}

	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		return Snapshot{}, fmt.Errorf("create parent directory for %q: %w", nextRelativePath, err)
	}

	if _, err := os.Stat(targetPath); err == nil {
		return Snapshot{}, fmt.Errorf("workspace entry %q already exists", normalizedTargetPath)
	} else if !errors.Is(err, os.ErrNotExist) {
		return Snapshot{}, fmt.Errorf("check destination %q: %w", nextRelativePath, err)
	}

	if err := os.Rename(sourcePath, targetPath); err != nil {
		return Snapshot{}, fmt.Errorf("rename workspace entry %q to %q: %w", normalizedSourcePath, normalizedTargetPath, err)
	}

	return Scan(rootPath)
}

func CopyEntry(rootPath string, relativePath string, nextRelativePath string) (Snapshot, error) {
	sourcePath, normalizedSourcePath, err := resolveWorkspacePath(rootPath, relativePath)
	if err != nil {
		return Snapshot{}, err
	}

	targetPath, normalizedTargetPath, err := resolveWorkspacePath(rootPath, nextRelativePath)
	if err != nil {
		return Snapshot{}, err
	}

	if normalizedSourcePath == normalizedTargetPath {
		return Snapshot{}, errors.New("copy destination must be different from the source path")
	}

	sourceInfo, err := os.Stat(sourcePath)
	if err != nil {
		return Snapshot{}, fmt.Errorf("stat workspace entry %q: %w", relativePath, err)
	}

	if _, err := os.Stat(targetPath); err == nil {
		return Snapshot{}, fmt.Errorf("workspace entry %q already exists", normalizedTargetPath)
	} else if !errors.Is(err, os.ErrNotExist) {
		return Snapshot{}, fmt.Errorf("check destination %q: %w", nextRelativePath, err)
	}

	if sourceInfo.IsDir() {
		if err := copyWorkspaceDirectory(sourcePath, targetPath); err != nil {
			return Snapshot{}, fmt.Errorf("copy workspace directory %q: %w", normalizedSourcePath, err)
		}
	} else {
		if err := copyWorkspaceFile(sourcePath, targetPath, sourceInfo.Mode()); err != nil {
			return Snapshot{}, fmt.Errorf("copy workspace file %q: %w", normalizedSourcePath, err)
		}
	}

	return Scan(rootPath)
}

func DeleteEntry(rootPath string, relativePath string) (Snapshot, error) {
	targetPath, normalizedPath, err := resolveWorkspacePath(rootPath, relativePath)
	if err != nil {
		return Snapshot{}, err
	}
	if normalizedPath == "" {
		return Snapshot{}, errors.New("refusing to delete the workspace root")
	}

	if err := os.RemoveAll(targetPath); err != nil {
		return Snapshot{}, fmt.Errorf("delete workspace entry %q: %w", relativePath, err)
	}

	return Scan(rootPath)
}

func OpenInExplorer(rootPath string) error {
	cleanRoot, err := normaliseRootPath(rootPath)
	if err != nil {
		return err
	}

	return openPath(cleanRoot)
}

func OpenEntry(rootPath string, relativePath string) error {
	targetPath, _, err := resolveWorkspacePath(rootPath, relativePath)
	if err != nil {
		return err
	}

	return openPath(targetPath)
}

func CreateBackup(rootPath string, workspaceID string, label string) (BackupSummary, error) {
	cleanRoot, err := normaliseRootPath(rootPath)
	if err != nil {
		return BackupSummary{}, err
	}

	if strings.TrimSpace(label) == "" {
		label = filepath.Base(cleanRoot)
	}

	backupRoot, err := workspaceBackupDirectory(workspaceID, label)
	if err != nil {
		return BackupSummary{}, err
	}
	if err := os.MkdirAll(backupRoot, 0o755); err != nil {
		return BackupSummary{}, fmt.Errorf("create workspace backup directory: %w", err)
	}

	createdAt := time.Now().UnixMilli()
	backupID := fmt.Sprintf("%d-%s", createdAt, sanitizeWorkspaceDirectoryName(label))
	archivePath := filepath.Join(backupRoot, fmt.Sprintf("%s.zip", backupID))

	archiveFile, err := os.Create(archivePath)
	if err != nil {
		return BackupSummary{}, fmt.Errorf("create workspace backup archive: %w", err)
	}
	defer archiveFile.Close()

	zipWriter := zip.NewWriter(archiveFile)
	defer zipWriter.Close()

	if err := filepath.WalkDir(cleanRoot, func(currentPath string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if currentPath == cleanRoot {
			return nil
		}

		if entry.IsDir() {
			if shouldSkipDirectory(entry.Name()) {
				return filepath.SkipDir
			}
			return nil
		}

		relativePath, err := filepath.Rel(cleanRoot, currentPath)
		if err != nil {
			return err
		}
		normalizedPath := filepath.ToSlash(relativePath)
		fileInfo, err := entry.Info()
		if err != nil {
			return err
		}

		header, err := zip.FileInfoHeader(fileInfo)
		if err != nil {
			return err
		}
		header.Name = normalizedPath
		header.Method = zip.Deflate

		writer, err := zipWriter.CreateHeader(header)
		if err != nil {
			return err
		}

		sourceFile, err := os.Open(currentPath)
		if err != nil {
			return err
		}

		if _, err := io.Copy(writer, sourceFile); err != nil {
			_ = sourceFile.Close()
			return err
		}
		if err := sourceFile.Close(); err != nil {
			return err
		}

		return nil
	}); err != nil {
		return BackupSummary{}, fmt.Errorf("archive workspace backup: %w", err)
	}

	if err := zipWriter.Close(); err != nil {
		return BackupSummary{}, fmt.Errorf("finalize workspace backup: %w", err)
	}

	return BackupSummary{
		ID:          backupID,
		Label:       label,
		CreatedAt:   createdAt,
		ArchivePath: archivePath,
	}, nil
}

func RestoreBackup(rootPath string, archivePath string) (Snapshot, error) {
	cleanRoot, err := normaliseRootPath(rootPath)
	if err != nil {
		return Snapshot{}, err
	}

	cleanArchive := filepath.Clean(strings.TrimSpace(archivePath))
	if cleanArchive == "" {
		return Snapshot{}, errors.New("workspace backup archive path is required")
	}
	if strings.ToLower(filepath.Ext(cleanArchive)) != ".zip" {
		return Snapshot{}, errors.New("workspace backup must be a .zip archive")
	}

	if _, err := os.Stat(cleanArchive); err != nil {
		return Snapshot{}, fmt.Errorf("open workspace backup %q: %w", archivePath, err)
	}

	if err := clearWorkspaceForRestore(cleanRoot); err != nil {
		return Snapshot{}, err
	}

	reader, err := zip.OpenReader(cleanArchive)
	if err != nil {
		return Snapshot{}, fmt.Errorf("read workspace backup archive %q: %w", archivePath, err)
	}
	defer reader.Close()

	for _, entry := range reader.File {
		normalizedEntryPath := filepath.ToSlash(strings.TrimSpace(entry.Name))
		if normalizedEntryPath == "" || strings.HasSuffix(normalizedEntryPath, "/") {
			continue
		}
		if strings.HasPrefix(normalizedEntryPath, "/") || strings.Contains(normalizedEntryPath, "../") {
			return Snapshot{}, fmt.Errorf("invalid workspace backup entry %q", entry.Name)
		}

		targetPath := filepath.Join(cleanRoot, filepath.FromSlash(normalizedEntryPath))
		if !pathWithinRoot(cleanRoot, targetPath) {
			return Snapshot{}, fmt.Errorf("workspace backup entry %q escapes the workspace root", entry.Name)
		}

		if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
			return Snapshot{}, fmt.Errorf("create restore directory for %q: %w", entry.Name, err)
		}

		readCloser, err := entry.Open()
		if err != nil {
			return Snapshot{}, fmt.Errorf("open workspace backup entry %q: %w", entry.Name, err)
		}

		mode := entry.Mode()
		if mode == 0 {
			mode = 0o644
		}
		targetFile, err := os.OpenFile(targetPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode.Perm())
		if err != nil {
			_ = readCloser.Close()
			return Snapshot{}, fmt.Errorf("create restored file %q: %w", entry.Name, err)
		}

		if _, err := io.Copy(targetFile, readCloser); err != nil {
			_ = targetFile.Close()
			_ = readCloser.Close()
			return Snapshot{}, fmt.Errorf("restore file %q: %w", entry.Name, err)
		}

		_ = targetFile.Close()
		_ = readCloser.Close()
	}

	return Scan(cleanRoot)
}

func InspectRuntime(rootPath string) (RuntimeProfile, error) {
	cleanRoot, err := normaliseRootPath(rootPath)
	if err != nil {
		return RuntimeProfile{}, err
	}

	profile := RuntimeProfile{
		Label: filepath.Base(cleanRoot),
	}

	if detected, err := inspectNodeRuntime(cleanRoot, &profile); err != nil {
		return RuntimeProfile{}, err
	} else if detected {
		return profile, nil
	}

	if detected, err := inspectGoRuntime(cleanRoot, &profile); err != nil {
		return RuntimeProfile{}, err
	} else if detected {
		return profile, nil
	}

	if detected, err := inspectRustRuntime(cleanRoot, &profile); err != nil {
		return RuntimeProfile{}, err
	} else if detected {
		return profile, nil
	}

	if detected, err := inspectPythonRuntime(cleanRoot, &profile); err != nil {
		return RuntimeProfile{}, err
	} else if detected {
		return profile, nil
	}

	return profile, nil
}

func RunCommand(rootPath string, command string, timeoutMs int) (CommandResult, error) {
	cleanRoot, err := normaliseRootPath(rootPath)
	if err != nil {
		return CommandResult{}, err
	}

	trimmedCommand := strings.TrimSpace(command)
	if trimmedCommand == "" {
		return CommandResult{}, errors.New("workspace command is required")
	}

	if timeoutMs <= 0 {
		timeoutMs = 60_000
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()

	var cmd *exec.Cmd
	switch goruntime.GOOS {
	case "windows":
		cmd = exec.CommandContext(ctx, "cmd", "/C", trimmedCommand)
	default:
		cmd = exec.CommandContext(ctx, "sh", "-lc", trimmedCommand)
	}
	cmd.Dir = cleanRoot

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	startedAt := time.Now()
	runErr := cmd.Run()
	durationMs := time.Since(startedAt).Milliseconds()

	result := CommandResult{
		Command:        trimmedCommand,
		ExitCode:       0,
		Stdout:         stdout.String(),
		Stderr:         stderr.String(),
		CombinedOutput: strings.TrimSpace(stdout.String() + "\n" + stderr.String()),
		DurationMs:     durationMs,
		TimedOut:       errors.Is(ctx.Err(), context.DeadlineExceeded),
	}

	if runErr == nil {
		return result, nil
	}

	var exitErr *exec.ExitError
	if errors.As(runErr, &exitErr) {
		result.ExitCode = exitErr.ExitCode()
		return result, nil
	}

	if result.TimedOut {
		result.ExitCode = -1
		return result, nil
	}

	return CommandResult{}, fmt.Errorf("run workspace command %q: %w", trimmedCommand, runErr)
}

func RunWebPreview(rootPath string, command string, timeoutMs int) (CommandResult, error) {
	cleanRoot, err := normaliseRootPath(rootPath)
	if err != nil {
		return CommandResult{}, err
	}

	trimmedCommand := strings.TrimSpace(command)
	if trimmedCommand == "" {
		return CommandResult{}, errors.New("workspace preview command is required")
	}

	if timeoutMs <= 0 {
		timeoutMs = 60_000
	}

	previewCommand, previewURL, err := prepareWebPreviewCommand(cleanRoot, trimmedCommand)
	if err != nil {
		return CommandResult{
			Command:        fmt.Sprintf("browser preview (%s)", trimmedCommand),
			ExitCode:       1,
			CombinedOutput: err.Error(),
			DurationMs:     0,
			TimedOut:       false,
		}, nil
	}

	browserPath, err := findHeadlessBrowser()
	if err != nil {
		return CommandResult{
			Command:        fmt.Sprintf("browser preview (%s)", trimmedCommand),
			ExitCode:       1,
			CombinedOutput: err.Error(),
			DurationMs:     0,
			TimedOut:       false,
		}, nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()

	previewCmd := buildShellCommand(ctx, previewCommand)
	previewCmd.Dir = cleanRoot

	var previewStdout bytes.Buffer
	var previewStderr bytes.Buffer
	previewCmd.Stdout = &previewStdout
	previewCmd.Stderr = &previewStderr

	startedAt := time.Now()
	if err := previewCmd.Start(); err != nil {
		return CommandResult{}, fmt.Errorf("start workspace preview %q: %w", previewCommand, err)
	}
	defer terminateProcessTree(previewCmd)

	waitCh := make(chan error, 1)
	go func() {
		waitCh <- previewCmd.Wait()
	}()

	readinessErr := waitForPreviewReadiness(ctx, previewURL, waitCh)
	timedOut := errors.Is(readinessErr, context.DeadlineExceeded)
	if readinessErr != nil {
		durationMs := time.Since(startedAt).Milliseconds()
		serverLogs := strings.TrimSpace(previewStdout.String() + "\n" + previewStderr.String())
		detail := []string{
			fmt.Sprintf("Preview URL: %s", previewURL),
			"Preview reachability: failed",
			fmt.Sprintf("Reason: %s", readinessErr.Error()),
		}
		if serverLogs != "" {
			detail = append(detail, "", "Server logs:", truncatePreviewContent(serverLogs, 2400))
		}
		exitCode := 1
		if timedOut {
			exitCode = -1
		}
		return CommandResult{
			Command:        fmt.Sprintf("browser preview (%s)", trimmedCommand),
			ExitCode:       exitCode,
			Stdout:         previewStdout.String(),
			Stderr:         previewStderr.String(),
			CombinedOutput: strings.Join(detail, "\n"),
			DurationMs:     durationMs,
			TimedOut:       timedOut,
		}, nil
	}

	dom, browserErr := dumpPreviewDOM(ctx, browserPath, previewURL)
	durationMs := time.Since(startedAt).Milliseconds()
	serverLogs := strings.TrimSpace(previewStdout.String() + "\n" + previewStderr.String())
	if browserErr != nil {
		detail := []string{
			fmt.Sprintf("Preview URL: %s", previewURL),
			"Preview reachability: ready",
			fmt.Sprintf("Browser probe failed: %s", browserErr.Error()),
		}
		if serverLogs != "" {
			detail = append(detail, "", "Server logs:", truncatePreviewContent(serverLogs, 2400))
		}
		return CommandResult{
			Command:        fmt.Sprintf("browser preview (%s)", trimmedCommand),
			ExitCode:       1,
			Stdout:         "",
			Stderr:         previewStderr.String(),
			CombinedOutput: strings.Join(detail, "\n"),
			DurationMs:     durationMs,
			TimedOut:       errors.Is(ctx.Err(), context.DeadlineExceeded),
		}, nil
	}

	looksBlank, notes := analyzePreviewDOM(dom)
	detail := []string{
		fmt.Sprintf("Preview URL: %s", previewURL),
		"Preview reachability: ready",
		fmt.Sprintf("Browser: %s", filepath.Base(browserPath)),
		fmt.Sprintf("Rendered output: %s", map[bool]string{true: "blank or nearly blank", false: "non-empty"}[looksBlank]),
	}
	if len(notes) > 0 {
		detail = append(detail, "Notes:")
		for _, note := range notes {
			detail = append(detail, fmt.Sprintf("- %s", note))
		}
	}
	if serverLogs != "" {
		detail = append(detail, "", "Server logs:", truncatePreviewContent(serverLogs, 2000))
	}
	if strings.TrimSpace(dom) != "" {
		detail = append(detail, "", "Rendered DOM snapshot:", truncatePreviewContent(strings.TrimSpace(dom), 2400))
	}

	exitCode := 0
	if looksBlank {
		exitCode = 1
	}

	return CommandResult{
		Command:        fmt.Sprintf("browser preview (%s)", trimmedCommand),
		ExitCode:       exitCode,
		Stdout:         dom,
		Stderr:         previewStderr.String(),
		CombinedOutput: strings.Join(detail, "\n"),
		DurationMs:     durationMs,
		TimedOut:       errors.Is(ctx.Err(), context.DeadlineExceeded),
	}, nil
}

func openPath(targetPath string) error {
	var cmd *exec.Cmd
	switch goruntime.GOOS {
	case "windows":
		cmd = exec.Command("cmd", "/C", "start", "", targetPath)
	case "darwin":
		cmd = exec.Command("open", targetPath)
	default:
		cmd = exec.Command("xdg-open", targetPath)
	}

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("open %q: %w", targetPath, err)
	}

	return nil
}

func workspaceBackupDirectory(workspaceID string, label string) (string, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("resolve user config directory: %w", err)
	}

	scope := sanitizeWorkspaceDirectoryName(workspaceID)
	if scope == "" {
		scope = sanitizeWorkspaceDirectoryName(label)
	}
	if scope == "" {
		scope = "workspace"
	}

	return filepath.Join(configDir, "LarryAI", "workspace-backups", scope), nil
}

func clearWorkspaceForRestore(rootPath string) error {
	entries, err := os.ReadDir(rootPath)
	if err != nil {
		return fmt.Errorf("read workspace root %q before restore: %w", rootPath, err)
	}

	for _, entry := range entries {
		name := entry.Name()
		if name == ".git" || shouldSkipDirectory(name) {
			continue
		}

		targetPath := filepath.Join(rootPath, name)
		if err := os.RemoveAll(targetPath); err != nil {
			return fmt.Errorf("clear workspace entry %q before restore: %w", name, err)
		}
	}

	return nil
}

func pathWithinRoot(rootPath string, targetPath string) bool {
	cleanRoot := filepath.Clean(rootPath)
	cleanTarget := filepath.Clean(targetPath)
	if cleanRoot == cleanTarget {
		return true
	}
	return strings.HasPrefix(cleanTarget, cleanRoot+string(filepath.Separator))
}

func inspectNodeRuntime(rootPath string, profile *RuntimeProfile) (bool, error) {
	packageJSONPath := filepath.Join(rootPath, "package.json")
	content, err := os.ReadFile(packageJSONPath)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read package.json: %w", err)
	}

	var manifest struct {
		Name    string            `json:"name"`
		Scripts map[string]string `json:"scripts"`
	}
	if err := json.Unmarshal(content, &manifest); err != nil {
		return false, fmt.Errorf("parse package.json: %w", err)
	}

	packageManager := "npm"
	switch {
	case fileExists(filepath.Join(rootPath, "pnpm-lock.yaml")):
		packageManager = "pnpm"
	case fileExists(filepath.Join(rootPath, "yarn.lock")):
		packageManager = "yarn"
	}

	profile.Ecosystem = "node"
	profile.DetectedFiles = append(profile.DetectedFiles, "package.json")
	if manifest.Name != "" {
		profile.Label = manifest.Name
	}

	appendNodeCommand(profile, manifest.Scripts, "build", packageManager)
	appendNodeCommand(profile, manifest.Scripts, "test", packageManager)
	appendNodeCommand(profile, manifest.Scripts, "lint", packageManager)
	if hasRunnableScript(manifest.Scripts["preview"]) {
		profile.Commands = append(profile.Commands, RuntimeCommand{
			Kind:    "start",
			Label:   "Preview built application",
			Command: buildPackageManagerCommand(packageManager, "preview"),
		})
	} else if hasRunnableScript(manifest.Scripts["dev"]) {
		profile.Commands = append(profile.Commands, RuntimeCommand{
			Kind:    "start",
			Label:   "Start dev server",
			Command: buildPackageManagerCommand(packageManager, "dev"),
		})
	} else if hasRunnableScript(manifest.Scripts["start"]) {
		profile.Commands = append(profile.Commands, RuntimeCommand{
			Kind:    "start",
			Label:   "Start application",
			Command: buildPackageManagerCommand(packageManager, "start"),
		})
	}

	return true, nil
}

func inspectGoRuntime(rootPath string, profile *RuntimeProfile) (bool, error) {
	if !fileExists(filepath.Join(rootPath, "go.mod")) {
		return false, nil
	}

	profile.Ecosystem = "go"
	profile.DetectedFiles = append(profile.DetectedFiles, "go.mod")
	profile.Commands = append(profile.Commands,
		RuntimeCommand{Kind: "test", Label: "Run Go tests", Command: "go test ./..."},
		RuntimeCommand{Kind: "build", Label: "Build Go packages", Command: "go build ./..."},
	)
	return true, nil
}

func inspectRustRuntime(rootPath string, profile *RuntimeProfile) (bool, error) {
	if !fileExists(filepath.Join(rootPath, "Cargo.toml")) {
		return false, nil
	}

	profile.Ecosystem = "rust"
	profile.DetectedFiles = append(profile.DetectedFiles, "Cargo.toml")
	profile.Commands = append(profile.Commands,
		RuntimeCommand{Kind: "test", Label: "Run Rust tests", Command: "cargo test"},
		RuntimeCommand{Kind: "build", Label: "Build Rust project", Command: "cargo build"},
	)
	return true, nil
}

func inspectPythonRuntime(rootPath string, profile *RuntimeProfile) (bool, error) {
	hasPyproject := fileExists(filepath.Join(rootPath, "pyproject.toml"))
	hasRequirements := fileExists(filepath.Join(rootPath, "requirements.txt"))
	if !hasPyproject && !hasRequirements {
		return false, nil
	}

	profile.Ecosystem = "python"
	if hasPyproject {
		profile.DetectedFiles = append(profile.DetectedFiles, "pyproject.toml")
	}
	if hasRequirements {
		profile.DetectedFiles = append(profile.DetectedFiles, "requirements.txt")
	}

	if fileExists(filepath.Join(rootPath, "pytest.ini")) || fileExists(filepath.Join(rootPath, "tests")) {
		profile.Commands = append(profile.Commands, RuntimeCommand{
			Kind:    "test",
			Label:   "Run Python tests",
			Command: "python -m pytest",
		})
	}

	profile.Commands = append(profile.Commands, RuntimeCommand{
		Kind:    "build",
		Label:   "Compile Python sources",
		Command: "python -m compileall .",
	})
	return true, nil
}

func appendNodeCommand(profile *RuntimeProfile, scripts map[string]string, scriptName string, packageManager string) {
	if !hasRunnableScript(scripts[scriptName]) {
		return
	}

	kind := scriptName
	label := fmt.Sprintf("Run %s", scriptName)
	if scriptName == "build" {
		label = "Build application"
	} else if scriptName == "test" {
		label = "Run tests"
	} else if scriptName == "lint" {
		label = "Run lint checks"
	}

	profile.Commands = append(profile.Commands, RuntimeCommand{
		Kind:    kind,
		Label:   label,
		Command: buildPackageManagerCommand(packageManager, scriptName),
	})
}

func buildPackageManagerCommand(packageManager string, scriptName string) string {
	switch packageManager {
	case "pnpm":
		return fmt.Sprintf("pnpm %s", scriptName)
	case "yarn":
		return fmt.Sprintf("yarn %s", scriptName)
	default:
		return fmt.Sprintf("npm run %s", scriptName)
	}
}

func hasRunnableScript(script string) bool {
	trimmed := strings.TrimSpace(script)
	if trimmed == "" {
		return false
	}
	if strings.Contains(trimmed, "no test specified") {
		return false
	}
	return true
}

func prepareWebPreviewCommand(rootPath string, command string) (string, string, error) {
	port, err := reserveLocalPort()
	if err != nil {
		return "", "", fmt.Errorf("reserve preview port: %w", err)
	}

	host := "127.0.0.1"
	previewURL := fmt.Sprintf("http://%s:%d", host, port)
	trimmedCommand := strings.TrimSpace(command)
	lowerCommand := strings.ToLower(trimmedCommand)
	manifestLower := readPackageManifestLower(rootPath)
	isScriptRunner := strings.HasPrefix(lowerCommand, "npm ") || strings.HasPrefix(lowerCommand, "pnpm ")
	isYarnRunner := strings.HasPrefix(lowerCommand, "yarn ")

	switch {
	case strings.Contains(manifestLower, `"vite"`) ||
		fileExists(filepath.Join(rootPath, "vite.config.ts")) ||
		fileExists(filepath.Join(rootPath, "vite.config.js")) ||
		fileExists(filepath.Join(rootPath, "vite.config.mjs")) ||
		fileExists(filepath.Join(rootPath, "vite.config.cjs")):
		switch {
		case isYarnRunner:
			return fmt.Sprintf("%s --host %s --port %d", trimmedCommand, host, port), previewURL, nil
		case isScriptRunner:
			return fmt.Sprintf("%s -- --host %s --port %d", trimmedCommand, host, port), previewURL, nil
		default:
			return fmt.Sprintf("%s --host %s --port %d", trimmedCommand, host, port), previewURL, nil
		}
	case strings.Contains(manifestLower, `"next"`):
		switch {
		case isYarnRunner:
			return fmt.Sprintf("%s --hostname %s --port %d", trimmedCommand, host, port), previewURL, nil
		case isScriptRunner:
			return fmt.Sprintf("%s -- --hostname %s --port %d", trimmedCommand, host, port), previewURL, nil
		default:
			return fmt.Sprintf("%s --hostname %s --port %d", trimmedCommand, host, port), previewURL, nil
		}
	case strings.Contains(manifestLower, `"react-scripts"`):
		if goruntime.GOOS == "windows" {
			return fmt.Sprintf("set HOST=%s&& set PORT=%d&& %s", host, port, trimmedCommand), previewURL, nil
		}
		return fmt.Sprintf("HOST=%s PORT=%d %s", host, port, trimmedCommand), previewURL, nil
	default:
		return "", "", errors.New("web preview smoke test could not determine how to launch this workspace automatically")
	}
}

func readPackageManifestLower(rootPath string) string {
	content, err := os.ReadFile(filepath.Join(rootPath, "package.json"))
	if err != nil {
		return ""
	}
	return strings.ToLower(string(content))
}

func reserveLocalPort() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer listener.Close()

	tcpAddress, ok := listener.Addr().(*net.TCPAddr)
	if !ok {
		return 0, errors.New("unable to determine preview port")
	}
	return tcpAddress.Port, nil
}

func buildShellCommand(ctx context.Context, command string) *exec.Cmd {
	switch goruntime.GOOS {
	case "windows":
		return exec.CommandContext(ctx, "cmd", "/C", command)
	default:
		return exec.CommandContext(ctx, "sh", "-lc", command)
	}
}

func waitForPreviewReadiness(ctx context.Context, previewURL string, waitCh <-chan error) error {
	client := &http.Client{
		Timeout: 1500 * time.Millisecond,
	}
	ticker := time.NewTicker(300 * time.Millisecond)
	defer ticker.Stop()

	for {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, previewURL, nil)
		if err != nil {
			return err
		}
		response, err := client.Do(request)
		if err == nil {
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
			if response.StatusCode < 500 {
				return nil
			}
		}

		select {
		case runErr := <-waitCh:
			if runErr == nil {
				return errors.New("preview process exited before the app became reachable")
			}
			return fmt.Errorf("preview process exited before the app became reachable: %w", runErr)
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func findHeadlessBrowser() (string, error) {
	candidates := []string{}

	switch goruntime.GOOS {
	case "windows":
		candidates = append(candidates,
			filepath.Join(os.Getenv("ProgramFiles"), "Microsoft", "Edge", "Application", "msedge.exe"),
			filepath.Join(os.Getenv("ProgramFiles(x86)"), "Microsoft", "Edge", "Application", "msedge.exe"),
			filepath.Join(os.Getenv("ProgramFiles"), "Google", "Chrome", "Application", "chrome.exe"),
			filepath.Join(os.Getenv("ProgramFiles(x86)"), "Google", "Chrome", "Application", "chrome.exe"),
		)
		for _, name := range []string{"msedge.exe", "chrome.exe"} {
			if resolved, err := exec.LookPath(name); err == nil {
				candidates = append(candidates, resolved)
			}
		}
	default:
		for _, name := range []string{"microsoft-edge", "msedge", "google-chrome", "chromium", "chromium-browser"} {
			if resolved, err := exec.LookPath(name); err == nil {
				candidates = append(candidates, resolved)
			}
		}
	}

	for _, candidate := range candidates {
		if strings.TrimSpace(candidate) == "" {
			continue
		}
		if fileExists(candidate) {
			return candidate, nil
		}
	}

	return "", errors.New("no supported headless browser was found for the workspace preview check")
}

func dumpPreviewDOM(ctx context.Context, browserPath string, previewURL string) (string, error) {
	args := []string{
		"--headless=new",
		"--disable-gpu",
		"--disable-extensions",
		"--no-first-run",
		"--no-default-browser-check",
		"--virtual-time-budget=8000",
		"--dump-dom",
		previewURL,
	}

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	command := exec.CommandContext(ctx, browserPath, args...)
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := command.Run(); err == nil {
		return stdout.String(), nil
	}

	args[0] = "--headless"
	stdout.Reset()
	stderr.Reset()
	command = exec.CommandContext(ctx, browserPath, args...)
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = err.Error()
		}
		return "", errors.New(message)
	}

	return stdout.String(), nil
}

var (
	previewScriptStylePattern = regexp.MustCompile(`(?is)<script\b[^>]*>.*?</script>|<style\b[^>]*>.*?</style>`)
	previewCommentPattern     = regexp.MustCompile(`(?s)<!--.*?-->`)
	previewTagPattern         = regexp.MustCompile(`(?s)<[^>]+>`)
	previewRootEmptyPattern   = regexp.MustCompile(`(?is)<div[^>]+id=["'](?:root|app|__next|svelte)["'][^>]*>\s*</div>`)
	previewVisiblePattern     = regexp.MustCompile(`(?is)<(img|svg|canvas|video|main|section|article|button|input|textarea|nav|header|footer|table|ul|ol|li|form)\b`)
)

func analyzePreviewDOM(dom string) (bool, []string) {
	body := extractPreviewBody(dom)
	withoutScripts := previewScriptStylePattern.ReplaceAllString(body, " ")
	withoutComments := previewCommentPattern.ReplaceAllString(withoutScripts, " ")
	visibleText := strings.Join(strings.Fields(previewTagPattern.ReplaceAllString(withoutComments, " ")), " ")
	hasVisibleElements := previewVisiblePattern.MatchString(withoutComments)
	rootLooksEmpty := previewRootEmptyPattern.MatchString(withoutComments)

	notes := []string{}
	if rootLooksEmpty {
		notes = append(notes, "The root application container stayed empty after the browser finished rendering.")
	}
	if visibleText == "" {
		notes = append(notes, "The rendered page did not expose visible text content.")
	}
	if !hasVisibleElements {
		notes = append(notes, "The rendered page did not expose common UI elements such as images, sections, or interactive controls.")
	}

	looksBlank := (visibleText == "" && !hasVisibleElements) || (rootLooksEmpty && len(visibleText) < 12 && !hasVisibleElements)
	if !looksBlank {
		notes = append(notes, "The browser probe observed rendered output in the DOM.")
	}

	return looksBlank, notes
}

func extractPreviewBody(dom string) string {
	lower := strings.ToLower(dom)
	start := strings.Index(lower, "<body")
	if start == -1 {
		return dom
	}
	bodyStart := strings.Index(lower[start:], ">")
	if bodyStart == -1 {
		return dom
	}
	contentStart := start + bodyStart + 1
	end := strings.LastIndex(lower, "</body>")
	if end == -1 || end <= contentStart {
		return dom[contentStart:]
	}
	return dom[contentStart:end]
}

func truncatePreviewContent(value string, limit int) string {
	trimmed := strings.TrimSpace(value)
	if limit <= 0 || len(trimmed) <= limit {
		return trimmed
	}
	return strings.TrimSpace(trimmed[:limit]) + "\n..."
}

func terminateProcessTree(command *exec.Cmd) {
	if command == nil || command.Process == nil {
		return
	}

	if goruntime.GOOS == "windows" {
		_ = exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(command.Process.Pid)).Run()
		return
	}

	_ = command.Process.Kill()
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func copyWorkspaceDirectory(sourcePath string, targetPath string) error {
	info, err := os.Stat(sourcePath)
	if err != nil {
		return err
	}

	if err := os.MkdirAll(targetPath, info.Mode().Perm()); err != nil {
		return err
	}

	entries, err := os.ReadDir(sourcePath)
	if err != nil {
		return err
	}

	for _, entry := range entries {
		sourceChildPath := filepath.Join(sourcePath, entry.Name())
		targetChildPath := filepath.Join(targetPath, entry.Name())

		if entry.IsDir() {
			if err := copyWorkspaceDirectory(sourceChildPath, targetChildPath); err != nil {
				return err
			}
			continue
		}

		childInfo, err := entry.Info()
		if err != nil {
			return err
		}
		if err := copyWorkspaceFile(sourceChildPath, targetChildPath, childInfo.Mode()); err != nil {
			return err
		}
	}

	return nil
}

func copyWorkspaceFile(sourcePath string, targetPath string, mode os.FileMode) error {
	content, err := os.ReadFile(sourcePath)
	if err != nil {
		return err
	}

	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		return err
	}

	return os.WriteFile(targetPath, content, mode.Perm())
}

func scanDirectory(rootPath string, currentPath string) ([]FileNode, []FileEntry, int, int, error) {
	dirEntries, err := os.ReadDir(currentPath)
	if err != nil {
		return nil, nil, 0, 0, fmt.Errorf("read directory %q: %w", currentPath, err)
	}

	nodes := make([]FileNode, 0, len(dirEntries))
	fileEntries := make([]FileEntry, 0)
	fileCount := 0
	directoryCount := 0

	for _, entry := range dirEntries {
		if entry.Type()&os.ModeSymlink != 0 {
			continue
		}

		name := entry.Name()
		if entry.IsDir() {
			if shouldSkipDirectory(name) {
				continue
			}

			absoluteChildPath := filepath.Join(currentPath, name)
			relativeChildPath, err := filepath.Rel(rootPath, absoluteChildPath)
			if err != nil {
				return nil, nil, 0, 0, fmt.Errorf("resolve workspace directory path: %w", err)
			}

			childNodes, childEntries, childFileCount, childDirectoryCount, err := scanDirectory(rootPath, absoluteChildPath)
			if err != nil {
				return nil, nil, 0, 0, err
			}

			nodes = append(nodes, FileNode{
				Name:     name,
				Path:     filepath.ToSlash(relativeChildPath),
				Kind:     "directory",
				Children: childNodes,
			})
			fileEntries = append(fileEntries, childEntries...)
			fileCount += childFileCount
			directoryCount += childDirectoryCount + 1
			continue
		}

		if shouldSkipFile(name) {
			continue
		}

		absoluteFilePath := filepath.Join(currentPath, name)
		relativeFilePath, err := filepath.Rel(rootPath, absoluteFilePath)
		if err != nil {
			return nil, nil, 0, 0, fmt.Errorf("resolve workspace file path: %w", err)
		}

		normalizedFilePath := filepath.ToSlash(relativeFilePath)
		extension := strings.TrimPrefix(strings.ToLower(filepath.Ext(name)), ".")

		nodes = append(nodes, FileNode{
			Name:      name,
			Path:      normalizedFilePath,
			Kind:      "file",
			Extension: extension,
		})
		fileCount += 1

		textContent, ok, err := readTextFile(absoluteFilePath)
		if err != nil {
			return nil, nil, 0, 0, err
		}
		if ok {
			fileEntries = append(fileEntries, FileEntry{
				Path:      normalizedFilePath,
				Content:   textContent,
				Lang:      languageFromPath(normalizedFilePath),
				UpdatedAt: 0,
			})
		}
	}

	sort.Slice(nodes, func(left int, right int) bool {
		if nodes[left].Kind == nodes[right].Kind {
			return strings.ToLower(nodes[left].Path) < strings.ToLower(nodes[right].Path)
		}

		return nodes[left].Kind == "directory"
	})
	sort.Slice(fileEntries, func(left int, right int) bool {
		return strings.ToLower(fileEntries[left].Path) < strings.ToLower(fileEntries[right].Path)
	})

	return nodes, fileEntries, fileCount, directoryCount, nil
}

func shouldSkipDirectory(name string) bool {
	_, ignored := ignoredDirectories[strings.ToLower(name)]
	return ignored
}

func shouldSkipFile(name string) bool {
	_, ignored := ignoredExtensions[strings.ToLower(filepath.Ext(name))]
	return ignored
}

func readTextFile(path string) (string, bool, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", false, fmt.Errorf("stat workspace file %q: %w", path, err)
	}
	if info.Size() > maxIndexedFileSize {
		return "", false, nil
	}

	file, err := os.Open(path)
	if err != nil {
		return "", false, fmt.Errorf("open workspace file %q: %w", path, err)
	}
	defer file.Close()

	content, err := io.ReadAll(file)
	if err != nil {
		return "", false, fmt.Errorf("read workspace file %q: %w", path, err)
	}
	if bytes.Contains(content, []byte{0}) {
		return "", false, nil
	}

	return string(content), true, nil
}

func normaliseRootPath(rootPath string) (string, error) {
	cleanRoot := strings.TrimSpace(rootPath)
	if cleanRoot == "" {
		return "", errors.New("workspace root path is required")
	}

	absoluteRoot, err := filepath.Abs(cleanRoot)
	if err != nil {
		return "", fmt.Errorf("resolve absolute workspace path: %w", err)
	}

	info, err := os.Stat(absoluteRoot)
	if err != nil {
		return "", fmt.Errorf("stat workspace root %q: %w", absoluteRoot, err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("workspace root %q is not a directory", absoluteRoot)
	}

	return absoluteRoot, nil
}

func managedWorkspaceRoot() (string, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("resolve user config dir for workspaces: %w", err)
	}

	rootDir := filepath.Join(configDir, "LarryAI", "workspaces")
	if err := os.MkdirAll(rootDir, 0o755); err != nil {
		return "", fmt.Errorf("create managed workspace root %q: %w", rootDir, err)
	}

	return rootDir, nil
}

func sanitizeWorkspaceDirectoryName(label string) string {
	trimmed := strings.TrimSpace(label)
	if trimmed == "" {
		return "Workspace"
	}

	replacer := strings.NewReplacer(
		"/", "-",
		"\\", "-",
		":", "-",
		"*", "",
		"?", "",
		"\"", "",
		"<", "",
		">", "",
		"|", "",
	)
	safe := strings.TrimSpace(replacer.Replace(trimmed))
	safe = strings.Trim(safe, ". ")
	if safe == "" {
		return "Workspace"
	}

	return safe
}

func ensureWorkspaceDirectory(rootDir string, desiredName string) (string, error) {
	basePath := filepath.Join(rootDir, desiredName)
	info, err := os.Stat(basePath)
	switch {
	case err == nil && info.IsDir():
		return basePath, nil
	case err == nil:
		// Fall through and create a unique directory name beside the existing file.
	case !errors.Is(err, os.ErrNotExist):
		return "", fmt.Errorf("stat managed workspace directory %q: %w", basePath, err)
	}

	for index := 0; index < 1000; index += 1 {
		candidatePath := basePath
		if index > 0 {
			candidatePath = filepath.Join(rootDir, fmt.Sprintf("%s-%d", desiredName, index+1))
		}

		if err := os.Mkdir(candidatePath, 0o755); err == nil {
			return candidatePath, nil
		} else if errors.Is(err, os.ErrExist) {
			continue
		} else {
			return "", fmt.Errorf("create managed workspace directory %q: %w", candidatePath, err)
		}
	}

	return "", fmt.Errorf("could not allocate a managed workspace directory for %q", desiredName)
}

func resolveWorkspacePath(rootPath string, relativePath string) (string, string, error) {
	cleanRoot, err := normaliseRootPath(rootPath)
	if err != nil {
		return "", "", err
	}

	cleanRelativePath := filepath.Clean(filepath.FromSlash(strings.TrimSpace(relativePath)))
	if cleanRelativePath == "." || cleanRelativePath == string(filepath.Separator) {
		return "", "", errors.New("a relative workspace path is required")
	}
	if filepath.IsAbs(cleanRelativePath) {
		return "", "", errors.New("workspace paths must be relative")
	}

	targetPath := filepath.Join(cleanRoot, cleanRelativePath)
	relativeTargetPath, err := filepath.Rel(cleanRoot, targetPath)
	if err != nil {
		return "", "", fmt.Errorf("resolve workspace path %q: %w", relativePath, err)
	}
	if relativeTargetPath == "." || strings.HasPrefix(relativeTargetPath, "..") {
		return "", "", errors.New("workspace path must stay inside the selected folder")
	}

	return targetPath, filepath.ToSlash(relativeTargetPath), nil
}

func languageFromPath(path string) string {
	ext := strings.TrimPrefix(strings.ToLower(filepath.Ext(path)), ".")
	switch ext {
	case "ts":
		return "ts"
	case "tsx":
		return "tsx"
	case "js":
		return "js"
	case "jsx":
		return "jsx"
	case "py":
		return "py"
	case "html":
		return "html"
	case "css":
		return "css"
	case "scss":
		return "scss"
	case "json":
		return "json"
	case "md":
		return "md"
	case "sh":
		return "sh"
	case "bash":
		return "bash"
	case "yaml", "yml":
		return "yaml"
	case "xml":
		return "xml"
	case "sql":
		return "sql"
	case "go":
		return "go"
	case "rs":
		return "rs"
	case "java":
		return "java"
	case "c":
		return "c"
	case "cpp":
		return "cpp"
	default:
		if ext == "" {
			return "text"
		}
		return ext
	}
}
