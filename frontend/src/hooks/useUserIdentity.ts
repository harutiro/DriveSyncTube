import { useMemo } from 'react';

const STORAGE_KEY = 'drivesync-tube-user-id';

/**
 * LocalStorage でユーザー ID (UUID v4) を永続管理するカスタムフック。
 *
 * - 初回アクセス時に crypto.randomUUID() で生成し LocalStorage に保存
 * - 以降は保存済みの値を返す
 * - リロードやブラウザ再起動後も同一ユーザーとして識別可能
 */
export function useUserIdentity(): string {
  const userId = useMemo(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        return stored;
      }
    } catch (err) {
      // Private browsing 等で localStorage が使えない場合はフォールバック
      console.warn('[useUserIdentity] localStorage read failed:', err);
    }

    // crypto.randomUUID() は Secure Context (HTTPS / localhost) でのみ利用可能。
    // LAN IP の HTTP アクセスではフォールバックとして自前で UUID v4 を生成する。
    const newId =
      typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : (([1e7] as unknown as string) + -1e3 + -4e3 + -8e3 + -1e11).replace(
            /[018]/g,
            (c: string) =>
              (
                Number(c) ^
                (crypto.getRandomValues(new Uint8Array(1))[0] &
                  (15 >> (Number(c) / 4)))
              ).toString(16),
          );

    try {
      localStorage.setItem(STORAGE_KEY, newId);
    } catch (err) {
      console.warn('[useUserIdentity] localStorage write failed:', err);
    }

    return newId;
  }, []);

  return userId;
}
