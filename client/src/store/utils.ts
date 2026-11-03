import { atom } from 'recoil';

// Improved helper function to create atoms with localStorage
export function atomWithLocalStorage<T>(
  key: string,
  defaultValue: T,
  normalizeSavedValue: (value: T) => T = (value) => value,
) {
  return atom<T>({
    key,
    default: defaultValue,
    effects_UNSTABLE: [
      ({ setSelf, onSet }) => {
        /**
         * The default is captured when the module is evaluated, which can be
         * long before anything subscribes — a login screen resized before the
         * app mounts, for instance. Every path that falls back to it re-checks
         * that assumption here. A caller without a normalizer gets the identity
         * function, so this is inert for them.
         */
        const resolveDefault = () => normalizeSavedValue(defaultValue);
        let savedValue: string | null = null;
        try {
          savedValue = localStorage.getItem(key);
        } catch {
          // Storage can be unavailable in private browsing or restricted embeds.
        }

        if (savedValue === null) {
          const normalizedDefault = resolveDefault();
          if (!Object.is(normalizedDefault, defaultValue)) {
            setSelf(normalizedDefault);
          }
        }
        if (savedValue !== null) {
          try {
            const parsedValue = JSON.parse(savedValue) as T;
            const normalizedValue = normalizeSavedValue(parsedValue);
            if (!Object.is(normalizedValue, parsedValue)) {
              try {
                localStorage.setItem(key, JSON.stringify(normalizedValue));
              } catch {
                // Keep the in-memory value when storage is unavailable.
              }
            }
            setSelf(normalizedValue);
          } catch (e) {
            console.error(
              `Error parsing localStorage key "${key}", \`savedValue\`: defaultValue, error:`,
              e,
            );
            /** The stored value is unusable, so the normalized default replaces it. */
            const normalizedDefault = resolveDefault();
            try {
              localStorage.setItem(key, JSON.stringify(normalizedDefault));
            } catch {
              // Keep the in-memory default when storage is unavailable.
            }
            setSelf(normalizedDefault);
          }
        }

        onSet((newValue: T) => {
          try {
            localStorage.setItem(key, JSON.stringify(newValue));
          } catch {
            // Keep the in-memory value when storage is unavailable.
          }
        });
      },
    ],
  });
}
