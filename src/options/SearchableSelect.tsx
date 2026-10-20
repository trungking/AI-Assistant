import { useState, useEffect, useRef } from 'react';
import { Check, ChevronDown, Search, PlusCircle, X } from 'lucide-react';
import { clsx } from 'clsx';

interface SearchableSelectProps {
    value: string;
    options: string[];
    onChange: (value: string) => void;
    onCustomClick?: () => void;
    onOpen?: () => void;
    placeholder?: string;
}

export function SearchableSelect({ value, options, onChange, onCustomClick, onOpen, placeholder }: SearchableSelectProps) {
    const [isOpen, setIsOpen] = useState(false);
    const [search, setSearch] = useState('');
    const [highlighted, setHighlighted] = useState(0);
    const containerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    useEffect(() => {
        // Open unfiltered, with the current value highlighted
        setSearch('');
        if (isOpen && inputRef.current) {
            setHighlighted(Math.max(0, options.indexOf(value)));
            inputRef.current.focus();
        }
    }, [isOpen]);

    const filteredOptions = options.filter(option =>
        option.toLowerCase().includes(search.toLowerCase())
    );

    useEffect(() => {
        listRef.current?.querySelector<HTMLElement>(`[data-index="${highlighted}"]`)?.scrollIntoView({ block: 'nearest' });
    }, [highlighted, isOpen]);

    const close = (refocus = false) => {
        setIsOpen(false);
        if (refocus) buttonRef.current?.focus();
    };

    const select = (option: string) => {
        onChange(option);
        close(true);
    };

    const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
            e.preventDefault();
            close(true);
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (filteredOptions.length === 0) return;
            const step = e.key === 'ArrowDown' ? 1 : -1;
            setHighlighted(prev => (prev + step + filteredOptions.length) % filteredOptions.length);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const term = search.trim();
            // Exact match, else highlighted item, else the typed text as a custom model
            const exact = term
                ? filteredOptions.find(o => o === term) ?? filteredOptions.find(o => o.toLowerCase() === term.toLowerCase())
                : undefined;
            const picked = exact ?? filteredOptions[Math.min(highlighted, filteredOptions.length - 1)];
            if (picked !== undefined) select(picked);
            else if (term) select(term);
        }
    };

    return (
        <div
            className="relative"
            ref={containerRef}
            onBlur={(e) => {
                // Close when focus leaves the component (e.g. Tab away)
                if (!containerRef.current?.contains(e.relatedTarget as Node | null)) setIsOpen(false);
            }}
        >
            <button
                ref={buttonRef}
                onClick={() => {
                    const opening = !isOpen;
                    setIsOpen(opening);
                    if (opening && onOpen) onOpen();
                }}
                className="w-full px-3 py-2.5 text-sm bg-slate-50 dark:bg-gpt-input border border-slate-200 dark:border-gpt-hover rounded-lg focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-all dark:text-gpt-text flex items-center justify-between group"
            >
                <span className={clsx("truncate", !value && "text-slate-400 dark:text-slate-500")}>
                    {value || placeholder || 'Select...'}
                </span>
                <ChevronDown size={16} className="text-slate-400 group-hover:text-slate-600 dark:text-slate-500 dark:group-hover:text-slate-300 transition-colors" />
            </button>

            {isOpen && (
                <div
                    className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-gpt-sidebar border border-slate-200 dark:border-gpt-hover rounded-lg shadow-lg z-50 max-h-96 flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-100"
                    // Keep focus in the search box while clicking inside the dropdown
                    onMouseDown={(e) => { if (e.target !== inputRef.current) e.preventDefault(); }}
                >
                    <div className="p-2 border-b border-slate-100 dark:border-gpt-hover">
                        <div className="relative">
                            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                            <input
                                ref={inputRef}
                                type="text"
                                placeholder="Search..."
                                value={search}
                                onChange={(e) => { setSearch(e.target.value); setHighlighted(0); }}
                                className="w-full pl-8 pr-8 py-1.5 text-sm bg-slate-50 dark:bg-gpt-input border border-slate-200 dark:border-gpt-hover rounded-md focus:outline-none focus:border-blue-500 dark:focus:border-blue-500 text-slate-700 dark:text-gpt-text"
                                onClick={(e) => e.stopPropagation()}
                                onKeyDown={handleSearchKeyDown}
                            />
                            {search && (
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setSearch('');
                                        inputRef.current?.focus();
                                    }}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
                                    title="Clear search"
                                >
                                    <X size={14} />
                                </button>
                            )}
                        </div>
                    </div>

                    <div className="overflow-y-auto flex-1 p-1" ref={listRef}>
                        {filteredOptions.length === 0 ? (
                            <div className="px-3 py-8 text-center">
                                <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">No matching models found.</p>
                                {search.trim() && (
                                    <p className="text-xs text-blue-500 dark:text-blue-400">Press Enter to use "<span className="font-medium">{search.trim()}</span>" as custom model</p>
                                )}
                            </div>
                        ) : (
                            filteredOptions.map((option, index) => (
                                <button
                                    key={option}
                                    data-index={index}
                                    tabIndex={-1}
                                    onClick={() => select(option)}
                                    onMouseEnter={() => setHighlighted(index)}
                                    className={clsx(
                                        "w-full text-left px-3 py-2 text-sm rounded-md flex items-center justify-between transition-colors",
                                        value === option
                                            ? "bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 font-medium"
                                            : "text-slate-700 dark:text-gpt-text hover:bg-slate-50 dark:hover:bg-gpt-hover",
                                        index === highlighted && "ring-1 ring-inset ring-blue-400/60"
                                    )}
                                >
                                    <span className="truncate">{option}</span>
                                    {value === option && <Check size={14} />}
                                </button>
                            ))
                        )}
                    </div>

                    {onCustomClick && (
                        <div className="p-1 border-t border-slate-100 dark:border-gpt-hover bg-slate-50/50 dark:bg-gpt-hover/20">
                            <button
                                onClick={() => {
                                    onCustomClick();
                                    close();
                                }}
                                className="w-full px-3 py-2 text-xs font-medium text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-md transition-colors flex items-center justify-center gap-1.5"
                            >
                                <PlusCircle size={14} />
                                Enter Custom Model ID
                            </button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
