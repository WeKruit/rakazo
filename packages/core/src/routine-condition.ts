/**
 * A routine's optional condition: a small CEL-like expression over the trigger, checked before
 * any model is woken. Example: `event.action == "opened" && !event.pull_request.draft`.
 *
 * Supports `&&`, `||`, `!`, parentheses, `== != < <= > >=`, `in` (list or substring), `contains`,
 * `startsWith`, `endsWith`, `matches` (case-insensitive regular expression), string, number,
 * boolean and null literals, `[a, b]` lists, and dotted or `["key"]` paths into the variables.
 * Missing paths are null; nothing can call functions or change state.
 */
export type RoutineConditionResult = { ok: true; value: boolean } | { ok: false; error: string };

type Token =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "name"; value: string }
  | { kind: "op"; value: string };

const MAX_CONDITION_LENGTH = 2_000;
const OPERATORS = ["&&", "||", "==", "!=", "<=", ">=", "<", ">", "!", "(", ")", "[", "]", ",", "."];
const WORD_OPERATORS = new Set(["in", "contains", "startsWith", "endsWith", "matches"]);

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if (char === '"' || char === "'") {
      let value = "";
      index++;
      while (index < source.length && source[index] !== char) {
        if (source[index] === "\\" && index + 1 < source.length) index++;
        value += source[index];
        index++;
      }
      if (source[index] !== char) throw new Error("Unclosed string");
      index++;
      tokens.push({ kind: "string", value });
      continue;
    }
    const number = /^-?\d+(\.\d+)?/.exec(source.slice(index));
    if (number && (char !== "-" || tokens.at(-1)?.kind === "op")) {
      tokens.push({ kind: "number", value: Number(number[0]) });
      index += number[0].length;
      continue;
    }
    const name = /^[A-Za-z_][\w-]*/.exec(source.slice(index));
    if (name) {
      tokens.push({ kind: "name", value: name[0] });
      index += name[0].length;
      continue;
    }
    const op = OPERATORS.find((candidate) => source.startsWith(candidate, index));
    if (!op) throw new Error(`Unexpected "${char}"`);
    tokens.push({ kind: "op", value: op });
    index += op.length;
  }
  return tokens;
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  return JSON.stringify(a) === JSON.stringify(b);
}

class Parser {
  private index = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly variables: Record<string, unknown>,
  ) {}

  parse(): unknown {
    const value = this.or();
    if (this.index < this.tokens.length) throw new Error("Unexpected text after the condition");
    return value;
  }

  private peek(value: string): boolean {
    const token = this.tokens[this.index];
    return (token?.kind === "op" || token?.kind === "name") && token.value === value;
  }

  private take(value: string): boolean {
    if (!this.peek(value)) return false;
    this.index++;
    return true;
  }

  private expect(value: string) {
    if (!this.take(value)) throw new Error(`Expected "${value}"`);
  }

  private or(): unknown {
    let left = this.and();
    while (this.take("||")) {
      const right = this.and();
      left = truthy(left) || truthy(right);
    }
    return left;
  }

  private and(): unknown {
    let left = this.not();
    while (this.take("&&")) {
      const right = this.not();
      left = truthy(left) && truthy(right);
    }
    return left;
  }

  private not(): unknown {
    if (this.take("!")) return !truthy(this.not());
    return this.comparison();
  }

  private comparison(): unknown {
    const left = this.primary();
    const token = this.tokens[this.index];
    if (!token || (token.kind !== "op" && token.kind !== "name")) return left;
    const op = token.value;
    if (!["==", "!=", "<", "<=", ">", ">="].includes(op) && !WORD_OPERATORS.has(op)) return left;
    this.index++;
    const right = this.primary();
    switch (op) {
      case "==":
        return equal(left, right);
      case "!=":
        return !equal(left, right);
      case "<":
        return Number(left) < Number(right);
      case "<=":
        return Number(left) <= Number(right);
      case ">":
        return Number(left) > Number(right);
      case ">=":
        return Number(left) >= Number(right);
      case "in":
        return Array.isArray(right)
          ? right.some((item) => equal(item, left))
          : typeof right === "string" && right.includes(String(left ?? ""));
      case "contains":
        return Array.isArray(left)
          ? left.some((item) => equal(item, right))
          : typeof left === "string" &&
              left.toLowerCase().includes(String(right ?? "").toLowerCase());
      case "startsWith":
        return typeof left === "string" && left.startsWith(String(right ?? ""));
      case "endsWith":
        return typeof left === "string" && left.endsWith(String(right ?? ""));
      default: {
        const pattern = String(right ?? "");
        if (pattern.length > 200) throw new Error("Pattern is too long");
        return typeof left === "string" && new RegExp(pattern, "i").test(left);
      }
    }
  }

  private primary(): unknown {
    const token = this.tokens[this.index];
    if (!token) throw new Error("Condition ends too early");
    if (token.kind === "string" || token.kind === "number") {
      this.index++;
      return token.value;
    }
    if (this.take("(")) {
      const value = this.or();
      this.expect(")");
      return value;
    }
    if (this.take("[")) {
      const items: unknown[] = [];
      if (!this.take("]")) {
        do items.push(this.or());
        while (this.take(","));
        this.expect("]");
      }
      return items;
    }
    if (token.kind !== "name") throw new Error(`Unexpected "${token.value}"`);
    this.index++;
    if (token.value === "true") return true;
    if (token.value === "false") return false;
    if (token.value === "null") return null;
    let value: unknown = Object.hasOwn(this.variables, token.value)
      ? this.variables[token.value]
      : null;
    while (this.peek(".") || this.peek("[")) {
      let key: unknown;
      if (this.take(".")) {
        const next = this.tokens[this.index];
        if (next?.kind !== "name") throw new Error("Expected a field name after .");
        this.index++;
        key = next.value;
      } else {
        this.expect("[");
        key = this.or();
        this.expect("]");
      }
      value =
        value && typeof value === "object" && Object.hasOwn(value, String(key))
          ? (value as Record<string, unknown>)[String(key)]
          : null;
    }
    return value;
  }
}

export function evaluateRoutineCondition(
  condition: string,
  variables: Record<string, unknown>,
): RoutineConditionResult {
  if (condition.length > MAX_CONDITION_LENGTH) return { ok: false, error: "Condition is too long" };
  try {
    return { ok: true, value: truthy(new Parser(tokenize(condition), variables).parse()) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Invalid condition" };
  }
}

/** Syntax check for saving: undefined when valid, otherwise the reason. */
export function routineConditionError(condition: string): string | undefined {
  const result = evaluateRoutineCondition(condition, {});
  return result.ok ? undefined : result.error;
}

/** The schedule's own variables: the local hour, weekday (0 = Sunday) and date. */
export function scheduleConditionVariables(now: Date, timeZone: string): Record<string, unknown> {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
  } catch {
    return scheduleConditionVariables(now, "UTC");
  }
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    source: "schedule",
    now: {
      hour: Number(part("hour")),
      weekday: weekdays.indexOf(part("weekday")),
      date: `${part("year")}-${part("month")}-${part("day")}`,
    },
  };
}
