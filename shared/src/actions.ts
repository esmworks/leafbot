import { DEFAULT_LOCALE, type Locale } from './i18n';
import { describeSchedule, Schedule } from './schedule';

/** A routine's schedule as the card says it, when the input holds a valid one. */
function scheduleText(raw: unknown, locale: Locale): string | null {
  const parsed = Schedule.safeParse(raw);
  return parsed.success ? describeSchedule(parsed.data, locale) : null;
}

/** The model a routine's runs are given on the card; an empty one goes back to the bot's own. */
function modelText(raw: unknown, locale: Locale): string | null {
  if (typeof raw !== 'string') return null;
  const own = locale === 'tr' ? 'botun kendi modeli' : "the bot's own model";
  return `model: ${raw.trim() || own}`;
}

/** A routine's check as the card shows it: the bot runs only when that tool's answer changes. */
function checkText(raw: unknown, locale: Locale): string | null {
  if (typeof raw !== 'string') return null;
  const tool = raw.trim();
  if (!tool) return locale === 'tr' ? 'denetim kaldırılır' : 'the check is removed';
  return locale === 'tr'
    ? `yalnız ${tool} yeni bir cevap verince`
    : `only when ${tool} answers something new`;
}

/**
 * A routine's steps as the card shows them, one line each, so the person sees every step the
 * routine will take, which model each runs on and where it waits for them. An empty list removes them.
 */
function stepsText(raw: unknown, locale: Locale): string | null {
  if (!Array.isArray(raw)) return null;
  const tr = locale === 'tr';
  if (!raw.length) return tr ? 'adımlar kaldırılır' : 'the steps are removed';
  const line = (x: Record<string, unknown>, i: number) => {
    const n = `${i + 1}.`;
    const model = str(x.model) ? ` [${str(x.model)}]` : '';
    switch (x.kind) {
      case 'agent':
        return `${n} bot${model}: ${cut(str(x.prompt) ?? '')}`;
      case 'approval':
        return `${n} ${tr ? 'sana sorar' : 'asks you'}: ${cut(str(x.question) ?? '')}`;
      case 'notify':
        return `${n} ${tr ? 'bildirir' : 'tells'}: ${cut(str(x.text) ?? '')}`;
      case 'wait':
        return x.on === 'webhook' || x.on === 'email'
          ? `${n} ${tr ? 'bekler' : 'waits for'} ${x.on}${str(x.filter) ? ` (${cut(str(x.filter)!)})` : ''}`
          : `${n} ${tr ? 'bekler' : 'waits'} ${typeof x.minutes === 'number' ? x.minutes : 60} ${tr ? 'dk' : 'min'}`;
      default:
        return `${n} ${String(x.kind)}`;
    }
  };
  const head = tr ? 'Adımlar:' : 'Steps:';
  return [
    head,
    ...raw.map((x, i) => line(x && typeof x === 'object' ? (x as Record<string, unknown>) : {}, i)),
  ].join('\n');
}
/**
 * A routine's condition as the card shows it: what is looked at with no AI before each scheduled
 * run, when it is looked at again, and the note sent when it is not met.
 */
function conditionText(raw: unknown, locale: Locale): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const tr = locale === 'tr';
  const checks = Array.isArray(c.checks) ? (c.checks as Record<string, unknown>[]) : [];
  if (!checks.length) return tr ? 'koşul kaldırılır' : 'the condition is removed';
  const one = (x: Record<string, unknown>) => {
    const no = x.absent === true ? (tr ? 'yok: ' : 'none: ') : '';
    const what =
      x.kind === 'files'
        ? `${str(x.pattern) ?? ''}${typeof x.min === 'number' && x.min > 1 ? ` ×${x.min}` : ''}`
        : x.kind === 'page'
          ? `${str(x.url) ?? ''} "${str(x.contains) ?? ''}"`
          : x.kind === 'tool'
            ? `${str(x.tool) ?? ''} ${str(x.filter) ?? str(x.contains) ?? ''}`.trim()
            : x.kind === 'table'
              ? `${str(x.table) ?? ''} ${str(x.filter) ?? ''}`.trim()
              : (str(x.filter) ?? '*');
    return `${no}${String(x.kind)} ${cut(what.replace(/\n/g, ', '))}`;
  };
  const lines = [`${tr ? 'Koşul (yapay zekâsız)' : 'Condition (no AI)'}: ${checks.map(one).join(' + ')}`];
  if (typeof c.recheck_minutes === 'number' && c.recheck_minutes > 0 && str(c.recheck_until))
    lines.push(
      tr
        ? `tutmazsa ${c.recheck_minutes} dk'da bir ${str(c.recheck_until)}'e kadar yeniden bakar`
        : `if not met, looks again every ${c.recheck_minutes} min until ${str(c.recheck_until)}`,
    );
  if (str(c.otherwise))
    lines.push(`${tr ? 'tutmazsa yazar' : 'if not met, writes'}: ${cut(str(c.otherwise)!)}`);
  return lines.join('\n');
}
const cut = (v: string) => (v.length > 200 ? `${v.slice(0, 199)}…` : v);

/**
 * Plain-language wording for a tool a bot wants to use, for approval cards and the one-line
 * note left after the answer. No tool names or arguments: those stay behind the detail toggle.
 * Every field is a whole sentence naming the bot, because word order differs by language.
 */
export interface ActionText {
  /** "Katip bilgisayarda bir komut çalıştırmak istiyor." / "Katip wants to run a command on the computer." */
  want: string;
  /** "Katip bu seferlik …" / "Katip can … this time" */
  once: string;
  /** "Katip artık sormadan …" / "Katip can now … without asking" */
  always: string;
  /** "Katip bu komutu çalıştırmayacak" / "Katip won't run this command" */
  wont: string;
  /** What exactly: the command, file or address. Shown only when asked for. */
  detail: string | null;
  /** The step alone, for a list of what was done: "Bilgisayarda bir komut çalıştırmak" / "Run a command on the computer". */
  step: string;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const fileName = (p: string | null) => (p ? (p.split('/').filter(Boolean).at(-1) ?? p) : null);
const host = (u: string | null) => {
  if (!u) return null;
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

/** Turkish verb forms: infinitive, "can", "will not". */
type Verb = [string, string, string];
const RUN: Verb = ['çalıştırmak', 'çalıştırabilir', 'çalıştırmayacak'];
const WRITE: Verb = ['yazmak', 'yazabilir', 'yazmayacak'];
const CHANGE: Verb = ['değiştirmek', 'değiştirebilir', 'değiştirmeyecek'];
const OPEN: Verb = ['açmak', 'açabilir', 'açmayacak'];
const DO: Verb = ['yapmak', 'yapabilir', 'yapmayacak'];
const SAVE: Verb = ['kaydetmek', 'kaydedebilir', 'kaydetmeyecek'];
const SET_UP: Verb = ['kurmak', 'kurabilir', 'kurmayacak'];
const ARCHIVE: Verb = ['arşivlemek', 'arşivleyebilir', 'arşivlemeyecek'];
const SEND: Verb = ['göndermek', 'gönderebilir', 'göndermeyecek'];
const STOP: Verb = ['durdurmak', 'durdurabilir', 'durdurmayacak'];
const USE: Verb = ['kullanmak', 'kullanabilir', 'kullanmayacak'];
const READ: Verb = ['okumak', 'okuyabilir', 'okumayacak'];
const UPLOAD: Verb = ['yüklemek', 'yükleyebilir', 'yüklemeyecek'];
const TURN_OFF: Verb = ['kapatmak', 'kapatabilir', 'kapatmayacak'];
const DELETE: Verb = ['silmek', 'silebilir', 'silmeyecek'];
const CREATE: Verb = ['oluşturmak', 'oluşturabilir', 'oluşturmayacak'];
const TRANSCRIBE: Verb = ['yazıya dökmek', 'yazıya dökebilir', 'yazıya dökmeyecek'];

/**
 * The start of the names of the tools that use the person's own Mac: the screen, the mouse and the
 * keyboard. They ask once in a turn at every level (see the turn's permission check).
 */
export const PERSON_COMPUTER = 'person_computer_';
/** The name prefix of the tools that read the person's own phone. */
export const PERSON_PHONE = 'person_phone_';

/** One action in both languages, before the bot's name is put in. */
interface Phrase {
  /** Turkish object before the verb, as first asked ("bir komut") and once known ("komut"). */
  tr: [object: string, sameObject: string, verb: Verb];
  /** English verb phrases: as first asked, once known ("run this command"), in general. */
  en: [want: string, same: string, general?: string];
}

function phraseFor(name: string, input: Record<string, unknown>): Phrase {
  const file = fileName(str(input.file_path) ?? str(input.path) ?? str(input.notebook_path));
  const trFile = file ? `"${file}" dosyasını` : null;
  const bot = str(input.bot) ?? str(input.name);
  if (name.startsWith(PERSON_COMPUTER)) {
    return { tr: ["Mac'ini", "Mac'ini", USE], en: ['use your Mac', 'use your Mac'] };
  }
  if (name === `${PERSON_PHONE}calendar`) {
    return {
      tr: ['telefonundaki takvimi', 'telefonundaki takvimi', READ],
      en: ['read your phone’s calendar', 'read your phone’s calendar'],
    };
  }
  if (name === `${PERSON_PHONE}contacts`) {
    return {
      tr: ['telefonundaki rehberi', 'telefonundaki rehberi', READ],
      en: ['search your phone’s contacts', 'search your phone’s contacts'],
    };
  }
  if (name === `${PERSON_PHONE}location`) {
    return {
      tr: ['telefonunun konumunu', 'telefonunun konumunu', READ],
      en: ['see where your phone is', 'see where your phone is'],
    };
  }
  if (name === 'call_listen') {
    return {
      tr: ['tarayıcısında açık görüşmeyi', 'bu görüşmeyi', TRANSCRIBE],
      en: ['transcribe the call open in its browser', 'transcribe this call'],
    };
  }
  switch (name) {
    case 'Bash':
      return {
        tr: ['bilgisayarda bir komut', 'bilgisayarda komut', RUN],
        en: ['run a command on the computer', 'run this command', 'run commands on the computer'],
      };
    case 'Write':
      return {
        tr: [trFile ?? 'bir dosyayı', trFile ?? 'bu dosyayı', WRITE],
        en: file
          ? [`write "${file}"`, `write "${file}"`]
          : ['write a file', 'write this file', 'write files'],
      };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return {
        tr: [trFile ?? 'bir dosyayı', trFile ?? 'bu dosyayı', CHANGE],
        en: file
          ? [`change "${file}"`, `change "${file}"`]
          : ['change a file', 'change this file', 'change files'],
      };
    case 'WebFetch': {
      const h = host(str(input.url));
      return {
        tr: [h ? `${h} sayfasını` : 'bir web sayfasını', h ? `${h} sayfasını` : 'bu sayfayı', OPEN],
        en: h ? [`open ${h}`, `open ${h}`] : ['open a web page', 'open this page', 'open web pages'],
      };
    }
    case 'WebSearch':
      return { tr: ['internette arama', 'internette arama', DO], en: ['search the web', 'search the web'] };
    case 'browser_open':
    case 'browser_tabs': {
      const h = host(str(input.url));
      return {
        tr: [
          h ? `tarayıcıda ${h} sitesini` : 'tarayıcıda bir siteyi',
          h ? `tarayıcıda ${h} sitesini` : 'tarayıcıda siteleri',
          OPEN,
        ],
        en: h
          ? [`open ${h} in the browser`, `open ${h}`, 'open sites in the browser']
          : ['open a site in the browser', 'open this site', 'open sites in the browser'],
      };
    }
    case 'browser_click':
    case 'browser_drag':
    case 'browser_type':
    case 'browser_press':
    case 'browser_dialog': {
      const what = str(input.element) ?? str(input.question);
      return {
        tr: [what ? `tarayıcıda "${what}" ile bir şey` : 'tarayıcıda bir şey', 'tarayıcıda bir şey', SEND],
        en: what
          ? [
              `send something with "${what}" in the browser`,
              `send this with "${what}"`,
              'send things in the browser',
            ]
          : ['send something in the browser', 'send this', 'send things in the browser'],
      };
    }
    case 'browser_upload': {
      const names = Array.isArray(input.paths)
        ? input.paths.map((p) => fileName(str(p))).filter(Boolean)
        : [];
      const one = names.length === 1 ? names[0] : null;
      return {
        tr: [
          one ? `"${one}" dosyasını tarayıcıdaki siteye` : 'dosyaları tarayıcıdaki siteye',
          one ? `"${one}" dosyasını` : 'bu dosyaları',
          UPLOAD,
        ],
        en: one
          ? [`upload "${one}" to a site in the browser`, `upload "${one}"`, 'upload files to sites']
          : ['upload files to a site in the browser', 'upload these files', 'upload files to sites'],
      };
    }
    case 'Task':
    case 'Agent':
      return {
        tr: ['yardımcı bir ajan', 'yardımcı ajan', RUN],
        en: ['run a helper agent', 'run the helper agent', 'run helper agents'],
      };
    case 'KillShell':
    case 'KillBash':
      return {
        tr: ['çalışan bir komutu', 'bu komutu', STOP],
        en: ['stop a running command', 'stop this command', 'stop running commands'],
      };
    case 'api_call': {
      const api = str(input.api);
      const op = str(input.operation);
      return {
        tr: [
          api ? `"${api}" API’sinde bir işlem` : 'bir API işlemi',
          op ? `"${op}" işlemini` : 'bu işlemi',
          DO,
        ],
        en: [
          api ? `call an operation of the "${api}" API` : 'call an API operation',
          op ? `call "${op}"` : 'call this operation',
          'call API operations',
        ],
      };
    }
    case 'api_request': {
      const key = str(input.key);
      return {
        tr: [key ? `"${key}" anahtarıyla bir API isteği` : 'bir API isteği', 'bu API isteğini', SEND],
        en: key
          ? [`send an API request with the "${key}" key`, 'send this API request', 'send API requests']
          : ['send an API request', 'send this API request', 'send API requests'],
      };
    }
    case 'image_create':
      return {
        tr: ['bir resim', 'bu resmi', CREATE],
        en: ['create a picture', 'create this picture', 'create pictures'],
      };
    case 'video_create':
      return {
        tr: ['bir video', 'bu videoyu', CREATE],
        en: ['create a video', 'create this video', 'create videos'],
      };
    case 'memory_write':
      return {
        tr: ['bir bilgiyi hafızaya', 'bu bilgiyi hafızaya', SAVE],
        en: ['save something to memory', 'save this to memory', 'save things to memory'],
      };
    case 'memory_update':
      return {
        tr: ['hafızadaki bir notu', 'hafızadaki bu notu', CHANGE],
        en: ['change a note in memory', 'change this note in memory', 'change notes in memory'],
      };
    case 'memory_forget':
      return {
        tr: ['hafızadaki bir notu', 'hafızadaki bu notu', DELETE],
        en: ['delete a note from memory', 'delete this note from memory', 'delete notes from memory'],
      };
    case 'bot_create':
      return {
        tr: [
          bot ? `"${bot}" adında yeni bir bot` : 'yeni bir bot',
          bot ? `"${bot}" botunu` : 'yeni botu',
          SET_UP,
        ],
        en: bot
          ? [`set up a new bot named "${bot}"`, `set up "${bot}"`, 'set up new bots']
          : ['set up a new bot', 'set up the new bot', 'set up new bots'],
      };
    case 'bot_update':
      return {
        tr: [
          bot ? `"${bot}" botunun ayarlarını` : 'bir botun ayarlarını',
          bot ? `"${bot}" botunun ayarlarını` : 'bu ayarları',
          CHANGE,
        ],
        en: bot
          ? [`change the settings of "${bot}"`, `change the settings of "${bot}"`]
          : ["change a bot's settings", 'change these settings', "change bots' settings"],
      };
    case 'skill_save':
      return {
        tr: [bot ? `"${bot}" becerisini` : 'bir beceriyi', bot ? `"${bot}" becerisini` : 'bu beceriyi', SAVE],
        en: bot
          ? [`save the skill "${bot}"`, `save the skill "${bot}"`, 'save skills']
          : ['save a skill', 'save this skill', 'save skills'],
      };
    case 'app_add':
      return {
        tr: [
          bot ? `"${bot}" adında yeni bir bağlantı` : 'yeni bir bağlantı',
          bot ? `"${bot}" bağlantısını` : 'bu bağlantıyı',
          SET_UP,
        ],
        en: bot
          ? [`connect a new server named "${bot}"`, `connect "${bot}"`, 'connect new servers']
          : ['connect a new server', 'connect this server', 'connect new servers'],
      };
    case 'routine_create': {
      // `bot` names the bot a manager sets it up for, so the routine's own name is read apart.
      const routine = str(input.name);
      const owner = str(input.bot);
      const trOwner = owner ? `"${owner}" botuna ` : '';
      const enOwner = owner ? ` for "${owner}"` : '';
      return {
        tr: [
          routine ? `${trOwner}"${routine}" adında bir rutin` : `${trOwner}bir rutin`,
          routine ? `${trOwner}"${routine}" rutinini` : `${trOwner}bu rutini`,
          SET_UP,
        ],
        en: routine
          ? [
              `set up a routine named "${routine}"${enOwner}`,
              `set up the routine "${routine}"${enOwner}`,
              'set up routines',
            ]
          : [`set up a routine${enOwner}`, `set up this routine${enOwner}`, 'set up routines'],
      };
    }
    case 'routine_update':
    case 'routine_delete':
    case 'routine_run': {
      const routine = str(input.routine);
      const owner = str(input.bot);
      // Turning a routine on or off reads as that; any other change as a change.
      const onOff =
        name === 'routine_update' &&
        typeof input.enabled === 'boolean' &&
        Object.keys(input).every((k) => ['routine', 'bot', 'enabled'].includes(k))
          ? input.enabled
          : null;
      const [verb, en, enAll]: [Verb, string, string] =
        name === 'routine_delete'
          ? [DELETE, 'delete', 'delete routines']
          : name === 'routine_run'
            ? [RUN, 'run', 'run routines']
            : onOff === false
              ? [TURN_OFF, 'turn off', 'turn off routines']
              : onOff === true
                ? [OPEN, 'turn on', 'turn on routines']
                : [CHANGE, 'change', 'change routines'];
      const trOwner = owner ? `"${owner}" botunun ` : '';
      const enOwner = owner ? ` of "${owner}"` : '';
      return {
        tr: [
          routine ? `${trOwner}"${routine}" rutinini` : 'bir rutini',
          routine ? `${trOwner}"${routine}" rutinini` : 'bu rutini',
          verb,
        ],
        en: routine
          ? [`${en} the routine "${routine}"${enOwner}`, `${en} the routine "${routine}"${enOwner}`, enAll]
          : [`${en} a routine`, `${en} this routine`, enAll],
      };
    }
    case 'bot_archive':
      return {
        tr: [bot ? `"${bot}" botunu` : 'bir botu', bot ? `"${bot}" botunu` : 'bu botu', ARCHIVE],
        en: bot
          ? [`archive "${bot}"`, `archive "${bot}"`]
          : ['archive a bot', 'archive this bot', 'archive bots'],
      };
    case 'bot_send':
      return {
        tr: [
          bot ? `"${bot}" botuna bir iş` : 'başka bir bota iş',
          bot ? `"${bot}" botuna iş` : 'bu işi',
          SEND,
        ],
        en: bot
          ? [`send a task to "${bot}"`, `send the task to "${bot}"`, `send tasks to "${bot}"`]
          : ['send a task to another bot', 'send this task', 'send tasks to other bots'],
      };
    default:
      return { tr: ['bir araç', 'bu aracı', USE], en: ['use a tool', 'use this tool', 'use tools'] };
  }
}

function detailFor(name: string, input: Record<string, unknown>, locale: Locale): string | null {
  if (name === `${PERSON_COMPUTER}type`) return str(input.text);
  if (name === `${PERSON_COMPUTER}key`) return str(input.keys);
  if (name === `${PERSON_PHONE}contacts`) return str(input.query);
  // The card says where the voices go, since the people in the call are not the ones asked.
  if (name === 'call_listen')
    return locale === 'tr'
      ? 'Görüşmedeki herkesin sesi yazıya dökülmek üzere konuşmayı yazıya çeviren servise gider; ses saklanmaz, yazısı sohbet klasörüne kaydedilir. Görüşmedekilere kaydedildiklerini söyle.'
      : 'Everyone’s voice in the call goes to the speech-to-text service to be written out; no audio is kept, the text is saved in the conversation’s folder. Tell the people in the call they are being transcribed.';
  switch (name) {
    case 'Bash':
      return str(input.command);
    case 'Write':
      return str(input.file_path) ?? str(input.path);
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return str(input.file_path) ?? str(input.notebook_path);
    case 'WebFetch':
      return str(input.url);
    case 'WebSearch':
      return str(input.query);
    case 'browser_open':
    case 'browser_tabs':
      return str(input.url);
    case 'browser_click':
      return str(input.element);
    case 'browser_type':
      return [str(input.element), str(input.text)].filter(Boolean).join(': ') || null;
    case 'browser_press':
      return str(input.key);
    case 'browser_dialog':
      return str(input.question);
    case 'browser_upload':
      return Array.isArray(input.paths)
        ? input.paths.filter((p) => typeof p === 'string').join('\n') || null
        : null;
    case 'Task':
    case 'Agent':
      return str(input.description);
    case 'memory_write':
    case 'memory_update':
      return str(input.content);
    case 'memory_flag':
      return str(input.about);
    case 'image_create':
    case 'video_create':
      return str(input.prompt);
    case 'api_call':
      return (
        [
          [str(input.api), str(input.operation)].filter(Boolean).join(' · '),
          input.params ? JSON.stringify(input.params, null, 2) : '',
          input.body != null
            ? typeof input.body === 'string'
              ? input.body
              : JSON.stringify(input.body, null, 2)
            : '',
        ]
          .filter(Boolean)
          .join('\n\n') || null
      );
    case 'api_request': {
      const line = [str(input.method)?.toUpperCase() ?? 'GET', str(input.url)].filter(Boolean).join(' ');
      const body =
        typeof input.body === 'string'
          ? input.body
          : input.body != null
            ? JSON.stringify(input.body, null, 2)
            : '';
      return [line, body].filter(Boolean).join('\n\n') || null;
    }
    case 'bot_create':
      return str(input.description);
    case 'bot_send':
      return str(input.text) ?? str(input.message);
    case 'app_add':
      return str(input.url);
    case 'skill_save':
      return [str(input.description), str(input.body)].filter(Boolean).join('\n\n') || null;
    case 'routine_create': {
      const when = scheduleText(input.schedule, locale);
      const model = str(input.model) && modelText(input.model, locale);
      return (
        [
          when,
          model,
          checkText(input.check_tool, locale),
          str(input.prompt),
          conditionText(input.condition, locale),
          stepsText(input.steps, locale),
        ]
          .filter(Boolean)
          .join('\n') || null
      );
    }
    case 'routine_update': {
      const rename = str(input.name);
      const when = scheduleText(input.schedule, locale);
      const model = modelText(input.model, locale);
      const check = checkText(input.check_tool, locale);
      return (
        [
          rename && `→ ${rename}`,
          when,
          model,
          check,
          str(input.prompt),
          conditionText(input.condition, locale),
          stepsText(input.steps, locale),
        ]
          .filter(Boolean)
          .join('\n') || null
      );
    }
    default:
      return null;
  }
}

/** A connection's tool (`mcp__<connection>__<tool>`): the connection's part and the tool's. */
export function connectionToolParts(toolName: string): { server: string; tool: string } | null {
  const m = /^mcp__([a-z0-9_]+?)__(.+)$/.exec(toolName);
  if (!m || m[1] === 'leafbot') return null;
  return { server: m[1]!, tool: m[2]! };
}

/**
 * "Always allow" covers one tool of a connection, not the whole service, so the card names the
 * tool: otherwise two different tools of the same service read as the same request.
 */
function connectionPhrase(service: string, tool: string): Phrase {
  return {
    tr: [`“${tool}” adlı bir ${service} aracı`, `“${tool}” adlı ${service} aracını`, USE],
    en: [`use the ${service} tool “${tool}”`, `use the ${service} tool “${tool}”`],
  };
}

export function describeAction(
  toolName: string,
  input: Record<string, unknown>,
  opts: {
    bot: string;
    locale?: Locale;
    /** The connection's name, for a connection's tool. */
    service?: string;
  },
): ActionText {
  // Action sentences are written in Turkish and English; other languages read the English ones.
  const lang: Locale = (opts.locale ?? DEFAULT_LOCALE) === 'tr' ? 'tr' : 'en';
  const name = toolName.startsWith('mcp__leafbot__') ? toolName.slice('mcp__leafbot__'.length) : toolName;
  // Only a known connection's tool is named by its service; any other stays a plain "tool".
  const remote = opts.service ? connectionToolParts(toolName) : null;
  const phrase =
    remote && opts.service ? connectionPhrase(opts.service, remote.tool) : phraseFor(name, input);
  const shown = JSON.stringify(input);
  // The tool is named in the sentence already; the detail shows what it is sent.
  const detail = remote
    ? shown && shown !== '{}'
      ? shown.length > 600
        ? `${shown.slice(0, 599)}…`
        : shown
      : null
    : detailFor(name, input, lang);
  const { bot } = opts;
  if (lang === 'en') {
    const [want, same, general = same] = phrase.en;
    return {
      want: `${bot} wants to ${want}.`,
      once: `${bot} can ${same} this time`,
      always: `${bot} can now ${general} without asking`,
      wont: `${bot} won't ${same}`,
      detail,
      step: upperFirst(want, 'en'),
    };
  }
  const [object, sameObject, [inf, can, wont]] = phrase.tr;
  return {
    want: `${bot} ${object} ${inf} istiyor.`,
    once: `${bot} bu seferlik ${sameObject} ${can}`,
    always: `${bot} artık sormadan ${sameObject} ${can}`,
    wont: `${bot} ${sameObject} ${wont}`,
    detail,
    step: upperFirst(`${object} ${inf}`, 'tr'),
  };
}

const upperFirst = (s: string, locale: Locale) =>
  s.charAt(0).toLocaleUpperCase(locale === 'tr' ? 'tr-TR' : 'en-US') + s.slice(1);

export interface QuestionItem {
  question: string;
  /** A line under the question: why it is asked, or what the options mean. */
  context?: string;
  options: string[];
  /** Its answer goes to the waiting bot only: the card keeps it blank (see `hideSecretAnswers`). */
  secret: boolean;
  /** Several options may be picked: the answer lists them all (see `joinPicks`). */
  multi: boolean;
}

/** Between the picked options of a multiple-choice answer; options rarely hold a semicolon, unlike a comma. */
const PICK_SEPARATOR = '; ';

/** The answer to a multiple-choice question: every pick, then any words the person added. */
export function joinPicks(picks: readonly string[]): string {
  return picks
    .map((p) => p.trim())
    .filter(Boolean)
    .join(PICK_SEPARATOR);
}

/** The picks and written words of an answer made with `joinPicks`. */
export function splitPicks(answer: string): string[] {
  return answer
    .split(PICK_SEPARATOR.trim())
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * What a chat app's reply to a multiple-choice question means: option numbers ("1, 3" or "1 3") become
 * the options they name; anything else is the person's own words and stays as written.
 */
export function typedPicks(options: readonly string[], text: string): string {
  const numbers = text.trim().match(/^\d+(?:[\s,;]+\d+)*$/);
  if (!numbers) return text;
  const picked = [...new Set(text.match(/\d+/g)!.map(Number))].map((n) => options[n - 1]);
  return picked.every((o): o is string => o !== undefined) ? joinPicks(picked) : text;
}

/** The questions on a question card: several from `ask_user`, or one from the card itself. */
export function questionItems(a: { input: Record<string, unknown>; summary: string; options: string[] }): {
  title: string | null;
  items: QuestionItem[];
} {
  const title = typeof a.input.title === 'string' && a.input.title.trim() ? a.input.title.trim() : null;
  const raw = Array.isArray(a.input.questions) ? a.input.questions : null;
  const items = (raw ?? [])
    .map(
      (q) =>
        q as { question?: unknown; context?: unknown; options?: unknown; secret?: unknown; multi?: unknown },
    )
    .filter((q) => typeof q.question === 'string' && q.question.trim())
    .map((q) => ({
      question: String(q.question),
      ...(typeof q.context === 'string' && q.context.trim() ? { context: q.context.trim() } : {}),
      options: Array.isArray(q.options) ? q.options.filter((o): o is string => typeof o === 'string') : [],
      secret: q.secret === true,
      // A secret answer is one typed value, and a question with no options has nothing to tick.
      multi: q.multi === true && q.secret !== true && Array.isArray(q.options) && q.options.length > 0,
    }));
  return items.length
    ? { title, items }
    : { title, items: [{ question: a.summary, options: a.options, secret: false, multi: false }] };
}

/**
 * The answer as the card keeps it: secret answers left blank. Written the same way as the answer
 * itself, a JSON list when there are several questions.
 */
export function hideSecretAnswers(items: readonly QuestionItem[], answers: readonly string[]): string | null {
  const kept = items.map((q, i) => (q.secret ? '' : (answers[i] ?? '')));
  if (items.length > 1) return JSON.stringify(kept);
  return kept[0] || null;
}

/** Answers kept on a card: one per question (stored as a JSON list when there are several). */
export function parseAnswers(answer: string | null, count: number): string[] {
  if (answer === null) return [];
  if (count > 1) {
    try {
      const list = JSON.parse(answer) as unknown;
      if (Array.isArray(list)) return list.map((x) => (typeof x === 'string' ? x : ''));
    } catch {
      // A single free-text answer.
    }
  }
  return [answer];
}
