/**
 * The extension's manifest, written into the build by `vite.config.ts`.
 *
 * - `key` is the public half of the extension's key: it fixes the id, so the server can let
 *   exactly this extension's pages in (`CHROME_EXTENSION_ID` in `shared/src/chrome.ts`). A test
 *   checks that the two agree.
 * - No site is reachable at install. The person's own server, and each site a bot may read, are
 *   asked for one at a time with Chrome's own prompt (`optional_host_permissions`).
 * - `tabs` lists the address and title of the open tabs for the bots; `scripting` reads the text
 *   of a page the person allowed.
 */
export const EXTENSION_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEApiYww+7DNO/8rSZLXuHCFHjsuEFupdrdwH2KhWToCP/K020D9WpbZOxss5ewBWPNfvTe2eG10plYQ0z3stW3iVuWMJ0hzIAipgPAjXAJlREzCmpDuNuGFaBpzPYOL61/FRrHu0syG9U9chWO/DRZ9H1Po1HHiaaMlX+KUFm7OC8BfUyM30JRgcv8TgjFvDeao1enDUuhXxOMZHZ9NvhQd6ANnCQjHHWtBbH/XX9iag1PyO1Yqrh/RaQMlKmEKvcy428PBYvLUyOpv+Yyt/53Vh5JI6QxhlOSEFztccvkr2ySXJGbJLQbSF+M6P0Y+McT41kqDGfmMgcFGE2BWARlWwIDAQAB';

export function manifest(version: string) {
  return {
    manifest_version: 3,
    name: '__MSG_name__',
    description: '__MSG_description__',
    default_locale: 'en',
    version,
    minimum_chrome_version: '116',
    key: EXTENSION_KEY,
    icons: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
    action: {
      default_title: '__MSG_open__',
      default_icon: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' },
    },
    side_panel: { default_path: 'sidepanel.html' },
    background: { service_worker: 'background.js', type: 'module' },
    permissions: ['sidePanel', 'storage', 'tabs', 'scripting'],
    optional_host_permissions: ['http://*/*', 'https://*/*'],
  };
}
