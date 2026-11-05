'use client';

import * as React from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Scissors,
  Search,
} from 'lucide-react';

import type { ExtractedFile } from '@/types/api';
import { cn, fileExtension } from '@/lib/utils';
import { formatNumber } from '@/lib/format';
import { Input } from '@/components/ui/input';
import { SimpleTooltip } from '@/components/ui/tooltip';

/* --------------------------------- daraxt --------------------------------- */

interface TreeFileNode {
  kind: 'file';
  name: string;
  path: string;
  file: ExtractedFile;
}

interface TreeDirNode {
  kind: 'dir';
  name: string;
  path: string;
  children: TreeNode[];
}

type TreeNode = TreeFileNode | TreeDirNode;

/** `extracted_files` ni papka daraxtiga aylantiradi (yo'l `/` bo'yicha bo'linadi). */
function buildTree(files: ExtractedFile[]): TreeNode[] {
  const root: TreeDirNode = { kind: 'dir', name: '', path: '', children: [] };

  for (const file of files) {
    const segments = file.path.split('/').filter((segment) => segment.length > 0);
    if (segments.length === 0) continue;

    let current = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i] ?? '';
      const dirPath = current.path.length > 0 ? `${current.path}/${segment}` : segment;
      let next = current.children.find(
        (child): child is TreeDirNode => child.kind === 'dir' && child.name === segment,
      );
      if (!next) {
        next = { kind: 'dir', name: segment, path: dirPath, children: [] };
        current.children.push(next);
      }
      current = next;
    }

    const name = segments[segments.length - 1] ?? file.path;
    current.children.push({ kind: 'file', name, path: file.path, file });
  }

  sortNodes(root.children);
  return root.children;
}

function sortNodes(nodes: TreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const node of nodes) {
    if (node.kind === 'dir') sortNodes(node.children);
  }
}

/** Barcha papka yo'llari — boshlanishida hammasi ochiq bo'ladi. */
function collectDirPaths(nodes: TreeNode[], acc: Set<string> = new Set()): Set<string> {
  for (const node of nodes) {
    if (node.kind === 'dir') {
      acc.add(node.path);
      collectDirPaths(node.children, acc);
    }
  }
  return acc;
}

/* -------------------------------- ikonkalar ------------------------------- */

const CODE_EXTENSIONS = new Set([
  'py',
  'js',
  'jsx',
  'ts',
  'tsx',
  'sql',
  'sh',
  'bash',
  'html',
  'css',
  'scss',
  'java',
  'c',
  'cpp',
  'go',
  'rb',
  'php',
]);

function FileIcon({ name }: { name: string }) {
  const extension = fileExtension(name);
  if (extension === 'json') return <FileJson className="size-3.5 shrink-0 text-accent" aria-hidden />;
  if (CODE_EXTENSIONS.has(extension))
    return <FileCode2 className="size-3.5 shrink-0 text-primary" aria-hidden />;
  return <FileText className="size-3.5 shrink-0 text-muted" aria-hidden />;
}

/* ------------------------------- komponent -------------------------------- */

export interface FileTreeSidebarProps {
  files: ExtractedFile[];
  activePath: string | null;
  onSelect: (path: string) => void;
  /** `submissions.extract_truncated` — umumiy limit oshgani. */
  extractTruncated?: boolean;
  /** AI dalil ko'rsatgan fayllar — daraxtda belgilanadi. */
  evidencePaths?: ReadonlySet<string>;
  className?: string;
}

/**
 * Chap panel: zipdan chiqarilgan fayllar daraxti.
 * `truncated` fayllar alohida belgilanadi (AUDIT.md §D6 — matn qirqilgan).
 */
export function FileTreeSidebar({
  files,
  activePath,
  onSelect,
  extractTruncated = false,
  evidencePaths,
  className,
}: FileTreeSidebarProps) {
  const [filter, setFilter] = React.useState('');

  const visibleFiles = React.useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle.length === 0) return files;
    return files.filter((file) => file.path.toLowerCase().includes(needle));
  }, [files, filter]);

  const tree = React.useMemo(() => buildTree(visibleFiles), [visibleFiles]);

  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(() => new Set<string>());

  // Filtr o'zgarganda natijalar ko'rinib turishi uchun hamma papka ochiladi.
  React.useEffect(() => {
    setCollapsed(new Set<string>());
  }, [filter]);

  const toggleDir = React.useCallback((path: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const allDirs = React.useMemo(() => collectDirPaths(tree), [tree]);

  return (
    <aside
      className={cn('flex min-h-0 flex-col border-border bg-surface/40', className)}
      aria-label="Topshirilgan fayllar"
    >
      <div className="flex flex-col gap-2 border-b border-border p-2.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">
            Fayllar · {files.length}
          </p>
          {extractTruncated ? (
            <SimpleTooltip content="Arxiv limitdan katta bo’lgani uchun matn qirqilgan (AUDIT §D6).">
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-accent">
                <Scissors className="size-3" aria-hidden />
                qirqilgan
              </span>
            </SimpleTooltip>
          ) : null}
        </div>
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted"
            aria-hidden
          />
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Fayl izlash…"
            aria-label="Fayl izlash"
            className="h-8 pl-8 text-xs"
          />
        </div>
      </div>

      {/* Native overflow: `min-h-0 flex-1` + max-h/flex ota bilan ham ishonchli scroll qiladi. */}
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        <div className="p-1.5">
          {files.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted">
              Arxivdan o’qiladigan fayl chiqmadi. Faylni yuklab olib tekshiring.
            </p>
          ) : tree.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted">Mos fayl topilmadi.</p>
          ) : (
            <TreeLevel
              nodes={tree}
              depth={0}
              activePath={activePath}
              onSelect={onSelect}
              collapsed={collapsed}
              onToggleDir={toggleDir}
              evidencePaths={evidencePaths}
            />
          )}
        </div>
      </div>

      {allDirs.size > 0 ? (
        <div className="border-t border-border p-2">
          <button
            type="button"
            className="rounded-lg px-2 py-1 text-[11px] font-medium text-muted transition-colors duration-150 hover:bg-fg/5 hover:text-fg"
            onClick={() => setCollapsed((current) => (current.size > 0 ? new Set() : allDirs))}
          >
            {collapsed.size > 0 ? 'Hammasini ochish' : 'Hammasini yopish'}
          </button>
        </div>
      ) : null}
    </aside>
  );
}

interface TreeLevelProps {
  nodes: TreeNode[];
  depth: number;
  activePath: string | null;
  onSelect: (path: string) => void;
  collapsed: ReadonlySet<string>;
  onToggleDir: (path: string) => void;
  evidencePaths?: ReadonlySet<string>;
}

function TreeLevel({
  nodes,
  depth,
  activePath,
  onSelect,
  collapsed,
  onToggleDir,
  evidencePaths,
}: TreeLevelProps) {
  return (
    <ul className="flex flex-col" role={depth === 0 ? 'tree' : 'group'}>
      {nodes.map((node) => {
        if (node.kind === 'dir') {
          const open = !collapsed.has(node.path);
          return (
            <li key={`dir:${node.path}`} role="none">
              <button
                type="button"
                onClick={() => onToggleDir(node.path)}
                aria-expanded={open}
                className="flex w-full items-center gap-1.5 rounded-lg py-1 pr-2 text-left text-xs text-fg transition-colors duration-150 hover:bg-fg/5"
                style={{ paddingLeft: `${depth * 12 + 6}px` }}
              >
                {open ? (
                  <ChevronDown className="size-3 shrink-0 text-muted" aria-hidden />
                ) : (
                  <ChevronRight className="size-3 shrink-0 text-muted" aria-hidden />
                )}
                {open ? (
                  <FolderOpen className="size-3.5 shrink-0 text-accent" aria-hidden />
                ) : (
                  <Folder className="size-3.5 shrink-0 text-accent" aria-hidden />
                )}
                <span className="truncate font-medium">{node.name}</span>
              </button>
              {open ? (
                <TreeLevel
                  nodes={node.children}
                  depth={depth + 1}
                  activePath={activePath}
                  onSelect={onSelect}
                  collapsed={collapsed}
                  onToggleDir={onToggleDir}
                  evidencePaths={evidencePaths}
                />
              ) : null}
            </li>
          );
        }

        const active = node.path === activePath;
        const flagged = evidencePaths?.has(node.path) ?? false;

        return (
          <li key={`file:${node.path}`} role="none">
            <button
              type="button"
              onClick={() => onSelect(node.path)}
              aria-current={active ? 'true' : undefined}
              className={cn(
                'flex w-full items-center gap-1.5 rounded-lg py-1 pr-2 text-left text-xs transition-colors duration-150',
                active ? 'bg-primary/10 text-primary' : 'text-fg hover:bg-fg/5',
              )}
              style={{ paddingLeft: `${depth * 12 + 18}px` }}
            >
              <FileIcon name={node.name} />
              <span className="min-w-0 flex-1 truncate">{node.name}</span>
              {flagged ? (
                <AlertTriangle className="size-3 shrink-0 text-danger" aria-hidden />
              ) : null}
              {node.file.truncated ? (
                <Scissors className="size-3 shrink-0 text-accent" aria-hidden />
              ) : null}
              <span className="shrink-0 text-[10px] tabular-nums text-muted">
                {formatNumber(node.file.content.length)}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
