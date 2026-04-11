package workspace

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"sort"
	"strings"
	"time"

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

	label := filepath.Base(selectedPath)
	if label == "." || label == string(filepath.Separator) || strings.TrimSpace(label) == "" {
		label = "Workspace"
	}

	return CreateManagedWorkspace(label)
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

	var cmd *exec.Cmd
	switch goruntime.GOOS {
	case "windows":
		cmd = exec.Command("explorer", cleanRoot)
	case "darwin":
		cmd = exec.Command("open", cleanRoot)
	default:
		cmd = exec.Command("xdg-open", cleanRoot)
	}

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("open %q in file explorer: %w", cleanRoot, err)
	}

	return nil
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
