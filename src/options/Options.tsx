import { useState, useEffect } from 'react';
import { type AppConfig, DEFAULT_CONFIG, type Provider, type PromptTemplate } from '../lib/types';
import { getStorage, setStorage } from '../lib/storage';
import { fetchModels } from '../lib/api';
import { useTheme } from '../lib/theme';
import { Trash2, Plus, RotateCcw, Eye, EyeOff, Key, MessageSquareText, Settings2, CheckCircle2, RefreshCw, List, Keyboard, Cpu, X, Download, Upload } from 'lucide-react';
import { SearchableSelect } from './SearchableSelect';
import { clsx } from 'clsx';


const Providers: Provider[] = ['openai', 'google', 'anthropic', 'openrouter'];

const ProviderDisplayNames: Record<Provider, string> = {
    openai: 'OpenAI',
    google: 'Google Gemini',
    anthropic: 'Anthropic',
    openrouter: 'OpenRouter'
};

export default function Options() {
    const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
    const [loading, setLoading] = useState(true);
    const [activeTab, setActiveTab] = useState<'general' | 'providers' | 'prompts' | 'hotkeys'>('general');
    const [showKey, setShowKey] = useState<Record<string, boolean>>({});
    const [savedToast, setSavedToast] = useState(false);
    const [fetchedModels, setFetchedModels] = useState<Record<string, string[]>>({});
    const [fetchingModels, setFetchingModels] = useState<Record<string, boolean>>({});
    const [isCustomModel, setIsCustomModel] = useState<Record<string, boolean>>({});
    const [recordingTarget, setRecordingTarget] = useState<string | null>(null);
    const [showAddProvider, setShowAddProvider] = useState(false);
    const [newProviderName, setNewProviderName] = useState('');
    const [newProviderUrl, setNewProviderUrl] = useState('');

    const allProviders = [...Providers, ...(config.customProviders || []).map(p => p.id)];

    const getProviderName = (id: string) => {
        if (id in ProviderDisplayNames) return ProviderDisplayNames[id as Provider];
        return config.customProviders?.find(p => p.id === id)?.name || id;
    };

    const isDark = useTheme(config.theme);
    useEffect(() => {
        document.documentElement.classList.toggle('dark', isDark);
    }, [isDark]);

    useEffect(() => {
        getStorage().then((data) => {
            if (!data.customProviders) data.customProviders = [];
            setConfig(data);
            setLoading(false);
        });
    }, []);

    const saveConfig = async (newConfig: AppConfig) => {
        setConfig(newConfig);
        await setStorage(newConfig);
        setSavedToast(true);
        setTimeout(() => setSavedToast(false), 2000);
    };

    const handleAddKey = (provider: Provider) => {
        const keyList = config.apiKeys[provider] || [];
        const keys = [...keyList, ''];
        saveConfig({ ...config, apiKeys: { ...config.apiKeys, [provider]: keys } });
    };

    const handleUpdateKey = (provider: Provider, index: number, value: string) => {
        const keys = [...config.apiKeys[provider]];
        keys[index] = value;
        saveConfig({ ...config, apiKeys: { ...config.apiKeys, [provider]: keys } });
    };

    const handleKeyBlur = (provider: Provider) => {
        if (config.apiKeys[provider]?.length > 0 && config.apiKeys[provider][0]) {
            handleFetchModels(provider, true);
        }
    };

    const handleRemoveKey = (provider: Provider, index: number) => {
        const keys = config.apiKeys[provider].filter((_, i) => i !== index);
        saveConfig({ ...config, apiKeys: { ...config.apiKeys, [provider]: keys } });
    };

    const toggleShowKey = (keyId: string) => {
        setShowKey(prev => ({ ...prev, [keyId]: !prev[keyId] }));
    };

    const handleAddCustomProvider = () => {
        if (!newProviderName || !newProviderUrl) return;

        const id = `custom-${Date.now()}`;
        const newProvider = { id, name: newProviderName, baseUrl: newProviderUrl };

        const newConfig = {
            ...config,
            customProviders: [...(config.customProviders || []), newProvider],
            apiKeys: { ...config.apiKeys, [id]: [] },
            customBaseUrls: { ...config.customBaseUrls, [id]: newProviderUrl },
            selectedModel: { ...config.selectedModel, [id]: '' }
        };

        saveConfig(newConfig);
        setShowAddProvider(false);
        setNewProviderName('');
        setNewProviderUrl('');
    };

    const handleDeleteCustomProvider = (id: string) => {
        if (!confirm('Delete this provider?')) return;
        const newCustoms = config.customProviders.filter(p => p.id !== id);
        const { [id]: _, ...restKeys } = config.apiKeys;
        const { [id]: __, ...restUrls } = config.customBaseUrls;
        const { [id]: ___, ...restModels } = config.selectedModel;

        saveConfig({
            ...config,
            customProviders: newCustoms,
            apiKeys: restKeys,
            customBaseUrls: restUrls,
            selectedModel: restModels,
            selectedProvider: config.selectedProvider === id ? 'openai' : config.selectedProvider
        });
    };

    const handleFetchModels = async (provider: Provider, silent = false) => {
        const keys = config.apiKeys[provider];
        if (!keys || keys.length === 0 || !keys[0]) {
            if (!silent) alert(`Please add a valid API key for ${ProviderDisplayNames[provider]} first.`);
            return;
        }

        setFetchingModels(prev => ({ ...prev, [provider]: true }));
        try {
            const models = await fetchModels(provider, keys[0], config.customBaseUrls[provider]);
            if (models.length > 0) {
                setFetchedModels(prev => ({ ...prev, [provider]: models }));
            } else {
                if (!silent) alert('No models found or provider does not support listing models.');
            }
        } catch (err: any) {
            if (!silent) alert(`Failed to fetch models: ${err.message}`);
        } finally {
            setFetchingModels(prev => ({ ...prev, [provider]: false }));
        }
    };

    const handleAddPrompt = () => {
        const newPrompt: PromptTemplate = {
            id: crypto.randomUUID(),
            name: 'New Prompt',
            content: '${text}'
        };
        saveConfig({ ...config, prompts: [...config.prompts, newPrompt] });
    };

    const handleUpdatePrompt = (index: number, field: keyof PromptTemplate, value: any) => {
        const prompts = [...config.prompts];
        prompts[index] = { ...prompts[index], [field]: value };
        saveConfig({ ...config, prompts });
    };

    const handleRemovePrompt = (index: number) => {
        const prompts = config.prompts.filter((_, i) => i !== index);
        saveConfig({ ...config, prompts });
    };

    const handleHotkeyKeyDown = (e: React.KeyboardEvent) => {
        e.preventDefault();
        if (!recordingTarget) return;

        const modifiers = [];
        if (e.ctrlKey) modifiers.push('ctrl');
        if (e.altKey) modifiers.push('alt');
        if (e.shiftKey) modifiers.push('shift');
        if (e.metaKey) modifiers.push('meta');

        const key = e.key.toLowerCase();

        // Ignore if only modifiers are pressed
        if (['control', 'alt', 'shift', 'meta'].includes(key)) return;

        const newHotkey = { key, modifiers };

        if (recordingTarget === 'global') {
            saveConfig({ ...config, customHotkey: newHotkey });
        } else {
            const promptIndex = config.prompts.findIndex(p => p.id === recordingTarget);
            if (promptIndex !== -1) {
                handleUpdatePrompt(promptIndex, 'hotkey', newHotkey);
            }
        }
        setRecordingTarget(null);
    };

    const handleExport = () => {
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(config, null, 2));
        const downloadAnchorNode = document.createElement('a');
        downloadAnchorNode.setAttribute("href", dataStr);
        downloadAnchorNode.setAttribute("download", "ai-assistant-settings.json");
        document.body.appendChild(downloadAnchorNode); // required for firefox
        downloadAnchorNode.click();
        downloadAnchorNode.remove();
    };

    const handleImport = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const content = e.target?.result as string;
                const importedConfig = JSON.parse(content);

                // Basic validation
                if (typeof importedConfig === 'object' && importedConfig !== null) {
                    // Start with default config to ensure all fields exist, then overwrite with imported data
                    // This handles cases where the imported config might be from an older version
                    const newConfig: AppConfig = {
                        ...DEFAULT_CONFIG,
                        ...importedConfig,
                        // Ensure nested objects are merged correctly if they are missing in import or partial
                        apiKeys: { ...DEFAULT_CONFIG.apiKeys, ...(importedConfig.apiKeys || {}) },
                        customBaseUrls: { ...DEFAULT_CONFIG.customBaseUrls, ...(importedConfig.customBaseUrls || {}) },
                        selectedModel: { ...DEFAULT_CONFIG.selectedModel, ...(importedConfig.selectedModel || {}) },
                        prompts: importedConfig.prompts || DEFAULT_CONFIG.prompts,
                        // Ensure arrays
                        customProviders: importedConfig.customProviders || [],
                    };

                    saveConfig(newConfig);
                    alert('Settings imported successfully!');
                } else {
                    throw new Error('Invalid settings file format');
                }
            } catch (error) {
                console.error('Import failed:', error);
                alert('Failed to import settings. valid JSON file?');
            }
        };
        reader.readAsText(file);
        // Reset input so same file can be selected again if needed
        event.target.value = '';
    };

    if (loading) return (
        <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-gpt-main text-slate-500 dark:text-gpt-secondary">
            <div className="flex flex-col items-center gap-3">
                <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
                <p className="text-sm font-medium">Loading settings...</p>
            </div>
        </div>
    );

    return (
        <div className="min-h-screen bg-slate-50 dark:bg-gpt-main font-sans text-slate-800 dark:text-gpt-text selection:bg-blue-100 selection:text-blue-900 pb-20">
            {/* Header */}
            <div className="bg-white dark:bg-gpt-sidebar border-b border-slate-200 dark:border-gpt-hover sticky top-0 z-10 shadow-sm">
                <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <img src="/icons/icon48.png" alt="Logo" className="w-10 h-10" />
                        <div>
                            <h1 className="text-xl font-bold text-slate-900 dark:text-gpt-text tracking-tight">AI Assistant</h1>
                            <p className="text-slate-500 dark:text-gpt-secondary text-xs font-medium">Extension Configuration</p>
                        </div>
                    </div>

                    <div className="flex gap-1 bg-slate-100 dark:bg-gpt-input p-1 rounded-lg border border-slate-200/60 dark:border-gpt-hover">
                        <button
                            onClick={() => setActiveTab('general')}
                            className={clsx(
                                "px-3 py-2 text-xs font-semibold rounded-md transition-all duration-200 flex items-center gap-1.5",
                                activeTab === 'general'
                                    ? "bg-white dark:bg-gpt-hover text-blue-600 dark:text-white shadow-sm ring-1 ring-slate-200 dark:ring-gpt-hover"
                                    : "text-slate-500 dark:text-gpt-secondary hover:text-slate-700 dark:hover:text-gpt-text hover:bg-slate-200/50 dark:hover:bg-gpt-hover"
                            )}
                        >
                            <Settings2 size={14} /> General
                        </button>
                        <button
                            onClick={() => setActiveTab('providers')}
                            className={clsx(
                                "px-3 py-2 text-xs font-semibold rounded-md transition-all duration-200 flex items-center gap-1.5",
                                activeTab === 'providers'
                                    ? "bg-white dark:bg-gpt-hover text-blue-600 dark:text-white shadow-sm ring-1 ring-slate-200 dark:ring-gpt-hover"
                                    : "text-slate-500 dark:text-gpt-secondary hover:text-slate-700 dark:hover:text-gpt-text hover:bg-slate-200/50 dark:hover:bg-gpt-hover"
                            )}
                        >
                            <Cpu size={14} /> Providers
                        </button>
                        <button
                            onClick={() => setActiveTab('prompts')}
                            className={clsx(
                                "px-3 py-2 text-xs font-semibold rounded-md transition-all duration-200 flex items-center gap-1.5",
                                activeTab === 'prompts'
                                    ? "bg-white dark:bg-gpt-hover text-blue-600 dark:text-white shadow-sm ring-1 ring-slate-200 dark:ring-gpt-hover"
                                    : "text-slate-500 dark:text-gpt-secondary hover:text-slate-700 dark:hover:text-gpt-text hover:bg-slate-200/50 dark:hover:bg-gpt-hover"
                            )}
                        >
                            <MessageSquareText size={14} /> Prompts
                        </button>
                        <button
                            onClick={() => setActiveTab('hotkeys')}
                            className={clsx(
                                "px-3 py-2 text-xs font-semibold rounded-md transition-all duration-200 flex items-center gap-1.5",
                                activeTab === 'hotkeys'
                                    ? "bg-white dark:bg-gpt-hover text-blue-600 dark:text-white shadow-sm ring-1 ring-slate-200 dark:ring-gpt-hover"
                                    : "text-slate-500 dark:text-gpt-secondary hover:text-slate-700 dark:hover:text-gpt-text hover:bg-slate-200/50 dark:hover:bg-gpt-hover"
                            )}
                        >
                            <Keyboard size={14} /> Hotkeys
                        </button>
                    </div>


                </div>
            </div>

            <div className="max-w-4xl mx-auto p-6 md:py-10">
                {/* Success Toast */}
                <div className={clsx(
                    "fixed bottom-6 right-6 bg-slate-900 dark:bg-gpt-sidebar text-white px-4 py-3 rounded-lg shadow-lg flex items-center gap-3 transition-all duration-300 transform z-50 border border-transparent dark:border-gpt-hover",
                    savedToast ? "translate-y-0 opacity-100" : "translate-y-10 opacity-0 pointer-events-none"
                )}>
                    <CheckCircle2 className="text-green-400" size={20} />
                    <span className="font-medium text-sm">Settings saved successfully</span>
                </div>

                {activeTab === 'general' && (
                    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">

                        <div className="bg-white dark:bg-gpt-sidebar rounded-2xl shadow-sm border border-slate-200 dark:border-gpt-hover p-6">
                            <h3 className="text-base font-bold text-slate-900 dark:text-gpt-text mb-4 flex items-center gap-2">
                                <div className="w-1 h-5 bg-blue-600 rounded-full"></div>
                                Appearance
                            </h3>
                            <div className="max-w-md">
                                <label className="block text-xs font-semibold text-slate-500 dark:text-gpt-secondary mb-1.5 uppercase tracking-wider">Theme</label>
                                <div className="relative">
                                    <select
                                        value={config.theme || 'system'}
                                        onChange={(e) => saveConfig({ ...config, theme: e.target.value as 'system' | 'light' | 'dark' })}
                                        className="w-full p-3 bg-slate-50 dark:bg-gpt-input border border-slate-200 dark:border-gpt-hover rounded-xl focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-all font-medium text-slate-700 dark:text-gpt-text appearance-none"
                                    >
                                        <option value="system">System Default</option>
                                        <option value="light">Light</option>
                                        <option value="dark">Dark</option>
                                    </select>
                                    <div className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none">
                                        <Settings2 size={16} />
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className="bg-white dark:bg-gpt-sidebar rounded-2xl shadow-sm border border-slate-200 dark:border-gpt-hover p-6">
                            <h3 className="text-base font-bold text-slate-900 dark:text-gpt-text mb-4 flex items-center gap-2">
                                <div className="w-1 h-5 bg-blue-600 rounded-full"></div>
                                Startup
                            </h3>
                            <div className="max-w-md">
                                <label className="block text-xs font-semibold text-slate-500 dark:text-gpt-secondary mb-1.5 uppercase tracking-wider">Startup Mode</label>
                                <div className="relative">
                                    <select
                                        value={config.popupMode || 'content_script'}
                                        onChange={(e) => saveConfig({ ...config, popupMode: e.target.value as 'extension' | 'content_script' })}
                                        className="w-full p-3 bg-slate-50 dark:bg-gpt-input border border-slate-200 dark:border-gpt-hover rounded-xl focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-all font-medium text-slate-700 dark:text-gpt-text appearance-none"
                                    >
                                        <option value="content_script">In-Page JS Popup (Default)</option>
                                        <option value="extension">Extension Popup</option>
                                    </select>
                                    <div className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none">
                                        <Settings2 size={16} />
                                    </div>
                                </div>
                                <p className="text-xs text-slate-400 dark:text-gpt-secondary mt-2">
                                    "In-Page JS Popup" renders within the page, allowing resizing and better interaction with page content.
                                </p>
                            </div>
                        </div>

                        <div className="bg-white dark:bg-gpt-sidebar rounded-2xl shadow-sm border border-slate-200 dark:border-gpt-hover p-6">
                            <h3 className="text-base font-bold text-slate-900 dark:text-gpt-text mb-4 flex items-center gap-2">
                                <div className="w-1 h-5 bg-blue-600 rounded-full"></div>
                                Backup & Restore
                            </h3>
                            <div className="flex flex-wrap gap-4">
                                <button
                                    onClick={handleExport}
                                    className="flex items-center gap-2 px-4 py-2.5 bg-slate-50 dark:bg-gpt-input hover:bg-slate-100 dark:hover:bg-gpt-hover text-slate-700 dark:text-gpt-text font-medium text-sm rounded-xl border border-slate-200 dark:border-gpt-hover transition-all"
                                >
                                    <Download size={16} className="text-blue-600 dark:text-blue-400" />
                                    Export Settings
                                </button>
                                <label className="cursor-pointer flex items-center gap-2 px-4 py-2.5 bg-slate-50 dark:bg-gpt-input hover:bg-slate-100 dark:hover:bg-gpt-hover text-slate-700 dark:text-gpt-text font-medium text-sm rounded-xl border border-slate-200 dark:border-gpt-hover transition-all">
                                    <Upload size={16} className="text-blue-600 dark:text-blue-400" />
                                    Import Settings
                                    <input
                                        type="file"
                                        className="hidden"
                                        accept=".json"
                                        onChange={handleImport}
                                    />
                                </label>
                            </div>
                            <p className="text-xs text-slate-400 dark:text-gpt-secondary mt-3">
                                Export your configuration to a JSON file or restore from a previous backup.
                            </p>
                        </div>
                    </div>
                )}

                {activeTab === 'providers' && (
                    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
                        {/* Default Provider Card */}
                        <div className="bg-white dark:bg-gpt-sidebar rounded-2xl shadow-sm border border-slate-200 dark:border-gpt-hover p-6">
                            <h3 className="text-base font-bold text-slate-900 dark:text-gpt-text mb-4 flex items-center gap-2">
                                <div className="w-1 h-5 bg-blue-600 rounded-full"></div>
                                Default Provider
                            </h3>
                            <div className="max-w-md">
                                <label className="block text-xs font-semibold text-slate-500 dark:text-gpt-secondary mb-1.5 uppercase tracking-wider">Select Provider</label>
                                <div className="relative">
                                    <select
                                        value={config.selectedProvider}
                                        onChange={(e) => saveConfig({ ...config, selectedProvider: e.target.value as Provider })}
                                        className="w-full p-3 bg-slate-50 dark:bg-gpt-input border border-slate-200 dark:border-gpt-hover rounded-xl focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-all font-medium text-slate-700 dark:text-gpt-text appearance-none"
                                    >
                                        {allProviders.map(p => <option key={p} value={p}>{getProviderName(p)}</option>)}
                                    </select>
                                    <div className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none">
                                        <Settings2 size={16} />
                                    </div>
                                </div>
                                <p className="text-xs text-slate-400 dark:text-gpt-secondary mt-2">This provider will be selected by default when you open the popup.</p>
                            </div>
                        </div>

                        <div className="bg-blue-50 dark:bg-blue-900/10 border border-blue-100 dark:border-blue-900/50 rounded-xl p-4 flex gap-3">
                            <div className="text-blue-600 dark:text-blue-400 mt-0.5"><Cpu size={18} /></div>
                            <div className="text-sm text-blue-900 dark:text-blue-300">
                                <p className="font-semibold mb-1">Configure AI Providers</p>
                                <p className="opacity-80">Add your API keys below. You can also add custom OpenAI-compatible providers.</p>
                            </div>
                        </div>

                        {/* Add Custom Provider Modal */}
                        {showAddProvider && (
                            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/20 backdrop-blur-sm">
                                <div className="bg-white dark:bg-gpt-sidebar rounded-2xl shadow-xl w-full max-w-md p-6 border border-slate-200 dark:border-gpt-hover animate-in fade-in zoom-in-95 duration-200">
                                    <div className="flex justify-between items-center mb-4">
                                        <h3 className="font-bold text-lg text-slate-900 dark:text-gpt-text">Add Custom Provider</h3>
                                        <button onClick={() => setShowAddProvider(false)} className="text-slate-400 hover:text-slate-600"><X size={20} /></button>
                                    </div>
                                    <div className="space-y-4">
                                        <div>
                                            <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Provider Name</label>
                                            <input
                                                type="text"
                                                value={newProviderName}
                                                onChange={e => setNewProviderName(e.target.value)}
                                                className="w-full p-2.5 rounded-lg border dark:bg-gpt-input dark:border-gpt-hover dark:text-gpt-text"
                                                placeholder="e.g. Local LLM"
                                            />
                                        </div>
                                        <div>
                                            <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Base URL</label>
                                            <input
                                                type="text"
                                                value={newProviderUrl}
                                                onChange={e => setNewProviderUrl(e.target.value)}
                                                className="w-full p-2.5 rounded-lg border dark:bg-gpt-input dark:border-gpt-hover dark:text-gpt-text"
                                                placeholder="https://api.example.com/v1"
                                            />
                                        </div>
                                        <div className="flex justify-end gap-2 pt-2">
                                            <button onClick={() => setShowAddProvider(false)} className="px-4 py-2 text-sm text-slate-600">Cancel</button>
                                            <button
                                                onClick={handleAddCustomProvider}
                                                className="px-4 py-2 bg-blue-600 text-white text-sm font-bold rounded-lg hover:bg-blue-700"
                                                disabled={!newProviderName || !newProviderUrl}
                                            >
                                                Add Provider
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* API Configuration Grid */}
                        <div className="grid grid-cols-1 gap-6">
                            {allProviders.map((provider) => (
                                <div key={provider} className="bg-white dark:bg-gpt-sidebar rounded-2xl shadow-sm border border-slate-200 dark:border-gpt-hover transition-all hover:shadow-md duration-300">
                                    <div className="px-6 py-4 border-b border-slate-100 dark:border-gpt-hover bg-slate-50/50 dark:bg-gpt-hover/20 flex items-center justify-between rounded-t-2xl">
                                        <h3 className="font-bold text-slate-800 dark:text-gpt-text flex items-center gap-2">
                                            {getProviderName(provider)}
                                        </h3>
                                        <div className="flex gap-2">
                                            {config.customProviders?.some(p => p.id === provider) && (
                                                <button
                                                    onClick={() => handleDeleteCustomProvider(provider)}
                                                    className="text-xs text-red-500 hover:bg-red-50 px-2 py-1 rounded border border-transparent hover:border-red-100 transition-all flex items-center gap-1"
                                                >
                                                    <Trash2 size={12} /> Delete
                                                </button>
                                            )}
                                            <button
                                                onClick={() => handleAddKey(provider)}
                                                className="text-xs font-semibold bg-white dark:bg-gpt-input text-blue-600 dark:text-blue-400 border border-blue-100 dark:border-gpt-hover px-3 py-1.5 rounded-lg hover:bg-blue-50 dark:hover:bg-gpt-hover hover:border-blue-200 transition-colors flex items-center gap-1.5 shadow-sm"
                                            >
                                                <Plus size={14} /> Add Key
                                            </button>
                                        </div>
                                    </div>

                                    <div className="p-6 space-y-6">
                                        {/* Model & Base URL */}
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                                            <div>
                                                <div className="flex items-center justify-between mb-1.5">
                                                    <label className="block text-xs font-bold text-slate-500 dark:text-gpt-secondary uppercase tracking-wider">Model ID</label>
                                                    {provider !== 'anthropic' && (
                                                        <button
                                                            onClick={() => handleFetchModels(provider)}
                                                            className="text-[10px] font-semibold text-blue-600 dark:text-blue-400 hover:text-blue-700 flex items-center gap-1 bg-blue-50 dark:bg-gpt-hover px-2 py-0.5 rounded hover:bg-blue-100 transition-colors"
                                                            disabled={fetchingModels[provider]}
                                                        >
                                                            {fetchingModels[provider] ? <RefreshCw size={10} className="animate-spin" /> : <List size={10} />}
                                                            {fetchingModels[provider] ? 'Loading...' : 'Refresh List'}
                                                        </button>
                                                    )}
                                                </div>
                                                <div className="relative">
                                                    {fetchedModels[provider]?.length > 0 && !isCustomModel[provider] ? (
                                                        <SearchableSelect
                                                            value={config.selectedModel[provider]}
                                                            options={fetchedModels[provider]}
                                                            onChange={(value) => saveConfig({
                                                                ...config,
                                                                selectedModel: { ...config.selectedModel, [provider]: value }
                                                            })}
                                                            onCustomClick={() => setIsCustomModel(prev => ({ ...prev, [provider]: true }))}
                                                            placeholder="Select a model..."
                                                        />
                                                    ) : (
                                                        <div className="relative">
                                                            <input
                                                                type="text"
                                                                placeholder="e.g. gpt-4, gemini-pro"
                                                                value={config.selectedModel[provider]}
                                                                onChange={(e) => saveConfig({
                                                                    ...config,
                                                                    selectedModel: { ...config.selectedModel, [provider]: e.target.value }
                                                                })}
                                                                className="w-full px-3 py-2.5 text-sm bg-slate-50 dark:bg-gpt-input border border-slate-200 dark:border-gpt-hover rounded-lg focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-all dark:text-gpt-text"
                                                            />
                                                            {fetchedModels[provider]?.length > 0 && (
                                                                <button
                                                                    onClick={() => setIsCustomModel(prev => ({ ...prev, [provider]: false }))}
                                                                    className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-blue-600 hover:text-blue-700 font-medium px-2 py-1 bg-blue-50 rounded"
                                                                >
                                                                    Back to List
                                                                </button>
                                                            )}
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                            <div>
                                                <label className="block text-xs font-bold text-slate-500 dark:text-gpt-secondary mb-1.5 uppercase tracking-wider">Base URL <span className="text-slate-300 dark:text-gpt-hover font-normal lowercase">(optional)</span></label>
                                                <input
                                                    type="text"
                                                    placeholder="Default"
                                                    value={config.customBaseUrls[provider]}
                                                    onChange={(e) => saveConfig({
                                                        ...config,
                                                        customBaseUrls: { ...config.customBaseUrls, [provider]: e.target.value }
                                                    })}
                                                    className="w-full px-3 py-2.5 text-sm bg-slate-50 dark:bg-gpt-input border border-slate-200 dark:border-gpt-hover rounded-lg focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-all placeholder:text-slate-300 dark:placeholder:text-gpt-hover dark:text-gpt-text"
                                                />
                                            </div>
                                        </div>

                                        {/* Keys List */}
                                        <div className="space-y-3">
                                            <label className="block text-xs font-bold text-slate-500 dark:text-gpt-secondary uppercase tracking-wider">API Keys</label>
                                            {config.apiKeys[provider].length === 0 && (
                                                <div className="text-sm text-slate-400 italic bg-slate-50 dark:bg-gpt-input p-4 rounded-lg border border-slate-100 dark:border-gpt-hover text-center">
                                                    No API keys configured for {getProviderName(provider)}.
                                                </div>
                                            )}
                                            {config.apiKeys[provider].map((key, idx) => (
                                                <div key={idx} className="flex items-center gap-2 group">
                                                    <div className="relative flex-1">
                                                        <div className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none">
                                                            <Key size={14} />
                                                        </div>
                                                        <input
                                                            type={showKey[`${provider}-${idx}`] ? "text" : "password"}
                                                            value={key}
                                                            onChange={(e) => handleUpdateKey(provider, idx, e.target.value)}
                                                            onBlur={() => handleKeyBlur(provider)}
                                                            placeholder={`Enter ${getProviderName(provider)} API Key`}
                                                            className="w-full pl-9 pr-10 py-2.5 text-sm font-mono bg-white dark:bg-gpt-input border border-slate-200 dark:border-gpt-hover rounded-lg focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-all shadow-sm group-hover:border-slate-300 dark:group-hover:border-gpt-text dark:text-gpt-text"
                                                        />
                                                        <button
                                                            onClick={() => toggleShowKey(`${provider}-${idx}`)}
                                                            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors"
                                                            tabIndex={-1}
                                                        >
                                                            {showKey[`${provider}-${idx}`] ? <EyeOff size={14} /> : <Eye size={14} />}
                                                        </button>
                                                    </div>
                                                    <button
                                                        onClick={() => handleRemoveKey(provider, idx)}
                                                        className="p-2.5 text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-all duration-200 opacity-0 group-hover:opacity-100 focus:opacity-100"
                                                        title="Remove key"
                                                    >
                                                        <Trash2 size={16} />
                                                    </button>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            ))}

                            {/* Add Custom Provider Button Card */}
                            <button
                                onClick={() => setShowAddProvider(true)}
                                className="group relative w-full border-2 border-dashed border-slate-200 dark:border-gpt-hover rounded-2xl p-6 flex flex-col items-center justify-center gap-3 hover:border-blue-400 dark:hover:border-blue-500 hover:bg-blue-50/50 dark:hover:bg-blue-900/10 transition-all duration-200"
                            >
                                <div className="p-3 bg-white dark:bg-gpt-input rounded-full shadow-sm text-blue-600 dark:text-blue-400 group-hover:scale-110 transition-transform duration-200">
                                    <Plus size={24} />
                                </div>
                                <div className="text-center">
                                    <h3 className="text-sm font-bold text-slate-900 dark:text-gpt-text">Add Custom Provider</h3>
                                    <p className="text-xs text-slate-500 dark:text-gpt-secondary mt-1">Connect to any OpenAI-compatible API</p>
                                </div>
                            </button>
                        </div>
                    </div>
                )}

                {activeTab === 'prompts' && (
                    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
                        <div className="flex justify-between items-end">
                            <div>
                                <h2 className="text-lg font-bold text-slate-900 dark:text-gpt-text">Prompt Templates</h2>
                                <p className="text-slate-500 dark:text-gpt-secondary text-sm mt-1">Customize the quick actions available in the popup.</p>
                            </div>
                            <button
                                onClick={handleAddPrompt}
                                className="px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 hover:shadow-lg hover:shadow-blue-500/30 transition-all duration-200 flex items-center gap-2"
                            >
                                <Plus size={18} /> New Prompt
                            </button>
                        </div>

                        <div className="grid grid-cols-1 gap-4">
                            {config.prompts.map((prompt, idx) => (
                                <div key={prompt.id} className="group bg-white dark:bg-gpt-sidebar border border-slate-200 dark:border-gpt-hover rounded-2xl p-5 shadow-sm hover:shadow-md hover:border-blue-200 dark:hover:border-blue-800 transition-all duration-300 relative overflow-hidden">
                                    <div className="absolute top-0 left-0 w-1 h-full bg-blue-500 opacity-0 group-hover:opacity-100 transition-opacity"></div>

                                    <div className="flex flex-col gap-3 mb-4">
                                        <div className="flex justify-between items-start gap-4">
                                            <div className="flex-1">
                                                <label className="block text-xs font-bold text-slate-400 dark:text-gpt-secondary mb-1 uppercase tracking-wider">Name</label>
                                                <input
                                                    type="text"
                                                    value={prompt.name}
                                                    onChange={(e) => handleUpdatePrompt(idx, 'name', e.target.value)}
                                                    className="text-base font-bold text-slate-900 dark:text-gpt-text bg-transparent border-b border-transparent hover:border-slate-300 dark:hover:border-gpt-hover focus:border-blue-500 outline-none px-0 py-1 transition-colors w-full"
                                                    placeholder="Prompt Name"
                                                />
                                            </div>
                                            <button
                                                onClick={() => handleRemovePrompt(idx)}
                                                className="text-slate-300 hover:text-red-500 p-2 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 transition-all"
                                                title="Delete Prompt"
                                            >
                                                <Trash2 size={18} />
                                            </button>
                                        </div>

                                        <div className="flex flex-wrap items-center gap-6">
                                            <div className="flex items-center gap-4">
                                                <label className="flex items-center gap-2 cursor-pointer group/checkbox">
                                                    <div className="relative">
                                                        <input
                                                            type="checkbox"
                                                            checked={!!prompt.onlyImage}
                                                            onChange={(e) => handleUpdatePrompt(idx, 'onlyImage', e.target.checked)}
                                                            className="sr-only peer"
                                                        />
                                                        <div className="w-9 h-5 bg-slate-200 dark:bg-gpt-input peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-purple-600"></div>
                                                    </div>
                                                    <span className="text-xs font-medium text-slate-500 dark:text-gpt-secondary group-hover/checkbox:text-slate-700 dark:group-hover/checkbox:text-gpt-text">Only Image</span>
                                                </label>
                                                <label className="flex items-center gap-2 cursor-pointer group/checkbox">
                                                    <div className="relative">
                                                        <input
                                                            type="checkbox"
                                                            checked={!!prompt.immediate}
                                                            onChange={(e) => handleUpdatePrompt(idx, 'immediate', e.target.checked)}
                                                            className="sr-only peer"
                                                        />
                                                        <div className="w-9 h-5 bg-slate-200 dark:bg-gpt-input peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600"></div>
                                                    </div>
                                                    <span className="text-xs font-medium text-slate-500 dark:text-gpt-secondary group-hover/checkbox:text-slate-700 dark:group-hover/checkbox:text-gpt-text">Instant Submit</span>
                                                </label>
                                            </div>

                                            {/* Prompt Hotkey Recorder */}
                                            <div className="flex items-center gap-2">
                                                <span className="text-xs font-bold text-slate-400 dark:text-gpt-secondary uppercase tracking-wider">Hotkey:</span>
                                                <div
                                                    className={clsx(
                                                        "h-8 px-3 flex items-center justify-center border rounded-lg text-xs font-mono font-medium cursor-pointer transition-all select-none min-w-[100px]",
                                                        recordingTarget === prompt.id
                                                            ? "border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 ring-2 ring-blue-500/20"
                                                            : "border-slate-200 dark:border-gpt-hover bg-slate-50 dark:bg-gpt-input text-slate-700 dark:text-gpt-text hover:border-slate-300 dark:hover:border-gpt-text"
                                                    )}
                                                    onClick={() => setRecordingTarget(prompt.id)}
                                                    onKeyDown={handleHotkeyKeyDown}
                                                    tabIndex={0}
                                                    onBlur={() => setRecordingTarget(null)}
                                                    title="Click to record hotkey"
                                                >
                                                    {recordingTarget === prompt.id ? (
                                                        <span className="animate-pulse">Press keys...</span>
                                                    ) : prompt.hotkey ? (
                                                        <div className="flex items-center gap-1">
                                                            {prompt.hotkey.modifiers.map(m => (
                                                                <span key={m} className="capitalize">{m}+</span>
                                                            ))}
                                                            <span className="capitalize">{prompt.hotkey.key}</span>
                                                        </div>
                                                    ) : (
                                                        <span className="text-slate-400 italic">None</span>
                                                    )}
                                                </div>
                                                {prompt.hotkey && (
                                                    <button
                                                        onClick={() => handleUpdatePrompt(idx, 'hotkey', null)}
                                                        className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
                                                        title="Clear hotkey"
                                                    >
                                                        <Trash2 size={14} />
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    </div>

                                    <div>
                                        <label className="block text-xs font-bold text-slate-400 dark:text-gpt-secondary mb-1.5 uppercase tracking-wider">Template Content</label>
                                        <textarea
                                            value={prompt.content}
                                            onChange={(e) => handleUpdatePrompt(idx, 'content', e.target.value)}
                                            className="w-full text-sm text-slate-600 dark:text-gpt-text bg-slate-50 dark:bg-gpt-input border border-slate-200 dark:border-gpt-hover rounded-xl p-3 focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none min-h-[80px] resize-y transition-all font-mono"
                                            placeholder="Prompt content..."
                                        />
                                        <p className="text-xs text-slate-400 dark:text-gpt-secondary mt-2 flex items-center gap-1.5">
                                            <span className="bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 px-1.5 py-0.5 rounded border border-blue-100 dark:border-blue-800 font-mono text-[10px]">{`\${text}`}</span>
                                            will be replaced by your selected text.
                                        </p>
                                    </div>
                                </div>
                            ))}
                        </div>

                        <div className="flex justify-center pt-8 border-t border-slate-200 border-dashed dark:border-gpt-hover">
                            <button
                                onClick={() => {
                                    if (confirm('Are you sure you want to reset all prompts to default?')) {
                                        saveConfig({ ...config, prompts: DEFAULT_CONFIG.prompts })
                                    }
                                }}
                                className="text-sm text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 px-4 py-2 rounded-lg transition-all flex items-center gap-2"
                            >
                                <RotateCcw size={14} /> Reset Defaults
                            </button>
                        </div>
                    </div>
                )}

                {activeTab === 'hotkeys' && (
                    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
                        <div className="bg-white dark:bg-gpt-sidebar rounded-2xl shadow-sm border border-slate-200 dark:border-gpt-hover p-6">
                            <h3 className="text-lg font-bold text-slate-900 dark:text-gpt-text mb-2">Global Shortcut</h3>
                            <p className="text-sm text-slate-500 dark:text-gpt-secondary mb-6">
                                Define a keyboard shortcut to trigger the extension on any page.
                                Click the input box below and press your desired key combination.
                            </p>

                            <div className="max-w-md">
                                <label className="block text-xs font-bold text-slate-500 dark:text-gpt-secondary mb-2 uppercase tracking-wider">Shortcut</label>
                                <div
                                    className={clsx(
                                        "w-full h-14 flex items-center justify-center border-2 rounded-xl text-lg font-mono font-medium cursor-pointer transition-all select-none",
                                        recordingTarget === 'global'
                                            ? "border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 shadow-[0_0_0_4px_rgba(59,130,246,0.1)]"
                                            : "border-slate-200 dark:border-gpt-hover bg-slate-50 dark:bg-gpt-input text-slate-700 dark:text-gpt-text hover:border-slate-300 dark:hover:border-gpt-text hover:bg-white dark:hover:bg-gpt-hover"
                                    )}
                                    onClick={() => setRecordingTarget('global')}
                                    onKeyDown={handleHotkeyKeyDown}
                                    tabIndex={0}
                                    onBlur={() => setRecordingTarget(null)}
                                >
                                    {recordingTarget === 'global' ? (
                                        <span className="animate-pulse">Press keys...</span>
                                    ) : config.customHotkey ? (
                                        <div className="flex items-center gap-2">
                                            {config.customHotkey.modifiers.map(m => (
                                                <kbd key={m} className="px-2 py-1 bg-white dark:bg-gpt-sidebar border border-slate-300 dark:border-gpt-hover rounded-md text-sm shadow-sm uppercase">{m}</kbd>
                                            ))}
                                            <span className="text-slate-400">+</span>
                                            <kbd className="px-2 py-1 bg-white dark:bg-gpt-sidebar border border-slate-300 dark:border-gpt-hover rounded-md text-sm shadow-sm uppercase">{config.customHotkey.key}</kbd>
                                        </div>
                                    ) : (
                                        <span className="text-slate-400 italic">Click to set (e.g. Ctrl+Shift+Y)</span>
                                    )}
                                </div>
                                {config.customHotkey && (
                                    <div className="flex justify-end mt-2">
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                saveConfig({ ...config, customHotkey: null });
                                            }}
                                            className="text-xs text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 px-2 py-1 rounded transition-colors"
                                        >
                                            Clear Shortcut
                                        </button>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Screen Crop Hotkey */}
                        <div className="bg-white dark:bg-gpt-sidebar rounded-2xl shadow-sm border border-slate-200 dark:border-gpt-hover p-6">
                            <h3 className="text-lg font-bold text-slate-900 dark:text-gpt-text mb-2">Screen Crop Shortcut</h3>
                            <p className="text-sm text-slate-500 dark:text-gpt-secondary mb-6">
                                Define a keyboard shortcut to capture a region of the screen and attach it to the chat.
                            </p>

                            <div className="max-w-md">
                                <label className="block text-xs font-bold text-slate-500 dark:text-gpt-secondary mb-2 uppercase tracking-wider">Shortcut</label>
                                <div
                                    className={clsx(
                                        "w-full h-14 flex items-center justify-center border-2 rounded-xl text-lg font-mono font-medium cursor-pointer transition-all select-none",
                                        recordingTarget === 'crop'
                                            ? "border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 shadow-[0_0_0_4px_rgba(59,130,246,0.1)]"
                                            : "border-slate-200 dark:border-gpt-hover bg-slate-50 dark:bg-gpt-input text-slate-700 dark:text-gpt-text hover:border-slate-300 dark:hover:border-gpt-text hover:bg-white dark:hover:bg-gpt-hover"
                                    )}
                                    onClick={() => setRecordingTarget('crop')}
                                    onKeyDown={(e) => {
                                        e.preventDefault();
                                        if (recordingTarget !== 'crop') return;

                                        const modifiers = [];
                                        if (e.ctrlKey) modifiers.push('ctrl');
                                        if (e.altKey) modifiers.push('alt');
                                        if (e.shiftKey) modifiers.push('shift');
                                        if (e.metaKey) modifiers.push('meta');

                                        const key = e.key.toLowerCase();
                                        if (['control', 'alt', 'shift', 'meta'].includes(key)) return;

                                        saveConfig({ ...config, cropHotkey: { key, modifiers } });
                                        setRecordingTarget(null);
                                    }}
                                    tabIndex={0}
                                    onBlur={() => setRecordingTarget(null)}
                                >
                                    {recordingTarget === 'crop' ? (
                                        <span className="animate-pulse">Press keys...</span>
                                    ) : config.cropHotkey ? (
                                        <div className="flex items-center gap-2">
                                            {config.cropHotkey.modifiers.map(m => (
                                                <kbd key={m} className="px-2 py-1 bg-white dark:bg-gpt-sidebar border border-slate-300 dark:border-gpt-hover rounded-md text-sm shadow-sm uppercase">{m}</kbd>
                                            ))}
                                            <span className="text-slate-400">+</span>
                                            <kbd className="px-2 py-1 bg-white dark:bg-gpt-sidebar border border-slate-300 dark:border-gpt-hover rounded-md text-sm shadow-sm uppercase">{config.cropHotkey.key}</kbd>
                                        </div>
                                    ) : (
                                        <span className="text-slate-400 italic">Click to set (e.g. Ctrl+Shift+S)</span>
                                    )}
                                </div>
                                {config.cropHotkey && (
                                    <div className="flex justify-end mt-2">
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                saveConfig({ ...config, cropHotkey: null });
                                            }}
                                            className="text-xs text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 px-2 py-1 rounded transition-colors"
                                        >
                                            Clear Shortcut
                                        </button>
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-100 dark:border-amber-800 rounded-xl p-4 flex gap-3">
                            <div className="text-amber-500 shrink-0 mt-0.5">
                                <Keyboard size={20} />
                            </div>
                            <div className="text-sm text-amber-800 dark:text-amber-300">
                                <p className="font-bold mb-1">Note regarding shortcuts</p>
                                <p className="leading-relaxed">
                                    Browser-reserved shortcuts (like Ctrl+T, Ctrl+N) cannot be overridden.
                                    If a shortcut doesn't work, try adding Shift or Alt modifiers.
                                    You may need to refresh open tabs for the new shortcut to take effect.
                                </p>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}