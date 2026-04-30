package workspace

import (
	"os"
	"path/filepath"
	"testing"
)

func TestBuildSelectionScansSelectedDirectory(t *testing.T) {
	rootDir := t.TempDir()

	if err := os.MkdirAll(filepath.Join(rootDir, "src"), 0o755); err != nil {
		t.Fatalf("create src directory: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(rootDir, "node_modules", "pkg"), 0o755); err != nil {
		t.Fatalf("create ignored directory: %v", err)
	}

	if err := os.WriteFile(filepath.Join(rootDir, "README.md"), []byte("# Workspace\n"), 0o644); err != nil {
		t.Fatalf("write README: %v", err)
	}
	if err := os.WriteFile(filepath.Join(rootDir, "src", "main.go"), []byte("package main\n"), 0o644); err != nil {
		t.Fatalf("write Go source file: %v", err)
	}
	if err := os.WriteFile(filepath.Join(rootDir, "image.png"), []byte("not indexed"), 0o644); err != nil {
		t.Fatalf("write ignored binary-like file: %v", err)
	}
	if err := os.WriteFile(filepath.Join(rootDir, "node_modules", "pkg", "index.js"), []byte("console.log('skip')\n"), 0o644); err != nil {
		t.Fatalf("write ignored dependency file: %v", err)
	}

	selection, err := BuildSelection(rootDir)
	if err != nil {
		t.Fatalf("build selection: %v", err)
	}

	if selection.RootPath != rootDir {
		t.Fatalf("root path = %q, want %q", selection.RootPath, rootDir)
	}

	wantLabel := filepath.Base(rootDir)
	if selection.Label != wantLabel {
		t.Fatalf("label = %q, want %q", selection.Label, wantLabel)
	}

	if selection.Snapshot.RootPath != rootDir {
		t.Fatalf("snapshot root path = %q, want %q", selection.Snapshot.RootPath, rootDir)
	}

	if selection.Snapshot.FileCount != 2 {
		t.Fatalf("file count = %d, want 2", selection.Snapshot.FileCount)
	}

	if selection.Snapshot.DirectoryCount != 1 {
		t.Fatalf("directory count = %d, want 1", selection.Snapshot.DirectoryCount)
	}

	if len(selection.Snapshot.FileTree) != 2 {
		t.Fatalf("file tree nodes = %d, want 2", len(selection.Snapshot.FileTree))
	}

	if selection.Snapshot.FileTree[0].Kind != "directory" || selection.Snapshot.FileTree[0].Path != "src" {
		t.Fatalf("first file tree node = %+v, want src directory", selection.Snapshot.FileTree[0])
	}

	if selection.Snapshot.FileTree[1].Kind != "file" || selection.Snapshot.FileTree[1].Path != "README.md" {
		t.Fatalf("second file tree node = %+v, want README.md file", selection.Snapshot.FileTree[1])
	}

	if len(selection.Snapshot.FileEntries) != 2 {
		t.Fatalf("file entries = %d, want 2", len(selection.Snapshot.FileEntries))
	}

	if selection.Snapshot.FileEntries[0].Path != "README.md" {
		t.Fatalf("first indexed file = %q, want README.md", selection.Snapshot.FileEntries[0].Path)
	}

	if selection.Snapshot.FileEntries[1].Path != "src/main.go" {
		t.Fatalf("second indexed file = %q, want src/main.go", selection.Snapshot.FileEntries[1].Path)
	}
}

func TestReadFileReturnsWorkspaceDocument(t *testing.T) {
	rootDir := t.TempDir()
	filePath := filepath.Join(rootDir, "src", "editor.ts")

	if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
		t.Fatalf("create parent directory: %v", err)
	}
	if err := os.WriteFile(filePath, []byte("export const ready = true;\n"), 0o644); err != nil {
		t.Fatalf("write editor file: %v", err)
	}

	document, err := ReadFile(rootDir, "src/editor.ts")
	if err != nil {
		t.Fatalf("read workspace file: %v", err)
	}

	if document.Path != "src/editor.ts" {
		t.Fatalf("document path = %q, want src/editor.ts", document.Path)
	}
	if document.Lang != "ts" {
		t.Fatalf("document lang = %q, want ts", document.Lang)
	}
	if document.Content != "export const ready = true;\n" {
		t.Fatalf("document content = %q", document.Content)
	}
	if document.SizeBytes <= 0 {
		t.Fatalf("document size = %d, want > 0", document.SizeBytes)
	}
	if document.ModifiedAt <= 0 {
		t.Fatalf("document modifiedAt = %d, want > 0", document.ModifiedAt)
	}
}

func TestReadFileRejectsWorkspacePathEscape(t *testing.T) {
	rootDir := t.TempDir()

	if _, err := ReadFile(rootDir, "../outside.txt"); err == nil {
		t.Fatal("expected path traversal to be rejected")
	}
}

func TestRenameEntryRenamesWorkspaceFile(t *testing.T) {
	rootDir := t.TempDir()
	oldPath := filepath.Join(rootDir, "src", "editor.ts")
	newPath := filepath.Join(rootDir, "src", "editor-renamed.ts")

	if err := os.MkdirAll(filepath.Dir(oldPath), 0o755); err != nil {
		t.Fatalf("create parent directory: %v", err)
	}
	if err := os.WriteFile(oldPath, []byte("export const ready = true;\n"), 0o644); err != nil {
		t.Fatalf("write original file: %v", err)
	}

	snapshot, err := RenameEntry(rootDir, "src/editor.ts", "src/editor-renamed.ts")
	if err != nil {
		t.Fatalf("rename workspace entry: %v", err)
	}

	if _, err := os.Stat(oldPath); !os.IsNotExist(err) {
		t.Fatalf("expected original file to be removed, got err=%v", err)
	}

	content, err := os.ReadFile(newPath)
	if err != nil {
		t.Fatalf("read renamed file: %v", err)
	}
	if string(content) != "export const ready = true;\n" {
		t.Fatalf("renamed file content = %q", string(content))
	}

	if snapshot.FileCount != 1 {
		t.Fatalf("snapshot file count = %d, want 1", snapshot.FileCount)
	}
	if len(snapshot.FileTree) != 1 || snapshot.FileTree[0].Path != "src" {
		t.Fatalf("snapshot file tree = %+v", snapshot.FileTree)
	}
}
