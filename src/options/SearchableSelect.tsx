import { useState, useEffect, useRef } from 'react';
import { Check, ChevronDown, Search, PlusCircle } from 'lucide-react';
import { clsx } from 'clsx';

interface SearchableSelectProps {
    value: string;
    options: string[];
    onChange: (value: string) => void;
    onCustomClick?: () => void;
    placeholder?: string;
}

export function SearchableSelect({ value, options, onChange, onCustomClick, placeholder }: SearchableSelectProps) {
    const [isOpen, setIsOpen] = useState(false);
    const [search, setSearch] = useState('');
    const containerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

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
        if (isOpen && inputRef.current) {
            inputRef.current.focus();
        } else {
            setSearch('');
        }
    }, [isOpen]);

    const filteredOptions = options.filter(option =>
        option.toLowerCase().includes(search.toLowerCase())
    );

    return (
        <div className="relative" ref={containerRef}>
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="w-full px-3 py-2.5 text-sm bg-slate-50 dark:bg-gpt-input border border-slate-200 dark:border-gpt-hover rounded-lg focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-all dark:text-gpt-text flex items-center justify-between group"
            >
                <span className={clsx("truncate", !value && "text-slate-400 dark:text-slate-500")}>
                    {value || placeholder || 'Select...'}
                </span>
                <ChevronDown size={16} className="text-slate-400 group-hover:text-slate-600 dark:text-slate-500 dark:group-hover:text-slate-300 transition-colors" />
            </button>

            {isOpen && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-gpt-sidebar border border-slate-200 dark:border-gpt-hover rounded-lg shadow-lg z-50 max-h-96 flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-100">
                    <div className="p-2 border-b border-slate-100 dark:border-gpt-hover">
                        <div className="relative">
                            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                            <input
                                ref={inputRef}
                                type="text"
                                placeholder="Search..."
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                className="w-full pl-8 pr-3 py-1.5 text-sm bg-slate-50 dark:bg-gpt-input border border-slate-200 dark:border-gpt-hover rounded-md focus:outline-none focus:border-blue-500 dark:focus:border-blue-500 text-slate-700 dark:text-gpt-text"
                                onClick={(e) => e.stopPropagation()}
                            />
                        </div>
                    </div>

                    <div className="overflow-y-auto flex-1 p-1">
                        {filteredOptions.length === 0 ? (
                            <div className="px-3 py-8 text-center text-xs text-slate-500 dark:text-slate-400">
                                No matching models found.
                            </div>
                        ) : (
                            filteredOptions.map((option) => (
                                <button
                                    key={option}
                                    onClick={() => {
                                        onChange(option);
                                        setIsOpen(false);
                                    }}
                                    className={clsx(
                                        "w-full text-left px-3 py-2 text-sm rounded-md flex items-center justify-between transition-colors",
                                        value === option
                                            ? "bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 font-medium"
                                            : "text-slate-700 dark:text-gpt-text hover:bg-slate-50 dark:hover:bg-gpt-hover"
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
                                    setIsOpen(false);
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
