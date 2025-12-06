import { useState, useEffect } from 'react';

export function useTheme(theme: 'system' | 'light' | 'dark' = 'system') {
    const [isDark, setIsDark] = useState(() => {
        if (theme === 'dark') return true;
        if (theme === 'light') return false;
        return window.matchMedia('(prefers-color-scheme: dark)').matches;
    });

    useEffect(() => {
        if (theme === 'system') {
            const media = window.matchMedia('(prefers-color-scheme: dark)');
            const update = () => setIsDark(media.matches);

            // Initial check
            update();

            // Listen for changes
            media.addEventListener('change', update);
            return () => media.removeEventListener('change', update);
        } else {
            setIsDark(theme === 'dark');
        }
    }, [theme]);

    return isDark;
}
