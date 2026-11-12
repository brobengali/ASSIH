import * as chrono from 'chrono-node';

export interface ResolvedDate {
  expression: string;
  isoDate: string; // YYYY-MM-DD
  fullIso: string;
  weekday: string; // e.g. "Mon", "Tue"
  isRelativeWeekday: boolean;
  alternativeIsoDate?: string; // e.g. previous week's Tuesday if ambiguous
  assumption?: string;
}

export interface DateResolutionResult {
  nowIso: string;
  nowFormatted: string;
  timezone: string;
  weekday: string;
  resolved: ResolvedDate[];
  promptBlock: string;
}

/**
 * Format a Date to YYYY-MM-DD in a specific timezone
 */
export function formatYMD(date: Date, timezone: string = 'UTC'): string {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return formatter.format(date);
  } catch {
    return date.toISOString().split('T')[0];
  }
}

/**
 * Format weekday in timezone
 */
export function formatWeekday(date: Date, timezone: string = 'UTC'): string {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
    });
    return formatter.format(date);
  } catch {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return days[date.getUTCDay()];
  }
}

/**
 * Deterministic date resolver using chrono-node and explicit relative ambiguity rules.
 * Enforces:
 * 1. Weekday expressions ("Monday", "last Tuesday") always resolve backwards to the past.
 * 2. Unambiguous ISO date output: YYYY-MM-DD with day-of-week.
 * 3. Ambiguity handling: states assumption explicitly (e.g., most recent past Tuesday vs Tuesday of last week).
 * 4. Anaphora: handles "since then" using priorTurnDate if present.
 */
export function resolveDates(
  userMessage: string,
  now: Date = new Date(),
  timezone: string = 'UTC',
  priorTurnDate?: string
): DateResolutionResult {
  const safeTz = timezone || 'UTC';
  const nowIso = now.toISOString();
  const todayYMD = formatYMD(now, safeTz);
  const currentWeekday = formatWeekday(now, safeTz);

  const resolved: ResolvedDate[] = [];
  const seenDates = new Set<string>();

  // 1. Chrono parsing with forwardDate = false to guarantee relative references point to past
  const parsedResults = chrono.parse(
    userMessage,
    { instant: now },
    { forwardDate: false }
  );

  for (const result of parsedResults) {
    const parsedDate = result.start.date();
    const isoDate = formatYMD(parsedDate, safeTz);
    const weekday = formatWeekday(parsedDate, safeTz);
    const expr = result.text.trim();

    // Check if this is a relative weekday expression
    const isWeekdayMention = /\b(mon(day)?|tue(s|sday)?|wed(nesday)?|thu(r|rs|rsday)?|fri(day)?|sat(urday)?|sun(day)?)\b/i.test(expr);
    const isLastModifier = /\blast\b/i.test(expr);

    let assumption: string | undefined;
    let alternativeIsoDate: string | undefined;

    if (isWeekdayMention) {
      if (isLastModifier) {
        // "Last Tuesday": can be most recent past Tuesday, or Tuesday of the previous calendar week.
        const prevWeekDate = new Date(parsedDate.getTime() - 7 * 24 * 60 * 60 * 1000);
        alternativeIsoDate = formatYMD(prevWeekDate, safeTz);
        assumption = `Resolved to most recent past ${weekday} (${isoDate}). Alternative if referring to previous calendar week: ${alternativeIsoDate}.`;
      } else {
        assumption = `Resolved to most recent past ${weekday} (${isoDate}).`;
      }
    }

    if (!seenDates.has(`${expr}->${isoDate}`)) {
      seenDates.add(`${expr}->${isoDate}`);
      resolved.push({
        expression: expr,
        isoDate,
        fullIso: parsedDate.toISOString(),
        weekday,
        isRelativeWeekday: isWeekdayMention,
        alternativeIsoDate,
        assumption,
      });
    }
  }

  // 2. Anaphora resolution: "since then" / "since that time" / "since our last chat"
  if (/\b(since then|since that|since our last|since that time)\b/i.test(userMessage) && priorTurnDate) {
    const prior = new Date(priorTurnDate);
    const priorYMD = formatYMD(prior, safeTz);
    const priorWeekday = formatWeekday(prior, safeTz);
    resolved.push({
      expression: 'since then',
      isoDate: priorYMD,
      fullIso: prior.toISOString(),
      weekday: priorWeekday,
      isRelativeWeekday: false,
      assumption: `Resolved "since then" to timestamp of previous referenced turn (${priorYMD}).`,
    });
  }

  // Build the prompt block
  let promptBlock = '';
  if (resolved.length > 0) {
    promptBlock = [
      '### Resolved Dates (deterministic, extracted from user query)',
      ...resolved.map(r => {
        let line = `- "${r.expression}" => ${r.isoDate} (${r.weekday})`;
        if (r.assumption) {
          line += ` [Assumption: ${r.assumption}]`;
        }
        return line;
      }),
      'Note: If user references a past discussion, use the resolved date(s) above to inspect conversation history.',
    ].join('\n');
  }

  return {
    nowIso,
    nowFormatted: `${todayYMD} (${currentWeekday})`,
    timezone: safeTz,
    weekday: currentWeekday,
    resolved,
    promptBlock,
  };
}

