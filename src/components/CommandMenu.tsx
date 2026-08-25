import { useEffect, useState, useMemo, useRef } from "react";
import { Search } from "lucide-react";
import { ToolId, navGroups } from "../lib/navigation";
import { createPortal } from "react-dom";

interface CommandItem {
  id: string
  label: string
  category: string
  toolId: ToolId
  tabId?: string
}

interface CommandMenuProps {
  isOpen: boolean;
  onClose: () => void;
  onNavigate: (toolId: ToolId, tabId?: string) => void;
}

const allItems: CommandItem[] = [
  { id: "home", label: "首页", category: "导航", toolId: "home" },
  { id: "settings", label: "设置", category: "导航", toolId: "settings" },
  ...navGroups.flatMap(group => [
    { id: `${group.id}-group`, label: group.label, category: "工具", toolId: group.id },
    ...group.children.map(child => ({
      id: `${group.id}-${child.tabId}`,
      label: child.label,
      category: group.label,
      toolId: group.id,
      tabId: child.tabId,
    })),
  ]),
];

export function CommandMenu({ isOpen, onClose, onNavigate }: CommandMenuProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filteredItems = useMemo(() => {
    if (!query) return allItems;
    const lowerQuery = query.toLowerCase();
    return allItems.filter(item =>
      item.label.toLowerCase().includes(lowerQuery) ||
      item.category.toLowerCase().includes(lowerQuery)
    );
  }, [query]);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;

      if (e.key === 'Escape') {
        onClose();
        e.stopPropagation();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(i => Math.min(i + 1, filteredItems.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(i => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (filteredItems[selectedIndex]) {
          const item = filteredItems[selectedIndex];
          onNavigate(item.toolId, item.tabId);
          onClose();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose, filteredItems, selectedIndex, onNavigate]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [filteredItems]);

  useEffect(() => {
    if (listRef.current && isOpen) {
      const selectedElement = listRef.current.children[0]?.children[selectedIndex] as HTMLElement;
      if (selectedElement) {
        selectedElement.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [selectedIndex, isOpen]);

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh] px-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-xl bg-background border border-divider rounded-xl shadow-2xl overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-200">
        <div className="flex items-center px-4 border-b border-divider">
          <Search className="w-5 h-5 text-default-400" />
          <input
            ref={inputRef}
            className="flex-1 h-12 px-3 bg-transparent border-none outline-none text-foreground placeholder:text-default-400"
            placeholder="搜索工具…"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          <div className="text-xs text-default-400 border border-divider px-1.5 py-0.5 rounded">Esc</div>
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-2 scrollbar-hide" ref={listRef}>
          {filteredItems.length === 0 ? (
            <div className="p-8 text-center text-default-400 text-sm">
              未找到结果。
            </div>
          ) : (
            <ul className="space-y-1">
              {filteredItems.map((item, index) => (
                <li
                  key={item.id}
                  className={`flex items-center justify-between px-3 py-2.5 rounded-lg cursor-pointer text-sm transition-colors ${
                    index === selectedIndex ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-default-100'
                  }`}
                  onClick={() => {
                    onNavigate(item.toolId, item.tabId);
                    onClose();
                  }}
                  onMouseEnter={() => setSelectedIndex(index)}
                >
                  <div className="flex items-center gap-3">
                    <span className="font-medium">{item.label}</span>
                  </div>
                  <span className="text-xs text-default-400">{item.category}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="px-4 py-2 border-t border-divider bg-default-50 text-[10px] text-default-400 flex justify-between">
           <span>导航: ⇅</span>
           <span>选择: ↵</span>
        </div>
      </div>
    </div>,
    document.body
  );
}
