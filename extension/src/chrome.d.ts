/**
 * The parts of Chrome's extension API this extension uses, typed by hand so the build needs no
 * package from outside the repository. Only what is called is declared.
 */
declare namespace chrome {
  namespace runtime {
    const id: string;
    const lastError: { message?: string } | undefined;
  }

  namespace i18n {
    function getUILanguage(): string;
  }

  namespace storage {
    interface Area {
      get(keys: string | string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    }
    const local: Area;
  }

  namespace permissions {
    interface Permissions {
      origins?: string[];
      permissions?: string[];
    }
    /** Must be called during the person's click, or Chrome refuses. */
    function request(p: Permissions): Promise<boolean>;
    function contains(p: Permissions): Promise<boolean>;
    function remove(p: Permissions): Promise<boolean>;
  }

  namespace tabs {
    interface Tab {
      id?: number;
      windowId: number;
      url?: string;
      title?: string;
      active: boolean;
    }
    interface QueryInfo {
      active?: boolean;
      lastFocusedWindow?: boolean;
    }
    function query(q: QueryInfo): Promise<Tab[]>;
    function get(tabId: number): Promise<Tab>;
    function create(p: { url: string }): Promise<Tab>;
  }

  namespace scripting {
    interface InjectionResult<T> {
      result?: T;
    }
    function executeScript<T>(details: {
      target: { tabId: number };
      func: () => T;
      world?: 'ISOLATED' | 'MAIN';
    }): Promise<InjectionResult<T>[]>;
  }

  namespace sidePanel {
    function setPanelBehavior(behavior: { openPanelOnActionClick: boolean }): Promise<void>;
  }
}
