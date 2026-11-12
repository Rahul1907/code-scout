"use client";

import { ChevronDown, ChevronRight, FileCode2, Folder, FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";
import type { TreeNode } from "@/lib/types";

interface FileTreeProps {
  nodes: TreeNode[];
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
}

function collectAncestorDirs(filePath: string): string[] {
  const parts = filePath.split("/");
  const dirs: string[] = [];
  for (let i = 1; i < parts.length; i += 1) {
    dirs.push(parts.slice(0, i).join("/"));
  }
  return dirs;
}

export function FileTree({ nodes, selectedPath, onSelectFile }: FileTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!selectedPath) return;
    const ancestors = collectAncestorDirs(selectedPath);
    if (ancestors.length === 0) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const dir of ancestors) {
        next.add(dir);
      }
      return next;
    });
  }, [selectedPath]);

  const toggleDir = (dirPath: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
      }
      return next;
    });
  };

  if (nodes.length === 0) {
    return (
      <p className="p-4 text-xs text-[var(--muted)]">
        No files available yet. Wait for indexing to finish.
      </p>
    );
  }

  return (
    <ul role="tree" aria-label="Repository files" className="space-y-0.5 p-2 text-xs">
      {nodes.map((node) => (
        <TreeItem
          key={node.path}
          node={node}
          depth={0}
          expanded={expanded}
          selectedPath={selectedPath}
          onToggleDir={toggleDir}
          onSelectFile={onSelectFile}
        />
      ))}
    </ul>
  );
}

interface TreeItemProps {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  selectedPath: string | null;
  onToggleDir: (dirPath: string) => void;
  onSelectFile: (path: string) => void;
}

function TreeItem({
  node,
  depth,
  expanded,
  selectedPath,
  onToggleDir,
  onSelectFile,
}: TreeItemProps) {
  const indentStyle = { paddingLeft: `${depth * 14 + 8}px` };

  if (node.type === "dir") {
    const isOpen = expanded.has(node.path);
    return (
      <li role="treeitem" aria-expanded={isOpen}>
        <button
          type="button"
          onClick={() => onToggleDir(node.path)}
          style={indentStyle}
          className="flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[var(--text)] hover:bg-[var(--surface-alt)]"
        >
          {isOpen ? (
            <>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--muted)]" aria-hidden="true" />
              <FolderOpen className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" aria-hidden="true" />
            </>
          ) : (
            <>
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--muted)]" aria-hidden="true" />
              <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" aria-hidden="true" />
            </>
          )}
          <span className="truncate font-medium">{node.name}</span>
        </button>
        {isOpen && node.children && node.children.length > 0 && (
          <ul role="group" className="space-y-0.5">
            {node.children.map((child) => (
              <TreeItem
                key={child.path}
                node={child}
                depth={depth + 1}
                expanded={expanded}
                selectedPath={selectedPath}
                onToggleDir={onToggleDir}
                onSelectFile={onSelectFile}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }

  const isSelected = selectedPath === node.path;
  return (
    <li role="treeitem" aria-selected={isSelected}>
      <button
        type="button"
        onClick={() => onSelectFile(node.path)}
        style={{ paddingLeft: `${depth * 14 + 26}px` }}
        className={
          isSelected
            ? "flex w-full items-center gap-1.5 rounded-md bg-[var(--accent)]/15 py-1 pr-2 text-left font-medium text-[var(--accent)]"
            : "flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[var(--muted)] hover:bg-[var(--surface-alt)] hover:text-[var(--text)]"
        }
      >
        <FileCode2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate font-mono">{node.name}</span>
      </button>
    </li>
  );
}
